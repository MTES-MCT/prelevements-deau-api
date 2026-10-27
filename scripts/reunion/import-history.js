#!/usr/bin/env node
import process from 'node:process'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {readFile} from 'node:fs/promises'
import {PutObjectCommand, HeadObjectCommand, GetObjectCommand} from '@aws-sdk/client-s3'
import {loadEnv} from './lib/runtime.js'
import {reservePrivateReport} from './lib/access-cli.js'
import {historyTarget, historyPlanHash, assertHistorySimulation, HISTORY_TARGET_OPTIONS, historyTargetArguments} from './lib/history-target.js'
import {HISTORICAL_TRANSFORMER_VERSION} from './lib/history-contract.js'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export async function verifyHistoryAssets(operations, root, preparation) {
  const checked = new Map()
  for (const {row, disposition} of operations) {
    if (disposition.startsWith('ARCHIVE_ONLY')) continue
    const assets = [
      ...row.fileLedger.filter(file => file.archivePath).map(file => ({filename: path.join(root, file.archivePath), checksum: file.sha256})),
      ...(row.parsedLedger ?? []).map(file => ({filename: path.join(preparation, file.relativePath), checksum: file.checksum}))
    ]
    for (const {filename, checksum} of assets) {
      if (checked.has(filename)) {
        if (checked.get(filename) !== checksum) throw new Error('Empreintes contradictoires pour une pièce préparée')
        continue
      }
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(filename)) hash.update(chunk)
      if (hash.digest('hex') !== checksum) throw new Error('Fichier préparé modifié avant application')
      checked.set(filename, checksum)
    }
  }
  return checked.size
}

