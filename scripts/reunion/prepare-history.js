#!/usr/bin/env node
import process from 'node:process'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'
import {readFile, mkdir, writeFile, link} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {BSON} from 'mongodb'
import {extractManualHistory, historicalType} from './lib/manual-history.js'
import {HISTORICAL_TRANSFORMER_VERSION} from './lib/history-contract.js'
import {resolveHistoricalDeclarant} from './lib/historical-declarants.js'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const jsonSafe = value => JSON.parse(JSON.stringify(value))
async function verifiedJson(root, relativePath) {
  const bytes = await readFile(path.join(root, relativePath))
  if (digest(bytes) !== (await readFile(path.join(root, `${relativePath}.sha256`), 'utf8')).trim()) throw new Error('Manifeste modifié')
  return JSON.parse(bytes)
}
async function collection(root, manifest, name) {
  const file = manifest.mongo.find(item => item.collection === name)
  const bytes = await readFile(path.join(root, file.relativePath))
  if (digest(bytes) !== file.sha256) throw new Error('Collection archivée modifiée')
  return bytes.toString('utf8').trim().split('\n').filter(Boolean).map(line => BSON.EJSON.parse(line))
}
async function savePart(destination, number, result) {
  const part = {data: {nativeTemporal: true, conflictPolicy: 'SKIP_NEW_CHUNK', series: result.series}, errors: result.errors}
  const bytes = `${JSON.stringify(part)}\n`
  const checksum = digest(bytes)
  const relativePath = `parts/${checksum}.json`
  const storageKey = `reunion/80149/${number}/parsed/${checksum}.json`
  try { await writeFile(path.join(destination, relativePath), bytes, {flag: 'wx', mode: 0o600}) } catch (error) {
    if (error.code !== 'EEXIST' || digest(await readFile(path.join(destination, relativePath))) !== checksum) throw error
  }
  const descriptor = {storageKey, checksum, seriesCount: result.series.length,
    valueCount: result.series.reduce((sum, series) => sum + series.data.length, 0), errorCount: result.errors.length}
  return {descriptor, ledger: {...descriptor, relativePath, size: Buffer.byteLength(bytes)}}
}
function errorSummary(errors, file) {
  if (!errors.length) return null
  const counts = errors.reduce((counts, item) => { counts[item.code] = (counts[item.code] ?? 0) + 1; return counts }, {})
  return {code: 'FILE_PARSE_ERRORS', severity: errors.some(error => error.severity === 'error') ? 'error' : 'warning',
    fileId: file.sourceFileId, filename: file.filename, count: errors.length, counts,
    message: `${errors.length} anomalie(s) ; détail conservé dans le résultat du fichier`}
}
export async function reusePreparedDossier({resumeFrom, number, legacy, raw, sourceFiles, objectByKey, legacySeries, destination}) {
  if (!resumeFrom) return null
  let bytes
  try { bytes = await readFile(path.join(resumeFrom, `dossier-${number}.json`)) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  const record = JSON.parse(bytes)
  if (record.externalId !== `80149:${number}` || record.sourceHash !== digest(JSON.stringify({payload: record.payload, files: record.files}))
    || JSON.stringify(record.payload.legacy) !== JSON.stringify(jsonSafe(legacy))
    || JSON.stringify(record.payload.rawDossier) !== JSON.stringify(raw)
    || record.files.length !== sourceFiles.size) throw new Error('Préparation à reprendre incohérente avec la source')
  const fileLedger = [], parsedLedger = []
  let index = 0
  for (const [key, attachment] of sourceFiles) {
    const object = objectByKey.get(key), file = record.files[index++]
    const sourceFileId = String(attachment._id ?? `DN:${digest(key)}`)
    if (file.sourceFileId !== sourceFileId || Boolean(file.available) !== Boolean(object)
      || (object && file.checksum !== object.sha256)) throw new Error('Pièce reprise différente de la source')
    fileLedger.push({sourceFileId, filename: file.filename,
      ...(object ? {archivePath: object.relativePath, storageKey: file.storageKey, sha256: file.checksum} : {}),
      disposition: !object ? 'MISSING' : file.type === 'data' ? 'PARSED' : 'ATTACHMENT_ONLY',
      legacySeries: legacySeries.filter(item => attachment._id && String(item.attachmentId) === String(attachment._id)).length})
  }
  for (const part of record.payload.parsedFiles) {
    if (!/^[a-f\d]{64}$/.test(part.checksum)) throw new Error('Partition à reprendre invalide')
    const relativePath = `parts/${part.checksum}.json`, source = path.join(resumeFrom, relativePath)
    const partBytes = await readFile(source)
    if (digest(partBytes) !== part.checksum) throw new Error('Partition à reprendre modifiée')
    try { await link(source, path.join(destination, relativePath)) } catch (error) { if (error.code !== 'EEXIST') throw error }
    parsedLedger.push({...part, relativePath, size: partBytes.length})
  }
  return {type: record.payload.type, parsedFiles: record.payload.parsedFiles, parsedLedger, issues: record.issues,
    files: record.files, fileLedger, manualCounts: extractManualHistory({dossier: legacy, rawDossier: raw}).counts,
    reviewedIdentity: record.payload.declarantResolution?.method === 'REVIEWED_SOURCE_EVIDENCE' ? record.payload.declarantResolution : null,
    record, recordBytes: bytes}
}
async function prepareDossier({number, legacy, raw, sourceFiles, objectByKey, legacySeries, root, destination, parseReunionFile}) {
  const type = historicalType(legacy, raw)
  const parsedFiles = [], parsedLedger = [], issues = [], files = [], fileLedger = []
  for (const [key, attachment] of sourceFiles) {
    const object = objectByKey.get(key)
    const filename = path.basename(key).replace(/^[a-f\d]{8}-/, '')
    const sourceFileId = String(attachment._id ?? `DN:${digest(key)}`)
    const legacyForFile = legacySeries.filter(item => attachment._id && String(item.attachmentId) === String(attachment._id))
    if (!object) {
      issues.push({code: 'MISSING_ATTACHMENT', severity: 'error', fileId: sourceFileId, filename, message: 'Pièce source indisponible'})
      files.push({filename, type: 'attachment', available: false, sourceFileId})
      fileLedger.push({sourceFileId, filename, disposition: 'MISSING', legacySeries: legacyForFile.length})
      continue
    }
    const bytes = await readFile(path.join(root, object.relativePath))
    if (digest(bytes) !== object.sha256) throw new Error('Pièce archivée modifiée')
    const storageKey = `reunion/80149/${number}/${object.sha256}/${path.basename(key)}`
    const isSheet = /\.(xlsx|xls|ods)$/i.test(filename)
    const file = {filename, storageKey, type: isSheet ? 'data' : 'attachment', checksum: object.sha256,
      size: bytes.length, available: true, sourceFileId, contentType: object.contentType ?? null}
    files.push(file)
    const result = isSheet ? parseReunionFile({buffer: bytes, filename, fileId: sourceFileId, typeCode: type})
      : {series: [], errors: [{code: 'ATTACHMENT_ONLY', severity: 'warning', filename, fileId: sourceFileId, message: 'Pièce conservée sans lecture automatique'}]}
    const part = await savePart(destination, number, result)
    parsedFiles.push(part.descriptor); parsedLedger.push(part.ledger)
    const issue = errorSummary(result.errors, file)
    if (issue) issues.push(issue)
    fileLedger.push({sourceFileId, filename, archivePath: object.relativePath, storageKey, sha256: object.sha256,
      disposition: !isSheet ? 'ATTACHMENT_ONLY' : result.series.length ? 'PARSED' : 'NO_VALID_SERIES',
      legacySeries: legacyForFile.length, series: part.descriptor.seriesCount, values: part.descriptor.valueCount, errors: part.descriptor.errorCount})
  }
  const manual = extractManualHistory({dossier: legacy, rawDossier: raw})
  if (manual.series.length || manual.errors.length || parsedFiles.length === 0) {
    const part = await savePart(destination, number, manual)
    parsedFiles.push(part.descriptor); parsedLedger.push(part.ledger)
    const issue = errorSummary(manual.errors, {filename: 'Saisie du dossier DN'})
    if (issue) issues.push(issue)
  }
  return {type, parsedFiles, parsedLedger, issues, files, fileLedger, manualCounts: manual.counts}
}

export async function prepareHistory({archive, parserModule, output, resumeFrom, reparseDossier}) {
  const root = path.resolve(archive), destination = path.resolve(output)
  if (!destination.startsWith(`${root}/`)) throw new Error('Sortie de préparation dans l’archive privée obligatoire')
  if (resumeFrom && !path.resolve(resumeFrom).startsWith(`${root}/`)) throw new Error('Préparation précédente dans l’archive privée obligatoire')
  if (reparseDossier !== undefined && (!resumeFrom || !Number.isSafeInteger(reparseDossier) || reparseDossier < 1)) throw new Error('Révision ciblée invalide')
  process.umask(0o077)
  await mkdir(destination, {recursive: false, mode: 0o700})
  await mkdir(path.join(destination, 'parts'), {mode: 0o700})
  const manifest = await verifiedJson(root, 'manifest.json'), dn = await verifiedJson(root, 'dn/manifest.json')
  const {parseReunionFile} = await import(pathToFileURL(path.resolve(parserModule)).href)
  const [dossiers, attachments, preleveurs, legacySeries, points, exploitations] = await Promise.all(['dossiers', 'dossier_attachments', 'preleveurs', 'series', 'points_prelevement', 'exploitations']
    .map(name => collection(root, manifest, name)))
  const byNumber = new Map(dossiers.map(item => [item.ds.dossierNumber, item])), dnByNumber = new Map(dn.dossiers.map(item => [item.number, item]))
  const objectByKey = new Map([...manifest.objects, ...dn.attachments].filter(item => !item.missing && item.available !== false)
    .map(item => [item.key.normalize('NFC'), item]))
  const numbers = [...new Set([...byNumber.keys(), ...dnByNumber.keys()])].sort((a, b) => a - b)
  if (reparseDossier !== undefined && !numbers.includes(reparseDossier)) throw new Error('Dossier à réviser absent')
  const report = {version: 2, createdAt: new Date().toISOString(), totalDossiers: numbers.length, reusedDossiers: 0, reparsedDossiers: reparseDossier ? [reparseDossier] : [],
    mongoDossiers: dossiers.length, dnDossiers: dn.dossiers.length, sourceSeries: legacySeries.length,
    parserModule: path.basename(parserModule), dossiers: [], totals: {series: 0, values: 0, files: 0, missingFiles: 0,
      errors: 0, resolvedDeclarants: 0, unresolvedDeclarants: 0, manualIndices: 0, manualVolumes: 0}}
  for (const number of numbers) {
    const legacy = byNumber.get(number) ?? {ds: {demarcheNumber: 80149, dossierNumber: number}}, dnFile = dnByNumber.get(number)
    const rawBytes = dnFile ? await readFile(path.join(root, dnFile.relativePath)) : null
    if (rawBytes && digest(rawBytes) !== dnFile.sha256) throw new Error('Dossier DN modifié')
    const raw = rawBytes ? JSON.parse(rawBytes) : null
    const sourceFiles = new Map(attachments.filter(item => item.ds?.dossierNumber === number)
      .map(item => [`demarche-80149/dossiers/${number}/attachments/${item.storageKey}`.normalize('NFC'), item]))
    for (const item of dn.attachments.filter(item => item.key.startsWith(`demarche-80149/dossiers/${number}/attachments/`))) {
      if (!sourceFiles.has(item.key.normalize('NFC'))) sourceFiles.set(item.key.normalize('NFC'), {storageKey: path.basename(item.key), ds: {dossierNumber: number}})
    }
    const context = {number, legacy, raw, sourceFiles, objectByKey, legacySeries, root, destination, parseReunionFile}
    const cached = await reusePreparedDossier({...context, resumeFrom})
    const prepared = cached && number !== reparseDossier ? cached : await prepareDossier(context)
    if (cached && number !== reparseDossier) report.reusedDossiers += 1
    let {owner, resolution: declarantResolution, proposal: declarantProposal} = resolveHistoricalDeclarant({legacy, preleveurs, points, exploitations})
    if (cached?.reviewedIdentity) {
      owner = preleveurs.find(item => `reunion:DEP-974:declarant:${item.id_preleveur}` === cached.reviewedIdentity.sourceId
        && String(item._id) === cached.reviewedIdentity.sourceReference)
      if (!owner) throw new Error('Identité relue absente du référentiel source')
      declarantResolution = cached.reviewedIdentity
      declarantProposal = undefined
    }
    const declarantSourceId = owner ? `reunion:DEP-974:declarant:${owner.id_preleveur}` : null
    const sourceStatus = String(raw?.state ?? legacy.status ?? 'unknown').replaceAll(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
    const payload = jsonSafe({transformerVersion: HISTORICAL_TRANSFORMER_VERSION, type: prepared.type, dossierNumber: number, demarcheNumber: 80149, declarantSourceId, declarantResolution, declarantProposal,
      declarantName: legacy.declarant?.raisonSociale ?? '', sourceStatus, createdAt: raw?.dateDepot ?? legacy.dateDepot,
      dateDepot: raw?.dateDepot ?? legacy.dateDepot, dateTraitement: raw?.dateTraitement ?? legacy.dateTraitement,
      comment: legacy.commentaires, aotDecreeNumber: legacy.numeroArreteAot, waterWithdrawalType: legacy.typePrelevement,
      legacy, rawDossier: raw, parsedFiles: prepared.parsedFiles, parsingErrors: prepared.issues})
    let record = {provider: 'DN', externalId: `80149:${number}`, sourceStatus,
      sourceUpdatedAt: raw?.dateDerniereModification ?? null, sourceHash: digest(JSON.stringify({payload, files: prepared.files})),
      payload, files: prepared.files, issues: prepared.issues}
    const reuseRecord = reparseDossier !== undefined && number !== reparseDossier && cached
    if (reuseRecord) record = cached.record
    const relativePath = `dossier-${number}.json`, bytes = reuseRecord ? cached.recordBytes : `${JSON.stringify(record)}\n`
    await writeFile(path.join(destination, relativePath), bytes, {flag: 'wx', mode: 0o600})
    const row = {number, externalId: record.externalId, relativePath, sha256: digest(bytes), sourceStatus, declarantSourceId, declarantResolution, declarantProposal,
      files: prepared.files.length, series: prepared.parsedFiles.reduce((sum, part) => sum + part.seriesCount, 0),
      values: prepared.parsedFiles.reduce((sum, part) => sum + part.valueCount, 0), errors: prepared.parsedFiles.reduce((sum, part) => sum + part.errorCount, 0),
      fileLedger: prepared.fileLedger, parsedLedger: prepared.parsedLedger, manualCounts: prepared.manualCounts}
    report.dossiers.push(row)
    for (const key of ['files', 'series', 'values', 'errors']) report.totals[key] += row[key]
    report.totals.missingFiles += prepared.files.filter(file => !file.available).length
    report.totals[declarantSourceId ? 'resolvedDeclarants' : 'unresolvedDeclarants'] += 1
    report.totals.manualIndices += prepared.manualCounts.indices; report.totals.manualVolumes += prepared.manualCounts.volumes
    if (report.dossiers.length % 25 === 0) console.log(JSON.stringify({stage: 'prepare-history', dossiers: report.dossiers.length, series: report.totals.series, values: report.totals.values}))
  }
  const bytes = `${JSON.stringify(report, null, 2)}\n`
  await writeFile(path.join(destination, 'manifest.json'), bytes, {flag: 'wx', mode: 0o600})
  await writeFile(path.join(destination, 'manifest.json.sha256'), `${digest(bytes)}\n`, {flag: 'wx', mode: 0o600})
  console.log(JSON.stringify({stage: 'history-prepared', dossiers: report.totalDossiers, ...report.totals}))
  return report
}
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const {values} = parseArgs({options: {archive: {type: 'string'}, 'parser-module': {type: 'string'}, output: {type: 'string'}, 'resume-from': {type: 'string'}, 'reparse-dossier': {type: 'string'}}})
  prepareHistory({archive: values.archive, parserModule: values['parser-module'], output: values.output, resumeFrom: values['resume-from'], reparseDossier: values['reparse-dossier'] === undefined ? undefined : Number(values['reparse-dossier'])}).catch(error => {
    console.error(JSON.stringify({stage: 'history-prepare-failed', error: error.name, code: error.code ?? null, message: error.message}))
    process.exitCode = 1
  })
}
