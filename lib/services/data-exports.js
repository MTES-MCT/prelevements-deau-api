import {randomUUID} from 'node:crypto'
import {Buffer} from 'node:buffer'

import {Prisma} from '@prisma/client'
import ExcelJS from 'exceljs'

import {prisma} from '../../db/prisma.js'
import {NON_REJECTED_CHUNK_INSTRUCTION_STATUSES} from '../constants/chunk-statuses.js'
import {parametersConfig} from '../parameters-config.js'
import {
  LEGACY_METRIC_TYPE_CODES,
  getCompatibleMetricTypeCodes,
  normalizeMetricTypeCode
} from '../constants/metric-type-codes.js'
import createStorageClient from '../util/s3.js'
import {getPermissionZoneIdsForUser} from './zone-permissions.js'

export const DATA_EXPORTS_BUCKET = 'exports'

const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const WATER_BODY_TYPE_LABELS = {
  SUPERFICIELLE: 'Eau superficielle',
  SOUTERRAIN: 'Eau souterraine',
  TRANSITION: 'Eau de transition'
}

const DATA_KIND_LABELS = {
  DECLARED: 'Donnée brute',
  COMPUTED: 'Donnée inférée'
}

const POINT_FLOW_TYPE_LABELS = {
  PRELEVEMENT: 'Prélèvement',
  REJET: 'Rejet'
}

const CUMULATIVE_METRIC_TYPE_CODES = Object.entries(parametersConfig)
  .filter(([, config]) => config.valueType === 'cumulative')
  .flatMap(([metricTypeCode]) => getCompatibleMetricTypeCodes(metricTypeCode))

const EXPORT_HEADERS = [
  {key: 'pointPrelevementId', label: 'ID du point'},
  {key: 'pointPrelevementNom', label: 'Nom du point'},
  {key: 'fonctionPoint', label: 'Type de point'},
  {key: 'commune', label: 'Commune'},
  {key: 'codeCommune', label: 'Code commune'},
  {key: 'codeBss', label: 'Code BSS'},
  {key: 'codeOpr', label: 'Code OPR'},
  {key: 'typeMilieu', label: 'Type de milieu'},
  {key: 'usageCode', label: 'Code usage SANDRE'},
  {key: 'usageLibelle', label: 'Usage SANDRE'},
  {key: 'sousUsageCode', label: 'Code sous-usage SANDRE'},
  {key: 'sousUsageLibelle', label: 'Sous-usage SANDRE'},
  {key: 'preleveurId', label: 'ID du préleveur'},
  {key: 'preleveurNom', label: 'Nom du préleveur'},
  {key: 'preleveurEmail', label: 'Email du préleveur'},
  {key: 'collecteurId', label: 'ID du collecteur'},
  {key: 'collecteurNom', label: 'Nom du collecteur'},
  {key: 'collecteurEmail', label: 'Email du collecteur'},
  {key: 'donneeTelerelevee', label: 'Donnée télérelevée'},
  {key: 'typeDonnee', label: 'Type de mesure'},
  {key: 'unite', label: 'Unité'},
  {key: 'dateMesure', label: 'Date de mesure'},
  {key: 'heureMesure', label: 'Heure de mesure'},
  {key: 'dateHeureMesure', label: 'DateHeure de mesure'},
  {key: 'dateDebutPeriode', label: 'Date de début de période'},
  {key: 'heureDebutPeriode', label: 'Heure de début de période'},
  {key: 'dateHeureDebutPeriode', label: 'DateHeure de début de période'},
  {key: 'dateFinPeriode', label: 'Date de fin de période'},
  {key: 'heureFinPeriode', label: 'Heure de fin de période'},
  {key: 'dateHeureFinPeriode', label: 'DateHeure de fin de période'},
  {key: 'valeur', label: 'Valeur'},
  {key: 'remarque', label: 'Remarque'},
  {key: 'frequence', label: 'Fréquence'},
  {key: 'typeValeur', label: 'Type de valeur'},
  {key: 'origineDonnee', label: 'Origine de la donnée'}
]

