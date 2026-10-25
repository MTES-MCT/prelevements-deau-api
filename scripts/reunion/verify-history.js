#!/usr/bin/env node
import process from 'node:process'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {createHash} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'
import {S3Client, GetObjectCommand} from '@aws-sdk/client-s3'
import {loadEnv, createTargetPrisma, attestTargetDatabase} from './lib/runtime.js'
import {accessConnectionOptions} from './lib/access-cli.js'

const digest = value => createHash('sha256').update(value).digest('hex')
const scaled = value => {
  const text = String(value), negative = text.startsWith('-'), [whole, fraction = ''] = text.replace(/^[+-]/, '').split('.')
  return (negative ? -1n : 1n) * BigInt(`${whole}${fraction.padEnd(30, '0')}`)
}
const canonical = value => {
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value.toFixed === 'function') return value.toFixed()
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
async function verifiedBytes(filename, checksum) {
  const bytes = await readFile(filename)
  if (digest(bytes) !== checksum) throw new Error('Empreinte archive différente')
  return bytes
}
async function verifyObject(s3, storageKey, checksum) {
  const response = await s3.send(new GetObjectCommand({Bucket: 'reunion-migration-declarations', Key: storageKey}))
  const hash = createHash('sha256')
  for await (const bytes of response.Body) hash.update(bytes)
  if (hash.digest('hex') !== checksum) throw new Error('Contenu S3 différent de l’archive')
}
async function verifySeries(prisma, chunk, expected) {
  if (!chunk) return {ok: expected.length === 0, reason: 'MISSING_CHUNK'}
  const stats = await prisma.chunkValue.aggregate({where: {chunkId: chunk.id}, _count: {_all: true}, _sum: {value: true},
    _min: {periodStart: true}, _max: {periodEnd: true}})
  if (!expected.length) return {ok: stats._count._all === 0, actual: stats._count._all}
  const expectedSum = expected.reduce((sum, value) => sum + scaled(value.value), 0n)
  const maxEnd = expected.reduce((max, value) => value.periodEnd > max ? value.periodEnd : max, expected[0].periodEnd)
  const positions = [...new Set([0, Math.floor(expected.length / 4), Math.floor(expected.length / 2), Math.floor(expected.length * 3 / 4), expected.length - 1])]
  const samples = positions.map(index => expected[index])
  const actualSamples = await prisma.chunkValue.findMany({where: {chunkId: chunk.id,
    OR: samples.map(value => ({periodStart: value.periodStart, periodEnd: value.periodEnd}))},
  select: {periodStart: true, periodEnd: true, value: true, metricTypeCode: true, unit: true, frequency: true, valueKind: true, remark: true, metadata: true}})
  const actualByPeriod = new Map(actualSamples.map(value => [`${value.periodStart.toISOString()}/${value.periodEnd.toISOString()}`, value]))
  const samplesMatch = samples.every(value => JSON.stringify(canonical(value)) === JSON.stringify(canonical(actualByPeriod.get(`${value.periodStart.toISOString()}/${value.periodEnd.toISOString()}`))))
  const ok = stats._count._all === expected.length && scaled(stats._sum.value?.toFixed() ?? '0') === expectedSum
    && +stats._min.periodStart === +expected[0].periodStart && +stats._max.periodEnd === +maxEnd && samplesMatch
  return {ok, actual: stats._count._all, expected: expected.length, samples: samples.length, samplesMatch}
}

