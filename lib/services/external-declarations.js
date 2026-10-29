import createStorageClient from '../util/s3.js'
import {DECLARATIONS_BUCKET} from '../handlers/declarations.js'
/* eslint-disable no-await-in-loop */
import {createHash, randomBytes} from 'node:crypto'
import createHttpError from 'http-errors'
import {prisma} from '../../db/prisma.js'
import {ingestDeclarationSeries} from '../declaration-importer/importer.js'
import {getEffectiveDeclarantZoneLinks, getPermissionZoneIdsForUser} from './zone-permissions.js'

export async function externalRecordScope(user, permission = 'declaration.detail.read') {
  if (user.role === 'ADMIN') return {}
  if (user.role !== 'INSTRUCTOR') throw createHttpError(403, 'Accès réservé aux agents.')
  const zoneIds = await getPermissionZoneIdsForUser(user, permission)
  return {zoneId: {in: zoneIds}}
}

export async function externalCandidates(zoneId, client = prisma) {
  const links = await getEffectiveDeclarantZoneLinks({zoneIds: [zoneId], client})
  const ids = [...new Set(links.map(link => link.declarantUserId))]
  const rows = await client.declarant.findMany({where: {userId: {in: ids}, declarantRole: 'PRELEVEUR'},
    select: {userId: true, socialReason: true, user: {select: {email: true, firstName: true, lastName: true}}}})
  return rows.map(row => ({id: row.userId, name: row.socialReason || [row.user.firstName, row.user.lastName].filter(Boolean).join(' '), email: row.user.email}))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
}

export function publicExternalRecord(record) {
  return {id: record.id, provider: record.provider, externalId: record.externalId, zoneId: record.zoneId,
    materializationStatus: record.materializationStatus, materializationError: record.materializationError,
    sourceStatus: record.sourceStatus, sourceUpdatedAt: record.sourceUpdatedAt, declarationId: record.declarationId,
    createdAt: record.createdAt, updatedAt: record.updatedAt,
    payload: {declarantName: record.payload?.declarantName ?? '', type: record.payload?.type},
    files: (record.files ?? []).map(file => ({filename: file.filename, available: file.available, checksum: file.checksum})),
    issues: record.issues, provenance: record.provider}
}