function getArray(value) {
  return Array.isArray(value) ? value : []
}

function sortByLabel(items) {
  return [...items].sort((a, b) =>
    String(a.label || a.name || '').localeCompare(String(b.label || b.name || ''), 'fr', {
      sensitivity: 'base'
    })
  )
}

function toUtcDateTimeParts(value) {
  if (!value) {
    return {
      date: '',
      time: '',
      dateTime: ''
    }
  }

  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return {
      date: '',
      time: '',
      dateTime: ''
    }
  }

  const iso = date.toISOString()
  const datePart = iso.slice(0, 10)
  const timePart = iso.slice(11, 19)
  const visibleTime = timePart === '00:00:00' ? '' : timePart

  return {
    date: datePart,
    time: visibleTime,
    dateTime: visibleTime ? `${datePart} ${visibleTime}` : datePart
  }
}

function decimalToString(value) {
  if (value === null || value === undefined) {
    return ''
  }

  if (typeof value === 'object' && typeof value.toString === 'function') {
    return value.toString()
  }

  return String(value)
}

function getActorName(prefix, row) {
  const socialReason = row[`${prefix}SocialReason`]
  if (socialReason) {
    return socialReason
  }

  return [
    row[`${prefix}FirstName`],
    row[`${prefix}LastName`]
  ].filter(Boolean).join(' ') || row[`${prefix}Email`] || ''
}

function getValueType(metricTypeCode) {
  return parametersConfig[normalizeMetricTypeCode(metricTypeCode)]?.valueType || ''
}

function getValueTypeLabel(metricTypeCode) {
  const valueType = getValueType(metricTypeCode)

  if (valueType === 'cumulative') {
    return 'Cumulée sur période'
  }

  if (valueType === 'instantaneous') {
    return 'Ponctuelle'
  }

  return valueType
}

function isCumulativeValue(metricTypeCode) {
  return getValueType(metricTypeCode) === 'cumulative'
}

function getMetricTypeLabel(metricTypeCode) {
  const normalizedMetricTypeCode = normalizeMetricTypeCode(metricTypeCode)
  return parametersConfig[normalizedMetricTypeCode]?.label || normalizedMetricTypeCode || ''
}

function getUsageColumns(row) {
  if (row.usageKind === 'SUB_USAGE') {
    return {
      usageCode: row.parentUsageCode || '',
      usageLibelle: row.parentUsageLabel || '',
      sousUsageCode: row.usageCode || '',
      sousUsageLibelle: row.usageLabel || ''
    }
  }

  return {
    usageCode: row.usageCode || '',
    usageLibelle: row.usageLabel || '',
    sousUsageCode: '',
    sousUsageLibelle: ''
  }
}

function decimalToExcelValue(value) {
  if (value === null || value === undefined) {
    return ''
  }

  const stringValue = decimalToString(value)
  const numericValue = Number(stringValue)

  return Number.isFinite(numericValue) ? numericValue : stringValue
}

function getVisiblePeriodEnd(periodStart, periodEnd, frequency) {
  if (!periodEnd) {
    return null
  }

  const start = periodStart instanceof Date ? periodStart : new Date(periodStart)
  const end = periodEnd instanceof Date ? new Date(periodEnd) : new Date(periodEnd)
  const dateOnlyFrequencies = new Set(['1 day', '1 week', '1 month', '1 quarter', '1 year'])

  if (
    !Number.isNaN(start.getTime())
    && !Number.isNaN(end.getTime())
    && end > start
    && dateOnlyFrequencies.has(frequency)
  ) {
    end.setUTCDate(end.getUTCDate() - 1)
  }

  return end
}

