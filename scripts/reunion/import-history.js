#!/usr/bin/env node
import process from 'node:process'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {readFile, writeFile} from 'node:fs/promises'
import {S3Client, PutObjectCommand, HeadObjectCommand} from '@aws-sdk/client-s3'
import {loadEnv, createTargetPrisma, attestTargetDatabase} from './lib/runtime.js'
import {accessConnectionOptions} from './lib/access-cli.js'
import {HISTORICAL_TRANSFORMER_VERSION} from './lib/history-contract.js'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function uploadVerifiedFile(s3, filename, storageKey, expectedHash, contentType) {
  const bytes = await readFile(filename)
  if (digest(bytes) !== expectedHash) throw new Error('Fichier préparé modifié')
  const params = {Bucket: 'reunion-migration-declarations', Key: storageKey}
  let head
  try { head = await s3.send(new HeadObjectCommand(params)) } catch (error) { if (error.$metadata?.httpStatusCode !== 404) throw error }
  if (head) {
    if (head.Metadata?.sha256 !== expectedHash || Number(head.ContentLength) !== bytes.length) throw new Error('Fichier cible différent')
    return 'unchanged'
  }
  await s3.send(new PutObjectCommand({...params, Body: createReadStream(filename), ContentLength: bytes.length,
    Metadata: {sha256: expectedHash}, ContentType: contentType ?? undefined}))
  return 'created'
}