async function uploadVerifiedFile(storage, filename, storageKey, expectedHash, contentType) {
  const bytes = await readFile(filename)
  if (digest(bytes) !== expectedHash) throw new Error('Fichier préparé modifié')
  const s3 = storage.client
  const params = {Bucket: storage.bucket, Key: storageKey}
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

export async function importHistory({archive, prepared, targetEnv, reportFile, apply = false, sourcePolicy = 'accepted', target = 'local', ...targetOptions}) {
  if (sourcePolicy !== 'accepted') throw new Error('Seuls les dossiers DN acceptés peuvent être repris')
  process.umask(0o077)
  const configuration = await loadEnv(targetEnv)
  Object.assign(process.env, configuration, {SENTRY_DSN: '', SENTRY_ENV: '', BREVO_API_KEY: '', SMTP_HOST: '127.0.0.1', SMTP_PORT: '1026'})
  const root = path.resolve(archive), preparation = path.resolve(prepared)
  if (!preparation.startsWith(`${root}/`)) throw new Error('Préparation privée dans archive obligatoire')
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
  const sourceHash = historyPlanHash({preparationHash: digest(bytes), deletions: deleted, sourcePolicy})
  const context = await historyTarget({target, configuration, sourceHash, targetEnv, apply, ...targetOptions})
  const {prisma, storage, close, attestation, expected, backup} = context
  let output
  const report = {version: 2, operation: 'history-import', target, apply, sourcePolicy, sourceHash, attestation, backup,
    preparationHash: digest(bytes), startedAt: new Date().toISOString(),
    counters: {created: 0, updated: 0, unchanged: 0, materialized: 0, unassigned: 0, failed: 0, filesCreated: 0, filesUnchanged: 0, partsCreated: 0, partsUnchanged: 0, archiveOnly: 0, nonAcceptedArchived: 0}, dossiers: []}
  try {
    output = await reservePrivateReport(reportFile)
    const zone = await prisma.zone.findUniqueOrThrow({where: {type_code: {type: 'REGION', code: 'reg-04'}}})
    const declarants = await prisma.declarant.findMany({where: {sourceId: {startsWith: 'reunion:DEP-974:declarant:'}}, select: {userId: true, sourceId: true}})
    const declarantBySource = new Map(declarants.map(item => [item.sourceId, item.userId]))
    const operations = []
    for (const row of manifest.dossiers) {
      const dataBytes = await readFile(path.join(preparation, row.relativePath))
      if (digest(dataBytes) !== row.sha256) throw new Error('Dossier préparé modifié')
      const record = JSON.parse(dataBytes)
      const deletion = deletions.get(row.number)
      const where = {provider_externalId: {provider: record.provider, externalId: record.externalId}}
      const existing = await prisma.externalDeclarationRecord.findUnique({where})
      const archiveOnly = deletion?.reason === 'user_request' ? 'ARCHIVE_ONLY_USER_REQUEST'
        : (!['accepte', 'accepté', 'accepted'].includes(record.sourceStatus) ? 'ARCHIVE_ONLY_NON_ACCEPTED' : null)
      if (archiveOnly && existing) throw new Error('Un dossier réservé à l’archive existe déjà dans la cible')
      record.payload.transformerVersion ??= HISTORICAL_TRANSFORMER_VERSION
      if (deletion) record.payload.sourceDeletion = deletion
      record.sourceHash = digest(JSON.stringify({payload: record.payload, files: record.files}))
      const declarantUserId = declarantBySource.get(record.payload.declarantSourceId)
      if (record.payload.declarantSourceId && !declarantUserId) throw new Error('Préleveur résolu absent de la cible')
      if (!record.payload.declarantSourceId && existing?.declarationId) throw new Error('Un dossier à arbitrer est déjà attribué dans la cible')
      const disposition = archiveOnly ?? (!existing ? 'created' : existing.sourceHash === record.sourceHash ? 'unchanged' : 'updated')
      operations.push({row, record, deletion, where, existing, declarantUserId, disposition})
    }
    report.planHash = historyPlanHash(operations.map(({row, record, existing, declarantUserId, disposition}) => ({externalId: record.externalId,
      dossierHash: row.sha256, sourceHash: record.sourceHash, declarantUserId: declarantUserId ?? null, disposition,
      existing: existing ? {id: existing.id, sourceHash: existing.sourceHash, declarationId: existing.declarationId, materializationStatus: existing.materializationStatus} : null})))
    if (apply && target === 'testing') assertHistorySimulation(expected, report)
    report.assetsVerified = await verifyHistoryAssets(operations, root, preparation)
    const materializeExternalDeclaration = apply ? (await import('../../lib/services/external-declarations.js')).materializeExternalDeclaration : undefined
    for (const {row, record, deletion, where, existing, declarantUserId, disposition} of operations) {
      if (disposition.startsWith('ARCHIVE_ONLY')) {
        report.counters[disposition === 'ARCHIVE_ONLY_USER_REQUEST' ? 'archiveOnly' : 'nonAcceptedArchived'] += 1
        report.dossiers.push({externalId: record.externalId, disposition, sourceStatus: record.sourceStatus, sourceDeletion: deletion})
        continue
      }
      report.counters[disposition] += 1
      const result = {externalId: record.externalId, disposition, declarantResolved: Boolean(declarantUserId), expectedSeries: row.series, expectedValues: row.values}
      try {
        if (apply) {
          for (const file of row.fileLedger.filter(item => item.archivePath)) {
            const outcome = await uploadVerifiedFile(storage, path.join(root, file.archivePath), file.storageKey, file.sha256,
              record.files.find(item => item.storageKey === file.storageKey)?.contentType)
            report.counters[outcome === 'created' ? 'filesCreated' : 'filesUnchanged'] += 1
          }
          for (const part of row.parsedLedger ?? []) {
            const outcome = await uploadVerifiedFile(storage, path.join(preparation, part.relativePath), part.storageKey, part.checksum, 'application/json')
            report.counters[outcome === 'created' ? 'partsCreated' : 'partsUnchanged'] += 1
          }
          const stored = disposition === 'unchanged' ? existing : await prisma.externalDeclarationRecord.upsert({where,
            create: {...record, zoneId: zone.id, sourceUpdatedAt: record.sourceUpdatedAt ? new Date(record.sourceUpdatedAt) : null},
            update: {...record, zoneId: zone.id, sourceUpdatedAt: record.sourceUpdatedAt ? new Date(record.sourceUpdatedAt) : null}})
          if (declarantUserId) {
            const materialized = await materializeExternalDeclaration({recordId: stored.id, declarantUserId, client: prisma,
              storage: {async downloadObject(key) {
                const response = await storage.client.send(new GetObjectCommand({Bucket: storage.bucket, Key: key}))
                return Buffer.from(await response.Body.transformToByteArray())
              }}})
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
    await output.writeFile(`${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify({stage: 'history-import-complete', complete: report.complete, ...report.counters}))
    return report
  } finally {
    await output?.close(); await close()
    await globalThis.prisma?.$disconnect()
    await globalThis.pgPool?.end()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const {values} = parseArgs({options: {...HISTORY_TARGET_OPTIONS, archive: {type: 'string'}, prepared: {type: 'string'}, 'target-env': {type: 'string'}, report: {type: 'string'}, apply: {type: 'boolean', default: false}, 'source-policy': {type: 'string', default: 'accepted'}}})
  importHistory({archive: values.archive, prepared: values.prepared, targetEnv: values['target-env'], reportFile: values.report, apply: values.apply, sourcePolicy: values['source-policy'], ...historyTargetArguments(values)})
    .then(report => { if (!report.complete) process.exitCode = 2 }).catch(error => {
      console.error(JSON.stringify({stage: 'history-import-failed', error: error.name, code: error.code ?? null}))
      process.exitCode = 1
    })
}