function getMeasurementAndPeriodColumns(row) {
  if (!isCumulativeValue(row.metricTypeCode)) {
    const measurement = toUtcDateTimeParts(row.periodStart)

    return {
      dateMesure: measurement.date,
      heureMesure: measurement.time,
      dateHeureMesure: measurement.dateTime,
      dateDebutPeriode: '',
      heureDebutPeriode: '',
      dateHeureDebutPeriode: '',
      dateFinPeriode: '',
      heureFinPeriode: '',
      dateHeureFinPeriode: ''
    }
  }

  const periodStart = toUtcDateTimeParts(row.periodStart)
  const periodEnd = toUtcDateTimeParts(getVisiblePeriodEnd(row.periodStart, row.periodEnd, row.frequency))

  return {
    dateMesure: '',
    heureMesure: '',
    dateHeureMesure: '',
    dateDebutPeriode: periodStart.date,
    heureDebutPeriode: periodStart.time,
    dateHeureDebutPeriode: periodStart.dateTime,
    dateFinPeriode: periodEnd.date,
    heureFinPeriode: periodEnd.time,
    dateHeureFinPeriode: periodEnd.dateTime
  }
}

export function rowToExportObject(row) {
  const usageColumns = getUsageColumns(row)
  const measurementAndPeriodColumns = getMeasurementAndPeriodColumns(row)

  return {
    pointPrelevementId: row.pointPrelevementId || '',
    pointPrelevementNom: row.pointPrelevementNom || '',
    fonctionPoint: POINT_FLOW_TYPE_LABELS[row.flowType] || row.flowType || '',
    commune: row.communeName || '',
    codeCommune: row.communeCode || '',
    codeBss: row.codeBSS || '',
    codeOpr: row.codeOPR || '',
    typeMilieu: WATER_BODY_TYPE_LABELS[row.waterBodyType] || row.waterBodyType || '',
    ...usageColumns,
    preleveurId: row.preleveurId || '',
    preleveurNom: getActorName('preleveur', row),
    preleveurEmail: row.preleveurEmail || '',
    collecteurId: row.collecteurId || '',
    collecteurNom: getActorName('collecteur', row),
    collecteurEmail: row.collecteurEmail || '',
    donneeTelerelevee: row.isTelemetry ? 'Oui' : 'Non',
    typeDonnee: getMetricTypeLabel(row.metricTypeCode),
    unite: row.unit || '',
    ...measurementAndPeriodColumns,
    valeur: decimalToExcelValue(row.value),
    remarque: '',
    frequence: row.frequency || '',
    typeValeur: getValueTypeLabel(row.metricTypeCode),
    origineDonnee: DATA_KIND_LABELS[row.valueKind] || row.valueKind || ''
  }
}

async function buildXlsxBuffer(rows) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Partageons l’Eau'
  workbook.created = new Date()

  const worksheet = workbook.addWorksheet('Données', {
    views: [
      {
        state: 'frozen',
        ySplit: 1
      }
    ]
  })

  worksheet.columns = EXPORT_HEADERS.map(header => ({
    header: header.label,
    key: header.key,
    width: Math.min(Math.max(header.label.length + 2, 14), 42)
  }))

  worksheet.getRow(1).font = {bold: true}
  worksheet.getRow(1).alignment = {vertical: 'middle', wrapText: true}
  worksheet.autoFilter = {
    from: {
      row: 1,
      column: 1
    },
    to: {
      row: 1,
      column: EXPORT_HEADERS.length
    }
  }

  worksheet.addRows(rows)
  worksheet.getColumn('valeur').numFmt = '#,##0.########'

  const buffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(buffer)
}

function getZoneIdsSql(zoneIds) {
  return Prisma.join(zoneIds.map(zoneId => Prisma.sql`${zoneId}::uuid`))
}

function getUsageIdsSql(usageIds) {
  return Prisma.join(usageIds.map(usageId => Prisma.sql`${usageId}::uuid`))
}

function getWaterBodyTypesSql(waterBodyTypes) {
  return Prisma.join(waterBodyTypes.map(waterBodyType => Prisma.sql`${waterBodyType}::"WaterBodyType"`))
}

function getCumulativeMetricTypeCodesSql() {
  return Prisma.join(CUMULATIVE_METRIC_TYPE_CODES.map(metricTypeCode => Prisma.sql`${metricTypeCode}`))
}