export async function materializeExternalDeclaration({recordId, declarantUserId, client = prisma, actorId = null, storage: suppliedStorage}) {
  const prepared = await client.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "ExternalDeclarationRecord" WHERE id = ${recordId}::uuid FOR UPDATE`
    const record = await tx.externalDeclarationRecord.findUnique({where: {id: recordId}})
    if (!record) throw createHttpError(404, 'Dossier externe introuvable.')
    const candidates = await externalCandidates(record.zoneId, tx)
    if (!candidates.some(candidate => candidate.id === declarantUserId)) throw createHttpError(403, 'Ce préleveur n’appartient pas au territoire du dossier.')
    const importSourceId = `reunion:DN:${record.externalId}`
    let declaration = record.declarationId ? await tx.declaration.findUnique({where: {id: record.declarationId}}) : await tx.declaration.findUnique({where: {importSourceId}})
    if (declaration && declaration.declarantUserId !== declarantUserId) throw createHttpError(409, 'Ce dossier est déjà associé à un autre préleveur.')
    if (!declaration) {
      // Random dossier code uses existing six-character contract, retry collisions.
      let code
      do { code = randomBytes(4).toString('hex').slice(0, 6).toUpperCase() } while (await tx.declaration.findUnique({where: {code}}))
      declaration = await tx.declaration.create({data: {code, declarantUserId, importSourceId,
        type: record.payload.type ?? 'reunion_multi_param', dataSourceType: 'SPREADSHEET', waterWithdrawalType: record.payload.waterWithdrawalType ?? 'unknown',
        comment: record.payload.comment ?? `Dossier historique DN ${record.externalId}`, aotDecreeNumber: record.payload.aotDecreeNumber ?? null,
        createdAt: historicalDate(record.payload.dateDepot ?? record.payload.createdAt)}})
    }
    for (const file of record.files ?? []) {
      if (file.available === false || !file.storageKey) continue
      const existing = await tx.declarationFile.findUnique({where: {storageKey: file.storageKey}})
      if (existing && existing.declarationId !== declaration.id) throw createHttpError(409, 'Fichier déjà rattaché à un autre dossier.')
      if (!existing) await tx.declarationFile.create({data: {declarationId: declaration.id, storageKey: file.storageKey, filename: file.filename, type: file.type ?? 'reunion_multi_param'}})
    }
    await tx.externalDeclarationRecord.update({where: {id: record.id}, data: {declarationId: declaration.id, materializationStatus: 'PROCESSING', materializationError: null}})
    const declarationId = declaration.id
    if (record.payload.parsedFiles?.length) return {record, declarationId}
    const result = await ingestDeclarationSeries({declarationId, data: record.payload.parsedData ?? {nativeTemporal: true, series: []},
      errors: record.payload.parsingErrors ?? record.issues ?? [], processingMetadata: historicalMetadata(record, actorId),
      client: tx, logger: {log() {}, warn() {}, error() {}}})
    await tx.externalDeclarationRecord.update({where: {id: record.id}, data: {materializationStatus: 'COMPLETED', materializationError: null}})
    return {declarationId, sourceId: result.sourceId}
  }, {timeout: 180000, maxWait: 30000})
  if (prepared.sourceId) return prepared
  const {record, declarationId} = prepared
  try {
    const storage = suppliedStorage ?? createStorageClient(DECLARATIONS_BUCKET)
    let result
    for (let index = 0; index < record.payload.parsedFiles.length; index++) {
      const file = record.payload.parsedFiles[index]
      const bytes = await storage.downloadObject(file.storageKey)
      if (createHash('sha256').update(bytes).digest('hex') !== file.checksum) throw createHttpError(409, 'La pièce préparée ne correspond pas à son empreinte.')
      const part = JSON.parse(bytes.toString('utf8'))
      result = await client.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "ExternalDeclarationRecord" WHERE id = ${record.id}::uuid FOR UPDATE`
        const current = await tx.externalDeclarationRecord.findUnique({where: {id: record.id}, select: {sourceHash: true, declarationId: true}})
        if (current?.sourceHash !== record.sourceHash || current.declarationId !== declarationId) throw createHttpError(409, 'Une nouvelle version du dossier a remplacé cet import.')
        return ingestDeclarationSeries({declarationId,
          data: {...part.data, batch: {id: record.sourceHash, index, total: record.payload.parsedFiles.length}}, errors: part.errors ?? [],
          processingMetadata: historicalMetadata(record, actorId), client: tx, logger: {log() {}, warn() {}, error() {}}})
      }, {timeout: 180000, maxWait: 30000})
    }
    await client.externalDeclarationRecord.updateMany({where: {id: record.id, sourceHash: record.sourceHash}, data: {materializationStatus: 'COMPLETED', materializationError: null}})
    return {declarationId, sourceId: result.sourceId}
  } catch (error) {
    await client.$transaction(async tx => {
      await tx.externalDeclarationRecord.updateMany({where: {id: record.id, sourceHash: record.sourceHash}, data: {materializationStatus: 'FAILED', materializationError: 'Import interrompu. Les parties reçues sont conservées ; relancez le traitement.'}})
      const failedSource = await tx.source.updateMany({where: {declarationId, metadata: {path: ['nativeBatch', 'id'], equals: record.sourceHash}}, data: {status: 'FAILED'}})
      if (failedSource.count) await tx.declaration.update({where: {id: declarationId}, data: {processingStatus: 'FAILED', processingError: 'Import historique interrompu', processingFailedAt: new Date()}})
    })
    throw error
  }
}

function historicalDate(value) {
  if (!value) throw createHttpError(409, 'La date de dépôt historique est absente.')
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw createHttpError(409, 'La date de dépôt historique est invalide.')
  return date
}

function historicalMetadata(record, actorId) {
  return {provenance: 'DN', externalId: record.externalId, sourceStatus: record.sourceStatus,
    sourceHash: record.sourceHash, sourceDeletion: record.payload.sourceDeletion ?? null,
    historicalAccepted: record.sourceStatus === 'accepte', historicalDecisionAt: record.payload.dateTraitement ?? null, assignedByUserId: actorId}
}

export function externalPayloadHash(payload) { return createHash('sha256').update(JSON.stringify(payload)).digest('hex') }