export async function importHistory({archive, prepared, targetEnv, reportFile, apply = false, sourcePolicy = 'accepted'}) {
  if (sourcePolicy !== 'accepted') throw new Error('Seuls les dossiers DN acceptés peuvent être repris')
  process.umask(0o077)
  const configuration = await loadEnv(targetEnv)
  accessConnectionOptions(configuration, {target: 'local'})
  if (configuration.S3_ENDPOINT !== 'http://127.0.0.1:9002' || configuration.S3_BUCKET_PREFIX !== 'reunion-migration-') throw new Error('Stockage local isolé obligatoire')
  Object.assign(process.env, configuration, {SENTRY_DSN: '', SENTRY_ENV: '', BREVO_API_KEY: '', SMTP_HOST: '127.0.0.1', SMTP_PORT: '1026'})
  const root = path.resolve(archive), preparation = path.resolve(prepared)
  if (!preparation.startsWith(`${root}/`) || !path.resolve(reportFile).startsWith(`${root}/`)) throw new Error('Rapports privés dans archive obligatoire')
  const bytes = await readFile(path.join(preparation, 'manifest.json'))
  if (digest(bytes) !== (await readFile(path.join(preparation, 'manifest.json.sha256'), 'utf8')).trim()) throw new Error('Préparation historique modifiée')
  const manifest = JSON.parse(bytes)
  const dnManifest = JSON.parse(await readFile(path.join(root, 'dn/manifest.json'), 'utf8'))
  let deleted = dnManifest.deletedDossiers
  if (!deleted) {
    const deletionBytes = await readFile(path.join(root, 'dn/deletions.json'))
    if (digest(deletionBytes) !== (await readFile(path.join(root, 'dn/deletions.json.sha256'), 'utf8')).trim()) throw new Error('Inventaire suppressions modifié')
    deleted = JSON.parse(deletionBytes).deleted
  }
  const deletions = new Map(deleted.map(item => [item.number, item]))
  const {prisma, close} = await createTargetPrisma(configuration.DATABASE_URL)
  const s3 = new S3Client({endpoint: 'http://127.0.0.1:9002', region: 'fr-par', forcePathStyle: true,
    credentials: {accessKeyId: configuration.S3_ACCESS_KEY, secretAccessKey: configuration.S3_SECRET_KEY}})
  const report = {version: 1, target: 'local', apply, sourcePolicy, preparationHash: digest(bytes), startedAt: new Date().toISOString(),
    counters: {created: 0, updated: 0, unchanged: 0, materialized: 0, unassigned: 0, failed: 0, filesCreated: 0, filesUnchanged: 0, partsCreated: 0, partsUnchanged: 0, archiveOnly: 0, nonAcceptedArchived: 0}, dossiers: []}
  try {
    await attestTargetDatabase(prisma, 'local')
    const zone = await prisma.zone.findUniqueOrThrow({where: {type_code: {type: 'REGION', code: 'reg-04'}}})
    const declarants = await prisma.declarant.findMany({where: {sourceId: {startsWith: 'reunion:DEP-974:declarant:'}}, select: {userId: true, sourceId: true}})
    const declarantBySource = new Map(declarants.map(item => [item.sourceId, item.userId]))
    const {materializeExternalDeclaration} = await import('../../lib/services/external-declarations.js')
    for (const row of manifest.dossiers) {
      const dataBytes = await readFile(path.join(preparation, row.relativePath))
      if (digest(dataBytes) !== row.sha256) throw new Error('Dossier préparé modifié')
      const record = JSON.parse(dataBytes)
      const deletion = deletions.get(row.number)
      if (deletion?.reason === 'user_request') {
        report.counters.archiveOnly += 1
        report.dossiers.push({externalId: record.externalId, disposition: 'ARCHIVE_ONLY_USER_REQUEST', sourceDeletion: deletion})
        continue
      }
      if (sourcePolicy === 'accepted' && !['accepte', 'accepté', 'accepted'].includes(record.sourceStatus)) {
        report.counters.nonAcceptedArchived += 1
        report.dossiers.push({externalId: record.externalId, disposition: 'ARCHIVE_ONLY_NON_ACCEPTED', sourceStatus: record.sourceStatus})
        continue
      }
      record.payload.transformerVersion ??= HISTORICAL_TRANSFORMER_VERSION
      if (deletion) record.payload.sourceDeletion = deletion
      record.sourceHash = digest(JSON.stringify({payload: record.payload, files: record.files}))
      const where = {provider_externalId: {provider: record.provider, externalId: record.externalId}}
      const existing = await prisma.externalDeclarationRecord.findUnique({where})
      const declarantUserId = declarantBySource.get(record.payload.declarantSourceId)
      const disposition = !existing ? 'created' : existing.sourceHash === record.sourceHash ? 'unchanged' : 'updated'
      report.counters[disposition] += 1
      const result = {externalId: record.externalId, disposition, declarantResolved: Boolean(declarantUserId), expectedSeries: row.series, expectedValues: row.values}
      try {
        if (apply) {
          for (const file of row.fileLedger.filter(item => item.archivePath)) {
            const outcome = await uploadVerifiedFile(s3, path.join(root, file.archivePath), file.storageKey, file.sha256,
              record.files.find(item => item.storageKey === file.storageKey)?.contentType)
            report.counters[outcome === 'created' ? 'filesCreated' : 'filesUnchanged'] += 1
          }
          for (const part of row.parsedLedger ?? []) {
            const outcome = await uploadVerifiedFile(s3, path.join(preparation, part.relativePath), part.storageKey, part.checksum, 'application/json')
            report.counters[outcome === 'created' ? 'partsCreated' : 'partsUnchanged'] += 1
          }
          const stored = disposition === 'unchanged' ? existing : await prisma.externalDeclarationRecord.upsert({where,
            create: {...record, zoneId: zone.id, sourceUpdatedAt: record.sourceUpdatedAt ? new Date(record.sourceUpdatedAt) : null},
            update: {...record, zoneId: zone.id, sourceUpdatedAt: record.sourceUpdatedAt ? new Date(record.sourceUpdatedAt) : null}})
          if (declarantUserId) {
            const materialized = await materializeExternalDeclaration({recordId: stored.id, declarantUserId, client: prisma})
            Object.assign(result, materialized)
            const type = await prisma.declarationType.upsert({where: {code: record.payload.type},
              create: {code: record.payload.type, name: record.payload.type === 'reunion_camion_citerne' ? 'Réunion — camion citerne' : 'Réunion — suivi des prélèvements'},
              update: {isAvailable: true}})
            const link = await prisma.declarantDeclarationType.findFirst({where: {declarantUserId, declarationTypeId: type.id, endDate: null}})
            if (!link) await prisma.declarantDeclarationType.create({data: {declarantUserId, declarationTypeId: type.id, startDate: new Date('1970-01-01')}})
            report.counters.materialized += 1
          } else report.counters.unassigned += 1
        } else if (!declarantUserId) report.counters.unassigned += 1
      } catch (error) {
        report.counters.failed += 1
        result.failed = true
        result.error = {name: error.name, code: error.code ?? error.statusCode ?? null, message: error.message}
      }
      report.dossiers.push(result)
      if (report.dossiers.length % 25 === 0) console.log(JSON.stringify({stage: 'history-import', dossiers: report.dossiers.length, ...report.counters}))
    }
    report.completedAt = new Date().toISOString()
    report.complete = report.counters.failed === 0 && report.dossiers.length === manifest.totalDossiers
    await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx', mode: 0o600})
    console.log(JSON.stringify({stage: 'history-import-complete', complete: report.complete, ...report.counters}))
    return report
  } finally {
    await close(); s3.destroy()
    await globalThis.prisma?.$disconnect()
    await globalThis.pgPool?.end()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const {values} = parseArgs({options: {archive: {type: 'string'}, prepared: {type: 'string'}, 'target-env': {type: 'string'}, report: {type: 'string'}, apply: {type: 'boolean', default: false}, 'source-policy': {type: 'string', default: 'accepted'}}})
  importHistory({archive: values.archive, prepared: values.prepared, targetEnv: values['target-env'], reportFile: values.report, apply: values.apply, sourcePolicy: values['source-policy']})
    .then(report => { if (!report.complete) process.exitCode = 2 }).catch(error => {
      console.error(JSON.stringify({stage: 'history-import-failed', error: error.name, code: error.code ?? null}))
      process.exitCode = 1
    })
}