function getStatusSql() {
  return Prisma.join(
    NON_REJECTED_CHUNK_INSTRUCTION_STATUSES.map(status => Prisma.sql`${status}::"ChunkInstructionStatus"`)
  )
}

function getDateRangeFilterSql({startDate, endExclusive}) {
  return Prisma.sql`
    AND (
      (
        cv."metricTypeCode" IN (${getCumulativeMetricTypeCodesSql()})
        AND cv."periodStart" < ${endExclusive}
        AND cv."periodEnd" > ${startDate}
      )
      OR (
        cv."metricTypeCode" NOT IN (${getCumulativeMetricTypeCodesSql()})
        AND cv."periodStart" >= ${startDate}
        AND cv."periodStart" < ${endExclusive}
      )
    )
  `
}

function getZoneFilterSql({user, selectedZoneIds, allowedZoneIds}) {
  const mustFilterByZone = user.role !== 'ADMIN' || selectedZoneIds.length > 0
  if (!mustFilterByZone) {
    return Prisma.empty
  }

  const zoneIds = selectedZoneIds.length > 0 ? selectedZoneIds : allowedZoneIds
  if (zoneIds.length === 0) {
    return Prisma.sql`AND false`
  }

  return Prisma.sql`
    AND EXISTS (
      SELECT 1
      FROM "PointPrelevementZone" export_ppz
      WHERE export_ppz."pointPrelevementId" = p.id
        AND export_ppz."zoneId" IN (${getZoneIdsSql(zoneIds)})
    )
  `
}

function getUsageFilterSql(usageIds) {
  if (usageIds.length === 0) {
    return Prisma.empty
  }

  return Prisma.sql`
    AND EXISTS (
      SELECT 1
      FROM "DeclarantPointPrelevement" export_dpp
      LEFT JOIN "SandreWaterUse" export_usage ON export_usage.id = export_dpp."usageId"
      WHERE export_dpp."pointPrelevementId" = p.id
        AND (
          export_dpp."usageId" IN (${getUsageIdsSql(usageIds)})
          OR export_usage."parentId" IN (${getUsageIdsSql(usageIds)})
        )
    )
  `
}

function getWaterBodyTypeFilterSql(waterBodyTypes) {
  if (waterBodyTypes.length === 0) {
    return Prisma.empty
  }

  return Prisma.sql`
    AND p."waterBodyType" IN (${getWaterBodyTypesSql(waterBodyTypes)})
  `
}

function normalizeExportFilters(filters = {}) {
  return {
    startDate: filters.startDate,
    endDate: filters.endDate,
    usageIds: getArray(filters.usageIds),
    zoneIds: getArray(filters.zoneIds),
    waterBodyTypes: getArray(filters.waterBodyTypes)
  }
}

function serializeDataExport(dataExport, {downloadUrl = null} = {}) {
  return {
    id: dataExport.id,
    status: dataExport.status,
    filters: normalizeExportFilters(dataExport.filters),
    fileName: dataExport.fileName,
    rowCount: dataExport.rowCount,
    errorMessage: dataExport.errorMessage,
    createdAt: dataExport.createdAt,
    startedAt: dataExport.startedAt,
    completedAt: dataExport.completedAt,
    failedAt: dataExport.failedAt,
    downloadUrl
  }
}

async function getAllowedZonesForUser(user) {
  const permittedZoneIds = await getPermissionZoneIdsForUser(user, 'export.volumes')
  const zoneWhere = {
    id: {in: permittedZoneIds},
    pointPrelevementZones: {
      some: {
        pointPrelevement: {
          deletedAt: null
        }
      }
    }
  }

  const select = {
    id: true,
    type: true,
    code: true,
    name: true
  }

  return prisma.zone.findMany({
    where: zoneWhere,
    select,
    orderBy: [
      {type: 'asc'},
      {name: 'asc'}
    ]
  })
}