export async function verifyHistory({archive, prepared, targetEnv, reportFile, sourcePolicy = 'accepted'}) {
  if (sourcePolicy !== 'accepted') throw new Error('Seuls les dossiers DN acceptés peuvent être repris')
  process.umask(0o077)
  const configuration = await loadEnv(targetEnv)
  accessConnectionOptions(configuration, {target: 'local'})
  Object.assign(process.env, configuration, {SENTRY_DSN: ''})
  const root = path.resolve(archive), preparation = path.resolve(prepared)
  if (!preparation.startsWith(`${root}/`) || !path.resolve(reportFile).startsWith(`${root}/`)) throw new Error('Rapport privé dans archive obligatoire')
  const manifestBytes = await verifiedBytes(path.join(preparation, 'manifest.json'), (await readFile(path.join(preparation, 'manifest.json.sha256'), 'utf8')).trim())
  const manifest = JSON.parse(manifestBytes)
  const dn = JSON.parse(await readFile(path.join(root, 'dn/manifest.json')))
  const deleted = dn.deletedDossiers ?? JSON.parse(await verifiedBytes(path.join(root, 'dn/deletions.json'), (await readFile(path.join(root, 'dn/deletions.json.sha256'), 'utf8')).trim())).deleted
  const deletions = new Map(deleted.map(item => [item.number, item]))
  const {prisma, close} = await createTargetPrisma(configuration.DATABASE_URL)
  const s3 = new S3Client({endpoint: 'http://127.0.0.1:9002', region: 'fr-par', forcePathStyle: true,
    credentials: {accessKeyId: configuration.S3_ACCESS_KEY, secretAccessKey: configuration.S3_SECRET_KEY}})
  const report = {version: 1, target: 'local', sourcePolicy, preparationHash: digest(manifestBytes), startedAt: new Date().toISOString(),
    counters: {materialized: 0, unassigned: 0, archiveOnly: 0, nonAcceptedArchived: 0, objectsVerified: 0, series: 0, values: 0, rejectedRows: 0, sampledValues: 0}, valuesByStatus: {}, seriesByStatus: {}, dossiers: [], failures: []}
  const objectsVerified = new Set()
  try {
    await attestTargetDatabase(prisma, 'local')
    const {normalizeNativeValues} = await import('../../lib/declaration-importer/native.js')
    for (const row of manifest.dossiers) {
      const input = JSON.parse(await verifiedBytes(path.join(preparation, row.relativePath), row.sha256))
      const record = await prisma.externalDeclarationRecord.findUnique({where: {provider_externalId: {provider: 'DN', externalId: row.externalId}}})
      const result = {externalId: row.externalId}
      if (deletions.get(row.number)?.reason === 'user_request') {
        report.counters.archiveOnly += 1
        if (record) report.failures.push({externalId: row.externalId, code: 'ARCHIVE_ONLY_RECORD_VISIBLE'})
        report.dossiers.push({...result, disposition: 'ARCHIVE_ONLY'})
        continue
      }
      if (sourcePolicy === 'accepted' && !['accepte', 'accepté', 'accepted'].includes(input.sourceStatus)) {
        report.counters.nonAcceptedArchived += 1
        if (record) report.failures.push({externalId: row.externalId, code: 'NON_ACCEPTED_RECORD_VISIBLE'})
        report.dossiers.push({...result, disposition: 'ARCHIVE_ONLY_NON_ACCEPTED'})
        continue
      }
      if (!record) { report.failures.push({externalId: row.externalId, code: 'MISSING_RECORD'}); continue }
      if (record.declarationId && row.declarantSourceId) {
        const declaration = await prisma.declaration.findUnique({where: {id: record.declarationId}, select: {declarant: {select: {sourceId: true}}, type: true}})
        if (declaration?.declarant.sourceId !== row.declarantSourceId || declaration.type !== input.payload.type) report.failures.push({externalId: row.externalId, code: 'DECLARATION_ASSOCIATION_DIFFER'})
      }
      const source = record.declarationId ? await prisma.source.findUnique({where: {declarationId: record.declarationId}, include: {chunks: true}}) : null
      if (record.declarationId && (source?.status !== 'COMPLETED' || record.materializationStatus !== 'COMPLETED')) report.failures.push({externalId: row.externalId, code: 'INCOMPLETE_MATERIALIZATION'})
      if (!record.declarationId && row.declarantSourceId) report.failures.push({externalId: row.externalId, code: 'RESOLVED_DECLARANT_NOT_MATERIALIZED'})
      report.counters[record.declarationId ? 'materialized' : 'unassigned'] += 1
      const chunks = new Map((source?.chunks ?? []).map(chunk => [chunk.seriesKey, chunk]))
      for (const file of input.files.filter(file => file.available)) {
        if (!objectsVerified.has(file.storageKey)) { await verifyObject(s3, file.storageKey, file.checksum); objectsVerified.add(file.storageKey) }
      }
      let actualValues = 0, expectedValues = 0
      for (const part of row.parsedLedger ?? []) {
        if (!objectsVerified.has(part.storageKey)) { await verifyObject(s3, part.storageKey, part.checksum); objectsVerified.add(part.storageKey) }
        const parsed = JSON.parse(await verifiedBytes(path.join(preparation, part.relativePath), part.checksum))
        for (const series of parsed.data.series) {
          const normalized = normalizeNativeValues(series)
          expectedValues += normalized.values.length
          report.counters.rejectedRows += series.data.length - normalized.values.length
          if (!source) continue
          const chunk = chunks.get(series.seriesKey)
          if (chunk && normalized.values.length) {
            const expectedMetadata = {...series.metadata, nativeTemporal: true, parameter: normalized.values[0].metricTypeCode,
              unit: series.unit, frequency: series.frequency, valueType: series.valueType, sourcePointReference: series.pointPrelevement}
            const different = Object.keys(expectedMetadata).filter(key => JSON.stringify(canonical(expectedMetadata[key])) !== JSON.stringify(canonical(chunk.metadata?.[key])))
            if (different.length) report.failures.push({externalId: row.externalId, seriesKey: series.seriesKey, code: 'SERIES_METADATA_DIFFER', fields: different})
          }
          const validation = await verifySeries(prisma, chunk, normalized.values)
          report.counters.series += 1; report.counters.sampledValues += validation.samples ?? 0
          actualValues += validation.actual ?? 0
          const status = chunks.get(series.seriesKey)?.instructionStatus ?? 'EMPTY'
          report.seriesByStatus[status] = (report.seriesByStatus[status] ?? 0) + 1
          report.valuesByStatus[status] = (report.valuesByStatus[status] ?? 0) + (validation.actual ?? 0)
          if (!validation.ok) report.failures.push({externalId: row.externalId, seriesKey: series.seriesKey, code: 'VALUES_DIFFER', ...validation})
        }
      }
      report.counters.values += actualValues
      report.dossiers.push({...result, disposition: source ? 'MATERIALIZED' : 'UNASSIGNED', expectedValues, actualValues})
      if (report.dossiers.length % 25 === 0) console.log(JSON.stringify({stage: 'history-verify', dossiers: report.dossiers.length, failures: report.failures.length, values: report.counters.values}))
    }
    report.counters.objectsVerified = objectsVerified.size
    report.completedAt = new Date().toISOString(); report.ok = report.failures.length === 0
    await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx', mode: 0o600})
    console.log(JSON.stringify({stage: 'history-verified', ok: report.ok, failures: report.failures.length, ...report.counters}))
    return report
  } finally { await close(); s3.destroy(); await globalThis.prisma?.$disconnect(); await globalThis.pgPool?.end() }
}
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const {values} = parseArgs({options: {archive: {type: 'string'}, prepared: {type: 'string'}, 'target-env': {type: 'string'}, report: {type: 'string'}, 'source-policy': {type: 'string', default: 'accepted'}}})
  verifyHistory({archive: values.archive, prepared: values.prepared, targetEnv: values['target-env'], reportFile: values.report, sourcePolicy: values['source-policy']})
    .then(report => { if (!report.ok) process.exitCode = 2 }).catch(error => { console.error(JSON.stringify({stage: 'history-verify-failed', error: error.name, code: error.code ?? null, message: error.message})); process.exitCode = 1 })
}