async function resolveExportScope({user, filters}) {
  const allowedZones = await getAllowedZonesForUser(user)
  const allowedZoneIds = allowedZones.map(zone => zone.id)
  const allowedZoneIdSet = new Set(allowedZoneIds)
  const requestedZoneIds = [...new Set(filters.zoneIds)]
  const selectedZoneIds = requestedZoneIds.length > 0
    ? requestedZoneIds.filter(zoneId => allowedZoneIdSet.has(zoneId))
    : allowedZoneIds

  return {
    allowedZones,
    allowedZoneIds,
    selectedZoneIds,
    rejectedZoneIds: requestedZoneIds.filter(zoneId => !allowedZoneIdSet.has(zoneId))
  }
}

async function assertDataExportDownloadAccess(user, dataExport) {
  if (user.role === 'ADMIN') {
    return
  }

  const zoneIds = [...new Set(normalizeExportFilters(dataExport.filters).zoneIds)]
  if (zoneIds.length === 0) {
    const error = new Error('Le périmètre de cet ancien export ne peut pas être vérifié. Générez un nouvel export.')
    error.status = 403
    throw error
  }

  const permittedZoneIds = await getPermissionZoneIdsForUser(
    user,
    'export.volumes',
    {zoneIds}
  )

  if (permittedZoneIds.length !== zoneIds.length) {
    const error = new Error('Vous n’avez plus accès à toutes les zones contenues dans cet export.')
    error.status = 403
    throw error
  }
}

async function queryExportRows({user, filters, allowedZoneIds}) {
  const selectedZoneIds = filters.zoneIds
  const startDate = new Date(`${filters.startDate}T00:00:00.000Z`)
  const endExclusive = new Date(`${filters.endDate}T00:00:00.000Z`)
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1)

  return prisma.$queryRaw`
    SELECT
      p.id AS "pointPrelevementId",
      p.name AS "pointPrelevementNom",
      p."communeName" AS "communeName",
      p."communeCode" AS "communeCode",
      p."codeBSS" AS "codeBSS",
      p."codeOPR" AS "codeOPR",
      p."waterBodyType"::text AS "waterBodyType",
      COALESCE(
        c."flowType"::text,
        p."flowType"::text,
        CASE
          WHEN cv."metricTypeCode" = ${LEGACY_METRIC_TYPE_CODES.VOLUME_REJETE} THEN 'REJET'
          WHEN cv."metricTypeCode" IN (
            ${LEGACY_METRIC_TYPE_CODES.VOLUME_PRELEVE},
            ${LEGACY_METRIC_TYPE_CODES.DEBIT_PRELEVE}
          ) THEN 'PRELEVEMENT'
          ELSE NULL
        END
      ) AS "flowType",
      cv."metricTypeCode" AS "metricTypeCode",
      cv.unit AS "unit",
      cv.frequency AS "frequency",
      cv."valueKind"::text AS "valueKind",
      cv."periodStart" AS "periodStart",
      cv."periodEnd" AS "periodEnd",
      cv.value AS "value",
      usage.code AS "usageCode",
      usage.label AS "usageLabel",
      usage.kind::text AS "usageKind",
      parent_usage.code AS "parentUsageCode",
      parent_usage.label AS "parentUsageLabel",
      preleveur."userId" AS "preleveurId",
      preleveur."socialReason" AS "preleveurSocialReason",
      preleveur_user.email AS "preleveurEmail",
      preleveur_user."firstName" AS "preleveurFirstName",
      preleveur_user."lastName" AS "preleveurLastName",
      collecteur."userId" AS "collecteurId",
      collecteur."socialReason" AS "collecteurSocialReason",
      collecteur_user.email AS "collecteurEmail",
      collecteur_user."firstName" AS "collecteurFirstName",
      collecteur_user."lastName" AS "collecteurLastName",
      CASE
        WHEN s.type = 'API' OR declaration."dataSourceType" = 'API' THEN true
        ELSE false
      END AS "isTelemetry"
    FROM "ChunkValue" cv
    INNER JOIN "Chunk" c ON c.id = cv."chunkId"
    INNER JOIN "Source" s ON s.id = c."sourceId"
    INNER JOIN "PointPrelevement" p ON p.id = c."pointPrelevementId"
    INNER JOIN "SandreWaterUse" usage ON usage.id = c."usageId"
    LEFT JOIN "SandreWaterUse" parent_usage ON parent_usage.id = usage."parentId"
    LEFT JOIN "Declaration" declaration ON declaration.id = s."declarationId"
    LEFT JOIN "Declarant" preleveur ON preleveur."userId" = c."preleveurUserId"
    LEFT JOIN "User" preleveur_user ON preleveur_user.id = preleveur."userId"
    LEFT JOIN "Declarant" collecteur ON collecteur."userId" = c."collecteurUserId"
    LEFT JOIN "User" collecteur_user ON collecteur_user.id = collecteur."userId"
    WHERE p."deletedAt" IS NULL
      AND s.status = 'COMPLETED'
      AND c."instructionStatus" IN (${getStatusSql()})
      ${getDateRangeFilterSql({startDate, endExclusive})}
      ${getZoneFilterSql({user, selectedZoneIds, allowedZoneIds})}
      ${getUsageFilterSql(filters.usageIds)}
      ${getWaterBodyTypeFilterSql(filters.waterBodyTypes)}
    ORDER BY p.name ASC, cv."periodStart" ASC, cv."createdAt" ASC, cv.id ASC
  `
}

export async function getDataExportOptions(user) {
  const [zones, waterUses] = await Promise.all([
    getAllowedZonesForUser(user),
    prisma.sandreWaterUse.findMany({
      select: {
        id: true,
        code: true,
        kind: true,
        parentId: true,
        label: true,
        mnemonic: true
      },
      orderBy: [
        {kind: 'asc'},
        {label: 'asc'}
      ]
    })
  ])

  return {
    zones: zones.map(zone => ({
      id: zone.id,
      type: zone.type,
      code: zone.code,
      name: zone.name,
      label: `${zone.name} (${zone.type})`
    })),
    usages: sortByLabel(waterUses.map(waterUse => ({
      id: waterUse.id,
      code: waterUse.code,
      kind: waterUse.kind,
      parentId: waterUse.parentId,
      label: waterUse.label,
      mnemonic: waterUse.mnemonic
    }))),
    waterBodyTypes: Object.entries(WATER_BODY_TYPE_LABELS).map(([value, label]) => ({
      value,
      label
    }))
  }
}

export async function createDataExport({user, filters}) {
  const normalizedFilters = normalizeExportFilters(filters)
  const scope = await resolveExportScope({user, filters: normalizedFilters})

  if (scope.rejectedZoneIds.length > 0) {
    const error = new Error('Une ou plusieurs zones sélectionnées ne sont pas accessibles.')
    error.status = 403
    throw error
  }

  const dataExport = await prisma.dataExport.create({
    data: {
      requestedByUserId: user.id,
      requestedByRole: user.role,
      status: 'PENDING',
      filters: {
        ...normalizedFilters,
        zoneIds: scope.selectedZoneIds
      }
    }
  })

  return serializeDataExport(dataExport)
}

export async function listDataExports(user, {limit = 20} = {}) {
  const dataExports = await prisma.dataExport.findMany({
    where: {
      requestedByUserId: user.id
    },
    orderBy: {
      createdAt: 'desc'
    },
    take: limit
  })

  return dataExports.map(dataExport => serializeDataExport(dataExport))
}

export async function getDataExportForUser(user, dataExportId) {
  const dataExport = await prisma.dataExport.findFirst({
    where: {
      id: dataExportId,
      requestedByUserId: user.id
    }
  })

  return dataExport ? serializeDataExport(dataExport) : null
}

export async function getDataExportDownloadUrl(user, dataExportId) {
  const dataExport = await prisma.dataExport.findFirst({
    where: {
      id: dataExportId,
      requestedByUserId: user.id
    }
  })

  if (!dataExport) {
    return null
  }

  if (dataExport.status !== 'COMPLETED' || !dataExport.storageKey) {
    const error = new Error('Cet export n’est pas encore disponible.')
    error.status = 409
    throw error
  }

  await assertDataExportDownloadAccess(user, dataExport)

  const storage = createStorageClient(DATA_EXPORTS_BUCKET)
  const downloadUrl = await storage.getPresignedUrl(dataExport.storageKey, {
    filename: dataExport.fileName || 'export-donnees.xlsx',
    type: XLSX_CONTENT_TYPE
  })

  return serializeDataExport(dataExport, {downloadUrl})
}

export async function deleteDataExport(user, dataExportId) {
  const dataExport = await prisma.dataExport.findFirst({
    where: {
      id: dataExportId,
      requestedByUserId: user.id
    }
  })

  if (!dataExport) {
    return null
  }

  if (['PENDING', 'PROCESSING'].includes(dataExport.status)) {
    const error = new Error('Cet export est en cours de traitement et ne peut pas encore être supprimé.')
    error.status = 409
    throw error
  }

  if (dataExport.storageKey) {
    await createStorageClient(DATA_EXPORTS_BUCKET).deleteObject(dataExport.storageKey, true)
  }

  await prisma.dataExport.delete({
    where: {
      id: dataExport.id
    }
  })

  return serializeDataExport(dataExport)
}

export async function processDataExport(dataExportId, logger = console) {
  const dataExport = await prisma.dataExport.findUnique({
    where: {id: dataExportId},
    include: {
      requestedBy: true
    }
  })

  if (!dataExport) {
    throw new Error(`Export introuvable: ${dataExportId}`)
  }

  if (!['PENDING', 'FAILED'].includes(dataExport.status)) {
    logger.log(`[data-export] export ${dataExportId} ignoré: status=${dataExport.status}`)
    return serializeDataExport(dataExport)
  }

  await prisma.dataExport.update({
    where: {id: dataExport.id},
    data: {
      status: 'PROCESSING',
      startedAt: new Date(),
      failedAt: null,
      errorMessage: null
    }
  })

  try {
    const filters = normalizeExportFilters(dataExport.filters)
    const {requestedBy} = dataExport
    const scope = await resolveExportScope({user: requestedBy, filters})
    if (scope.rejectedZoneIds.length > 0) {
      const error = new Error('L’accès à une ou plusieurs zones de cet export a été retiré avant son traitement.')
      error.status = 403
      throw error
    }

    const effectiveFilters = {
      ...filters,
      zoneIds: scope.selectedZoneIds
    }
    await prisma.dataExport.update({
      where: {id: dataExport.id},
      data: {filters: effectiveFilters}
    })
    const rows = await queryExportRows({
      user: requestedBy,
      filters: effectiveFilters,
      allowedZoneIds: scope.allowedZoneIds
    })

    const exportRows = rows.map(rowToExportObject)
    const xlsxBuffer = await buildXlsxBuffer(exportRows)
    const timestamp = new Date().toISOString().replaceAll(/[-:]/g, '').slice(0, 15)
    const fileName = `export-donnees-${timestamp}.xlsx`
    const storageKey = `exports/${dataExport.id}/${randomUUID()}-${fileName}`

    await createStorageClient(DATA_EXPORTS_BUCKET).uploadObject(
      storageKey,
      xlsxBuffer,
      {
        filename: fileName,
        type: XLSX_CONTENT_TYPE
      }
    )

    const completed = await prisma.dataExport.update({
      where: {id: dataExport.id},
      data: {
        status: 'COMPLETED',
        fileName,
        storageKey,
        rowCount: exportRows.length,
        completedAt: new Date(),
        failedAt: null,
        errorMessage: null
      }
    })

    logger.log(`[data-export] export ${dataExport.id} terminé: rows=${exportRows.length}`)
    return serializeDataExport(completed)
  } catch (error) {
    await prisma.dataExport.update({
      where: {id: dataExport.id},
      data: {
        status: 'FAILED',
        failedAt: new Date(),
        errorMessage: error instanceof Error ? error.message : String(error)
      }
    })

    throw error
  }
}
