/* eslint-disable no-await-in-loop -- Export cursors, committed rows and file writes are deliberately sequential and bounded. */
import {NATIVE_TIME_ZONE, isNativeTemporal, nativeDateTimeParts} from '../util/native-temporal.js'
import {randomUUID} from 'node:crypto'
import {Buffer} from 'node:buffer'
import {createReadStream, createWriteStream} from 'node:fs'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {setImmediate} from 'node:timers/promises'

import {Prisma} from '@prisma/client'
import ExcelJS from 'exceljs'
import pg from 'pg'

import {prisma, pgPool} from '../../db/prisma.js'
import {NON_REJECTED_CHUNK_INSTRUCTION_STATUSES} from '../constants/chunk-statuses.js'
import {parametersConfig} from '../parameters-config.js'
import {
  LEGACY_METRIC_TYPE_CODES,
  getCompatibleMetricTypeCodes,
  normalizeMetricTypeCode
} from '../constants/metric-type-codes.js'
import createStorageClient from '../util/s3.js'
import {
  getAccessibleSandreZones,
  getSandreZoneFilterSql,
  toSandreZoneOption
} from './sandre-alert-zone-query.js'
import {getPermissionZoneIdsForUser} from './zone-permissions.js'
import {CHUNK_VALUE_SUMMARY_VERSION} from './chunk-value-summaries.js'

export const DATA_EXPORTS_BUCKET = 'exports'
export const MAX_NATIVE_EXPORT_VALUES = 100_000
const EXPORT_BATCH_SIZE = 500
const MAX_EXCEL_DATA_ROWS = 1_048_575

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

const POINT_ORIGIN_LABELS = {
  NAPPE: 'Nappe',
  NAPPE_ACCOMPAGNEMENT: 'Nappe d’accompagnement',
  COURS_EAU: 'Cours d’eau',
  SOURCE: 'Source',
  PLAN_EAU: 'Plan d’eau'
}

const POINT_WITHDRAWAL_TYPE_LABELS = {
  LITTORAL: 'Littoral',
  CONTINENTAL: 'Continental',
  SOUTERRAIN: 'Souterrain',
  STOCKAGE: 'Stockage'
}

const CUMULATIVE_METRIC_TYPE_CODES = Object.entries(parametersConfig)
  .filter(([, config]) => config.valueType === 'cumulative')
  .flatMap(([metricTypeCode]) => getCompatibleMetricTypeCodes(metricTypeCode))

const EXPORT_HEADERS = [
  {key: 'pointPrelevementId', label: 'ID du point'},
  {key: 'pointPrelevementNom', label: 'Nom du point'},
  {key: 'fonctionPoint', label: 'Type de point'},
  {key: 'originePoint', label: 'Origine prélèvement / rejet'},
  {key: 'typePrelevementRejet', label: 'Type prélèvement / rejet'},
  {key: 'commune', label: 'Commune'},
  {key: 'codeCommune', label: 'Code commune'},
  {key: 'codeBss', label: 'Code BSS'},
  {key: 'codeOpr', label: 'Code OPR'},
  {key: 'typeMilieu', label: 'Type de milieu'},
  {key: 'zre', label: 'ZRE'},
  {key: 'usageCode', label: 'Code usage SANDRE'},
  {key: 'usageLibelle', label: 'Usage SANDRE'},
  {key: 'sousUsageCode', label: 'Code sous-usage SANDRE'},
  {key: 'sousUsageLibelle', label: 'Sous-usage SANDRE'},
  {key: 'preleveurId', label: 'ID du préleveur'},
  {key: 'preleveurNom', label: 'Nom du préleveur'},
  {key: 'preleveurEmail', label: 'Email du préleveur'},
  {key: 'exploitationId', label: 'ID de l’exploitation'},
  {key: 'countingCode', label: 'Code comptage'},
  {key: 'collecteurId', label: 'ID du collecteur'},
  {key: 'collecteurNom', label: 'Nom du collecteur'},
  {key: 'collecteurEmail', label: 'Email du collecteur'},
  {key: 'compteurId', label: 'ID du compteur'},
  {key: 'numeroCompteur', label: 'Numéro du compteur'},
  {key: 'identifiantCompteur', label: 'Identifiant du compteur'},
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
  {key: 'origineDonnee', label: 'Origine de la donnée'},
  {key: 'fuseauHoraire', label: 'Fuseau horaire'},
  {key: 'borneFinExclusive', label: 'Borne de fin exclusive'}
]

const METER_READING_HEADERS = [
  {key: 'readingId', label: 'ID du relevé'},
  {key: 'meterId', label: 'ID du compteur'},
  {key: 'serialNumber', label: 'Numéro du compteur'},
  {key: 'identifier', label: 'Identifiant du compteur'},
  {key: 'pointIds', label: 'IDs des points du périmètre'},
  {key: 'pointNames', label: 'Points associés dans le périmètre'},
  {key: 'observedAt', label: 'Date et heure exactes (UTC)'},
  {key: 'localDateTime', label: 'Date et heure (Europe/Paris)'},
  {key: 'index', label: 'Index du compteur (m³)'},
  {key: 'status', label: 'État du relevé'},
  {key: 'quality', label: 'Qualité fournie'},
  {key: 'origin', label: 'Origine fournie'},
  {key: 'reason', label: 'Motif d’exclusion'},
  {key: 'scope', label: 'Portée de l’index'}
]

export function assertMeterReadingExportAccess(user, filters) {
  if (filters.includeMeterReadings && user?.role !== 'ADMIN') {
    const error = new Error('L’export des index physiques des compteurs est réservé aux administrateurs.')
    error.status = 403
    throw error
  }
}

export function meterReadingToExportObject(row) {
  return {
    readingId: row.readingId,
    meterId: row.meterId,
    serialNumber: row.serialNumber ?? '',
    identifier: row.identifier ?? '',
    pointIds: row.pointIds,
    pointNames: row.pointNames,
    observedAt: new Date(row.observedAt).toISOString(),
    localDateTime: row.localDateTime,
    // Keep the exact decimal as text: Excel numbers have only 15 significant digits.
    index: decimalToString(row.index),
    status: row.admissible ? 'Utilisable' : 'Exclu',
    quality: row.quality ?? '',
    origin: row.origin ?? '',
    reason: row.reason ?? '',
    scope: 'Index physique du compteur, non réparti entre les exploitations'
  }
}

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

const meterDateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
})

function toMeterDateTimeParts(value) {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return {date: '', time: '', dateTime: ''}

  const parts = Object.fromEntries(meterDateTimeFormatter.formatToParts(date).map(part => [part.type, part.value]))
  const datePart = `${parts.year}-${parts.month}-${parts.day}`
  const milliseconds = date.getUTCMilliseconds()
  const time = `${parts.hour}:${parts.minute}:${parts.second}${milliseconds ? `.${String(milliseconds).padStart(3, '0')}` : ''}`
  return {date: datePart, time, dateTime: `${datePart} ${time}`}
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

function getMappedLabel(labels, value) {
  return value ? (labels[value] ?? value) : ''
}

function formatNullableBoolean(value) {
  if (value === true) {
    return 'Oui'
  }

  if (value === false) {
    return 'Non'
  }

  return 'Non renseigné'
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
  // Physical intervals contain instants; legacy calendar measures keep their
  // existing representation. Do not reinterpret them as Paris instants.
  const exactMeterInterval = row.calculationStrategy === 'METER' && row.frequency === 'irregular'
  const native = isNativeTemporal(row.chunkMetadata)
  const formatPeriod = native ? nativeDateTimeParts : exactMeterInterval ? toMeterDateTimeParts : toUtcDateTimeParts
  const hasInterval = native ? new Date(row.periodEnd) > new Date(row.periodStart) : isCumulativeValue(row.metricTypeCode)
  if (!hasInterval) {
    const measurement = formatPeriod(row.periodStart)

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

  const periodStart = formatPeriod(row.periodStart)
  const periodEnd = formatPeriod(native ? row.periodEnd : getVisiblePeriodEnd(row.periodStart, row.periodEnd, row.frequency))

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
    fonctionPoint: getMappedLabel(POINT_FLOW_TYPE_LABELS, row.flowType),
    originePoint: getMappedLabel(POINT_ORIGIN_LABELS, row.nature),
    typePrelevementRejet: getMappedLabel(POINT_WITHDRAWAL_TYPE_LABELS, row.withdrawalType),
    commune: row.communeName || '',
    codeCommune: row.communeCode || '',
    codeBss: row.codeBSS || '',
    codeOpr: row.codeOPR || '',
    typeMilieu: getMappedLabel(WATER_BODY_TYPE_LABELS, row.waterBodyType),
    zre: formatNullableBoolean(row.isZre),
    ...usageColumns,
    preleveurId: row.preleveurId || '',
    preleveurNom: getActorName('preleveur', row),
    preleveurEmail: row.preleveurEmail || '',
    exploitationId: row.exploitationId || '',
    countingCode: row.countingCode ?? '',
    collecteurId: row.collecteurId || '',
    collecteurNom: getActorName('collecteur', row),
    collecteurEmail: row.collecteurEmail || '',
    compteurId: row.compteurId || '',
    numeroCompteur: row.serialNumber || '',
    identifiantCompteur: row.identifier || '',
    donneeTelerelevee: row.isTelemetry ? 'Oui' : 'Non',
    typeDonnee: getMetricTypeLabel(row.metricTypeCode),
    unite: row.unit || '',
    ...measurementAndPeriodColumns,
    valeur: isNativeTemporal(row.chunkMetadata) ? decimalToString(row.value) : decimalToExcelValue(row.value),
    remarque: row.remark ?? '',
    frequence: row.frequency || '',
    typeValeur: isNativeTemporal(row.chunkMetadata)
      ? ({cumulative: 'Cumulée sur période', instantaneous: 'Ponctuelle', average: 'Moyenne', minimum: 'Minimum', maximum: 'Maximum', median: 'Médiane', 'delta-index': 'Différence d’index', raw: 'Autre'}[row.chunkMetadata.valueType] ?? row.chunkMetadata.valueType ?? '')
      : getValueTypeLabel(row.metricTypeCode),
    fuseauHoraire: isNativeTemporal(row.chunkMetadata) ? NATIVE_TIME_ZONE : row.calculationStrategy === 'METER' && row.frequency === 'irregular' ? 'Europe/Paris' : '',
    borneFinExclusive: isNativeTemporal(row.chunkMetadata) && new Date(row.periodEnd) > new Date(row.periodStart) ? 'Oui' : '',
    origineDonnee: row.calculationStrategy === 'METER'
      ? 'Calculée à partir des index du compteur'
      : getMappedLabel(DATA_KIND_LABELS, row.valueKind)
  }
}

export async function buildXlsxBuffer(rows, {meterRows = null} = {}) {
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

  if (meterRows !== null) {
    const meterSheet = workbook.addWorksheet('Index des compteurs', {views: [{state: 'frozen', ySplit: 1}]})
    meterSheet.columns = METER_READING_HEADERS.map(header => ({
      header: header.label, key: header.key, width: Math.min(Math.max(header.label.length + 2, 18), 48)
    }))
    meterSheet.getRow(1).font = {bold: true}
    meterSheet.getRow(1).alignment = {vertical: 'middle', wrapText: true}
    meterSheet.autoFilter = {from: {row: 1, column: 1}, to: {row: 1, column: METER_READING_HEADERS.length}}
    meterSheet.addRows(meterRows)
    meterSheet.getColumn('index').numFmt = '@'
  }

  const buffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(buffer)
}

// The worker writes committed rows to disk instead of retaining the SQL result,
// Excel's complete cell model and the compressed XLSX buffer at the same time.
export async function buildXlsxFile(rows, filename, {meterRows = null} = {}) {
  const stream = createWriteStream(filename, {mode: 0o600})
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({stream, useStyles: true, useSharedStrings: false})
  workbook.creator = 'Partageons l’Eau'
  workbook.created = new Date()
  let streamError
  stream.on('error', error => { streamError = error })
  workbook.zip.on('error', error => { streamError = error })
  const drainWorksheet = async sheet => {
    // ExcelJS 4's StreamBuf.write() ignores the downstream write result. Wait
    // for its ZIP destination to consume the preceding batch, otherwise native
    // buffers can grow even though rows and the JavaScript heap stay bounded.
    while (sheet.stream.pipes.length === 0) {
      if (streamError) throw streamError
      await setImmediate()
    }
    await Promise.all(sheet.stream.pipes.map(destination => new Promise((resolve, reject) => {
      destination.write(Buffer.alloc(0), error => error ? reject(error) : resolve())
    })))
    if (streamError) throw streamError
  }
  const appendSheet = async (name, headers, values, numberColumn, numFmt) => {
    const sheet = workbook.addWorksheet(name, {views: [{state: 'frozen', ySplit: 1}]})
    sheet.columns = headers.map(header => ({
      header: header.label, key: header.key, width: Math.min(Math.max(header.label.length + 2, 14), 42)
    }))
    sheet.getRow(1).font = {bold: true}
    sheet.getRow(1).alignment = {vertical: 'middle', wrapText: true}
    sheet.autoFilter = {from: {row: 1, column: 1}, to: {row: 1, column: headers.length}}
    sheet.getColumn(numberColumn).numFmt = numFmt
    sheet.getRow(1).commit()
    let count = 0
    for await (const row of values) {
      if (++count > MAX_EXCEL_DATA_ROWS) {
        throw new Error('Cet export dépasse la capacité d’une feuille Excel. Réduisez la période ou le périmètre de l’export.')
      }
      if (streamError) throw streamError
      sheet.addRow(row).commit()
      // Let compression, file writes and BullMQ lock renewal progress together.
      if (count % EXPORT_BATCH_SIZE === 0) await drainWorksheet(sheet)
    }
    sheet.commit()
    return count
  }
  try {
    let rowCount = await appendSheet('Données', EXPORT_HEADERS, rows, 'valeur', '#,##0.########')
    if (meterRows !== null) {
      rowCount += await appendSheet('Index des compteurs', METER_READING_HEADERS, meterRows, 'index', '@')
    }
    await workbook.commit()
    if (streamError) throw streamError
    return rowCount
  } catch (error) {
    workbook.zip.abort()
    stream.destroy()
    throw error
  }
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
  // Legacy measures use calendar timestamps. Physical-meter intervals instead
  // contain exact UTC instants and must overlap the selected Paris calendar days.
  const exactMeterInterval = Prisma.sql`(c."calculationStrategy" = 'METER' AND cv.frequency = 'irregular')`
  const native = Prisma.sql`(COALESCE(c.metadata->>'nativeTemporal', 'false') = 'true')`
  const nativeStart = Prisma.sql`((${startDate.toISOString().slice(0, 10)}::timestamp AT TIME ZONE 'Indian/Reunion') AT TIME ZONE 'UTC')`
  const nativeEnd = Prisma.sql`((${endExclusive.toISOString().slice(0, 10)}::timestamp AT TIME ZONE 'Indian/Reunion') AT TIME ZONE 'UTC')`
  const meterStart = Prisma.sql`((${startDate.toISOString().slice(0, 10)}::timestamp AT TIME ZONE 'Europe/Paris') AT TIME ZONE 'UTC')`
  const meterEnd = Prisma.sql`((${endExclusive.toISOString().slice(0, 10)}::timestamp AT TIME ZONE 'Europe/Paris') AT TIME ZONE 'UTC')`
  return Prisma.sql`
    AND (
      (${exactMeterInterval} AND cv."periodStart" < ${meterEnd} AND cv."periodEnd" > ${meterStart})
      OR (${native} AND cv."periodStart" < ${nativeEnd} AND (
        cv."periodEnd" > ${nativeStart}
        OR (cv."periodEnd" = cv."periodStart" AND cv."periodStart" >= ${nativeStart})
      ))
      OR (NOT ${native} AND NOT ${exactMeterInterval} AND (
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
      ))
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

export function getUsageFilterSql(usageIds) {
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
          OR EXISTS (
            SELECT 1
            FROM "DeclarantPointPrelevementSecondaryUsage" export_secondary_usage_link
            JOIN "SandreWaterUse" export_secondary_usage
              ON export_secondary_usage.id = export_secondary_usage_link."usageId"
            WHERE export_secondary_usage_link."exploitationId" = export_dpp.id
              AND (
                export_secondary_usage_link."usageId" IN (${getUsageIdsSql(usageIds)})
                OR export_secondary_usage."parentId" IN (${getUsageIdsSql(usageIds)})
              )
          )
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

export function normalizeExportFilters(filters = {}) {
  return {
    startDate: filters.startDate,
    endDate: filters.endDate,
    includeMeterReadings: filters.includeMeterReadings === true,
    usageIds: getArray(filters.usageIds),
    zoneIds: getArray(filters.zoneIds),
    sandreZoneIds: getArray(filters.sandreZoneIds),
    sandreZones: getArray(filters.sandreZones),
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

async function resolveExportScope({user, filters, validateSandreSelection = true}) {
  const allowedZones = await getAllowedZonesForUser(user)
  const allowedZoneIds = allowedZones.map(zone => zone.id)
  const allowedZoneIdSet = new Set(allowedZoneIds)
  const requestedZoneIds = [...new Set(filters.zoneIds)]
  const selectedZoneIds = requestedZoneIds.length > 0
    ? requestedZoneIds.filter(zoneId => allowedZoneIdSet.has(zoneId))
    : allowedZoneIds
  const requestedSandreZoneIds = validateSandreSelection
    ? [...new Set(filters.sandreZoneIds)]
    : []
  const selectedSandreZones = validateSandreSelection
    ? await getAccessibleSandreZones({
      user,
      allowedZoneIds,
      sandreZoneIds: requestedSandreZoneIds
    })
    : []
  const selectedSandreZoneIdSet = new Set(selectedSandreZones.map(zone => zone.id))

  return {
    allowedZones,
    allowedZoneIds,
    selectedZoneIds,
    rejectedZoneIds: requestedZoneIds.filter(zoneId => !allowedZoneIdSet.has(zoneId)),
    selectedSandreZones,
    rejectedSandreZoneIds: requestedSandreZoneIds.filter(
      sandreZoneId => !selectedSandreZoneIdSet.has(sandreZoneId)
    )
  }
}

async function assertDataExportDownloadAccess(user, dataExport) {
  assertMeterReadingExportAccess(user, normalizeExportFilters(dataExport.filters))
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

function buildExportRowsScopeSql({user, filters, allowedZoneIds}) {
  const startDate = new Date(`${filters.startDate}T00:00:00.000Z`)
  const endExclusive = new Date(`${filters.endDate}T00:00:00.000Z`)
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1)
  return Prisma.sql`
    FROM "Chunk" c
    INNER JOIN "Source" s ON s.id = c."sourceId"
    LEFT JOIN "ChunkValueSummary" export_summary ON export_summary."chunkId" = c.id
      AND export_summary.valid AND export_summary."formatVersion" = ${CHUNK_VALUE_SUMMARY_VERSION}
    LEFT JOIN "Compteur" compteur ON compteur.id = c."compteurId"
    LEFT JOIN "DeclarantPointPrelevement" exploitation ON exploitation.id = c."exploitationId"
    INNER JOIN "PointPrelevement" p ON p.id = c."pointPrelevementId"
    INNER JOIN "SandreWaterUse" usage ON usage.id = c."usageId"
    LEFT JOIN "SandreWaterUse" parent_usage ON parent_usage.id = usage."parentId"
    LEFT JOIN "Declaration" declaration ON declaration.id = s."declarationId"
    LEFT JOIN "Declarant" preleveur ON preleveur."userId" = c."preleveurUserId"
    LEFT JOIN "User" preleveur_user ON preleveur_user.id = preleveur."userId"
    LEFT JOIN "Declarant" collecteur ON collecteur."userId" = c."collecteurUserId"
    LEFT JOIN "User" collecteur_user ON collecteur_user.id = collecteur."userId"
    JOIN LATERAL (
      SELECT cv.* FROM "ChunkValue" cv
      WHERE cv."chunkId" = c.id
        ${getDateRangeFilterSql({startDate, endExclusive})}
      -- Keep this correlated lookup: flattening it scans every territory's values.
      OFFSET 0
    ) cv ON true
    WHERE p."deletedAt" IS NULL
      AND s.status = 'COMPLETED'
      AND c."instructionStatus" IN (${getStatusSql()})
      -- Conservative prefilter only: exact legacy/Paris/Reunion bounds stay below.
      -- Missing or invalid summaries always fall back to the indexed values.
      AND (export_summary."chunkId" IS NULL OR EXISTS (
        SELECT 1 FROM jsonb_to_recordset(export_summary.groups) AS g(
          "minPeriodStart" timestamp, "maxPeriodStart" timestamp, "maxPeriodEnd" timestamp
        )
        WHERE g."minPeriodStart" < ${endExclusive}
          AND GREATEST(g."maxPeriodStart", g."maxPeriodEnd") >= ${startDate}::timestamp - interval '1 day'
      ))
      ${getZoneFilterSql({user, selectedZoneIds: filters.zoneIds, allowedZoneIds})}
      ${getUsageFilterSql(filters.usageIds)}
      ${getWaterBodyTypeFilterSql(filters.waterBodyTypes)}
      ${getSandreZoneFilterSql(filters.sandreZoneIds)}
  `
}

// Count only native values, with exactly the same joins, dates and permissions
// as the export below. Legacy exports keep their existing behavior.
export async function countNativeExportRows({client = prisma, ...options}) {
  const [result] = await client.$queryRaw`
    SELECT COUNT(*)::bigint AS count
    ${buildExportRowsScopeSql(options)}
      AND c.metadata->>'nativeTemporal' = 'true'
  `
  return Number(result?.count ?? 0)
}

export async function queryExportRows({client = prisma, ...options}) {
  const nativeCount = await countNativeExportRows({...options, client})
  if (nativeCount > MAX_NATIVE_EXPORT_VALUES) {
    const error = new Error('Cet export dépasse 100 000 valeurs importées. Réduisez la période ou le périmètre de l’export.')
    error.status = 400
    throw error
  }

  return client.$queryRaw`${buildExportRowsQuery(options)}`
}

function buildExportRowsQuery(options) {
  return Prisma.sql`
    SELECT
      p.id AS "pointPrelevementId",
      p.name AS "pointPrelevementNom",
      p."communeName" AS "communeName",
      p."communeCode" AS "communeCode",
      p."codeBSS" AS "codeBSS",
      p."codeOPR" AS "codeOPR",
      p."waterBodyType"::text AS "waterBodyType",
      p.nature::text AS "nature",
      p."withdrawalType"::text AS "withdrawalType",
      p."isZre" AS "isZre",
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
      cv.remark AS "remark",
      jsonb_build_object('nativeTemporal', c.metadata->'nativeTemporal',
        'valueType', c.metadata->'valueType') AS "chunkMetadata",
      c."compteurId" AS "compteurId",
      c."exploitationId" AS "exploitationId",
      exploitation."countingCode" AS "countingCode",
      compteur."serialNumber" AS "serialNumber",
      compteur.identifier AS "identifier",
      c."calculationStrategy"::text AS "calculationStrategy",
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
    ${buildExportRowsScopeSql(options)}
    ORDER BY p.name ASC, cv."periodStart" ASC, cv."createdAt" ASC, cv.id ASC
  `
}

export async function queryMeterReadingExportRows({client = prisma, ...options}) {
  assertMeterReadingExportAccess(options.user, {includeMeterReadings: true})
  return client.$queryRaw`${buildMeterReadingExportQuery(options)}`
}

function buildMeterReadingExportQuery({user, filters, allowedZoneIds}) {
  return Prisma.sql`
    WITH scoped_points AS (
      SELECT DISTINCT a."compteurId", p.id, COALESCE(p.name, p.id::text) AS name
      FROM "MeterAllocation" a
      JOIN "DeclarantPointPrelevement" exploitation ON exploitation.id = a."exploitationId"
      JOIN "User" preleveur ON preleveur.id = exploitation."declarantUserId"
      JOIN "PointPrelevement" p ON p.id = exploitation."pointPrelevementId"
      JOIN "Compteur" compteur ON compteur.id = a."compteurId"
      WHERE p."deletedAt" IS NULL AND preleveur."deletedAt" IS NULL AND compteur."deletedAt" IS NULL
        ${getZoneFilterSql({user, selectedZoneIds: filters.zoneIds, allowedZoneIds})}
        ${getUsageFilterSql(filters.usageIds)}
        ${getWaterBodyTypeFilterSql(filters.waterBodyTypes)}
        ${getSandreZoneFilterSql(filters.sandreZoneIds)}
    ), scoped_meters AS (
      SELECT "compteurId", string_agg(id::text, '; ' ORDER BY id) AS "pointIds",
        string_agg(name, '; ' ORDER BY id) AS "pointNames"
      FROM scoped_points GROUP BY "compteurId"
    )
    SELECT r.id AS "readingId", r."compteurId" AS "meterId", compteur."serialNumber", compteur.identifier,
      scoped_meters."pointIds", scoped_meters."pointNames", r."observedAt",
      to_char(r."observedAt" AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD HH24:MI:SS.MS') AS "localDateTime",
      revision.index::text AS index, revision.admissible, revision.quality, revision.origin, revision.reason
    FROM "MeterReading" r
    JOIN scoped_meters ON scoped_meters."compteurId" = r."compteurId"
    JOIN "Compteur" compteur ON compteur.id = r."compteurId"
    JOIN "MeterReadingRevision" revision ON revision.id = r."currentRevisionId"
    WHERE r."observedAt" >= (${filters.startDate}::date::timestamp AT TIME ZONE 'Europe/Paris')
      AND r."observedAt" < ((${filters.endDate}::date + 1)::timestamp AT TIME ZONE 'Europe/Paris')
    ORDER BY compteur."serialNumber" NULLS LAST, compteur.id, r."observedAt", r.id
  `
}

async function* iterateQueryRows(client, query) {
  const cursor = Prisma.raw(`"export_${randomUUID().replaceAll('-', '')}"`)
  await client.$executeRaw`DECLARE ${cursor} NO SCROLL CURSOR FOR ${query}`
  let failed = false
  try {
    while (true) {
      // The count is a constant, never a request parameter or unbounded result.
      const batch = await client.$queryRaw`FETCH FORWARD 500 FROM ${cursor}`
      if (batch.length === 0) break
      yield* batch
    }
  } catch (error) {
    failed = true
    throw error
  } finally {
    try {
      await client.$executeRaw`CLOSE ${cursor}`
    } catch (error) {
      // A failed SQL statement can already have aborted this transaction.
      // eslint-disable-next-line no-unsafe-finally -- A primary failure is never replaced by a close failure.
      if (!failed) throw error
    }
  }
}

export async function* iterateExportRows({client, ...options}) {
  const nativeCount = await countNativeExportRows({...options, client})
  if (nativeCount > MAX_NATIVE_EXPORT_VALUES) {
    const error = new Error('Cet export dépasse 100 000 valeurs importées. Réduisez la période ou le périmètre de l’export.')
    error.status = 400
    throw error
  }
  for await (const row of iterateQueryRows(client, buildExportRowsQuery(options))) yield rowToExportObject(row)
}

async function* iterateMeterReadingRows({client, ...options}) {
  assertMeterReadingExportAccess(options.user, {includeMeterReadings: true})
  for await (const row of iterateQueryRows(client, buildMeterReadingExportQuery(options))) yield meterReadingToExportObject(row)
}

export async function getDataExportOptions(user) {
  const zones = await getAllowedZonesForUser(user)
  const allowedZoneIds = zones.map(zone => zone.id)
  const [sandreZones, waterUses] = await Promise.all([
    getAccessibleSandreZones({user, allowedZoneIds}),
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
    canExportMeterReadings: user.role === 'ADMIN',
    sandreZones: sandreZones.map(toSandreZoneOption),
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
  assertMeterReadingExportAccess(user, normalizedFilters)
  const scope = await resolveExportScope({user, filters: normalizedFilters})

  if (scope.rejectedZoneIds.length > 0) {
    const error = new Error('Une ou plusieurs zones sélectionnées ne sont pas accessibles.')
    error.status = 403
    throw error
  }

  if (scope.rejectedSandreZoneIds.length > 0) {
    const error = new Error('Une ou plusieurs zones SANDRE sélectionnées ne sont pas accessibles.')
    error.status = 403
    throw error
  }

  const sandreZones = scope.selectedSandreZones.map(toSandreZoneOption)

  const dataExport = await prisma.dataExport.create({
    data: {
      requestedByUserId: user.id,
      requestedByRole: user.role,
      status: 'PENDING',
      filters: {
        ...normalizedFilters,
        zoneIds: scope.selectedZoneIds,
        sandreZoneIds: sandreZones.map(zone => zone.id),
        sandreZones
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

// pg returns timestamp-without-time-zone using the process timezone by default.
// Export instants are UTC even if a worker's TZ differs from the API's timezone.
function exportCursorClient(connection) {
  const run = async (...args) => {
    const query = Prisma.sql(...args)
    return connection.query({text: query.text,
      values: query.values.map(value => value instanceof Date ? value.toISOString() : value),
      types: {getTypeParser: (oid, format) => oid === 1114 && format !== 'binary'
        ? value => new Date(value.replace(' ', 'T') + 'Z')
        : oid === 1700 && format !== 'binary'
          ? value => new Prisma.Decimal(value)
          : pg.types.getTypeParser(oid, format)}
    })
  }
  return {
    $executeRaw: async (...args) => (await run(...args)).rowCount,
    $queryRaw: async (...args) => (await run(...args)).rows
  }
}

export async function processDataExport(dataExportId, logger = console, {
  client = prisma, pool = pgPool, storageClientFactory = createStorageClient
} = {}) {
  const connection = await pool.connect()
  const lockKey = 'data-export:' + dataExportId
  let acquired = false
  let transactionOpen = false
  let connectionError
  let input
  let temporaryDirectory
  let storage
  let storageKey
  let uploadStarted = false
  let published = false
  let attemptStartedAt
  const onConnectionError = error => {
    connectionError = error
    input?.destroy(error)
  }
  connection.on('error', onConnectionError)
  try {
    const lock = await connection.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [lockKey])
    acquired = lock.rows[0].acquired
    if (!acquired) throw new Error('Cet export est déjà en cours de traitement.')
    // Read after acquiring the lock, outside the subsequent repeatable snapshot.
    const dataExport = await client.dataExport.findUnique({where: {id: dataExportId}, include: {requestedBy: true}})
    if (!dataExport) throw new Error(`Export introuvable: ${dataExportId}`)
    if (dataExport.status === 'COMPLETED') return serializeDataExport(dataExport)
    const startedAt = new Date()
    // Claim through the connection holding the lock: a disconnected old worker
    // cannot overwrite a successor through another connection in the pool.
    const claim = await connection.query(`UPDATE "DataExport" SET status='PROCESSING', "startedAt"=$2,
      "failedAt"=NULL, "errorMessage"=NULL, "updatedAt"=CURRENT_TIMESTAMP
      WHERE id=$1::uuid AND status<>'COMPLETED' RETURNING id`, [dataExport.id, startedAt.toISOString()])
    if (claim.rowCount !== 1) throw new Error('Cet export a été repris par un autre traitement.')
    attemptStartedAt = startedAt
    const ownedAttempt = {id: dataExport.id, status: 'PROCESSING', startedAt: attemptStartedAt}
    const filters = normalizeExportFilters(dataExport.filters)
    const {requestedBy} = dataExport
    assertMeterReadingExportAccess(requestedBy, filters)
    const scope = await resolveExportScope({user: requestedBy, filters, validateSandreSelection: false})
    if (scope.rejectedZoneIds.length > 0) {
      const error = new Error('L’accès à une ou plusieurs zones de cet export a été retiré avant son traitement.')
      error.status = 403
      throw error
    }
    const effectiveFilters = {...filters, zoneIds: scope.selectedZoneIds}
    const filtered = await client.dataExport.updateMany({where: ownedAttempt, data: {filters: effectiveFilters}})
    if (filtered.count !== 1 || connectionError) throw connectionError ?? new Error('Cet export a été repris par un autre traitement.')
    storage = storageClientFactory(DATA_EXPORTS_BUCKET)
    if (dataExport.storageKey) await storage.deleteObject(dataExport.storageKey, true)
    await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    transactionOpen = true
    const options = {user: requestedBy, filters: effectiveFilters, allowedZoneIds: scope.allowedZoneIds,
      client: exportCursorClient(connection)}
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'pe-data-export-'))
    const filename = path.join(temporaryDirectory, 'data.xlsx')
    const rowCount = await buildXlsxFile(iterateExportRows(options), filename, {
      meterRows: filters.includeMeterReadings ? iterateMeterReadingRows(options) : null
    })
    await connection.query('COMMIT')
    transactionOpen = false
    if (connectionError) throw connectionError
    const timestamp = new Date().toISOString().replaceAll(/[-:]/g, '').slice(0, 15)
    const fileName = `export-donnees-${timestamp}.xlsx`
    // Persist the attempt's own key before upload so a crash can be cleaned on
    // retry. A worker losing its connection can never delete a successor's file.
    storageKey = `exports/${dataExport.id}/${randomUUID()}-${fileName}`
    const claimed = await client.dataExport.updateMany({where: ownedAttempt, data: {storageKey}})
    if (claimed.count !== 1) throw new Error('Cet export a été repris par un autre traitement.')
    input = createReadStream(filename)
    uploadStarted = true
    await storage.uploadObject(storageKey, input, {filename: fileName, type: XLSX_CONTENT_TYPE})
    if (connectionError) throw connectionError
    const completedData = {status: 'COMPLETED', fileName, rowCount, completedAt: new Date(), failedAt: null, errorMessage: null}
    const completed = await client.dataExport.updateMany({where: {...ownedAttempt, storageKey}, data: completedData})
    if (completed.count !== 1) throw new Error('Cet export a été repris par un autre traitement.')
    published = true
    logger.log(`[data-export] export ${dataExport.id} terminé: rows=${rowCount}`)
    return serializeDataExport({...dataExport, ...completedData, filters: effectiveFilters, startedAt: attemptStartedAt})
  } catch (error) {
    if (uploadStarted && !published) await storage.deleteObject(storageKey, true).catch(() => {
      logger.log(`[data-export] nettoyage du fichier ${dataExportId} à reprendre`)
    })
    if (attemptStartedAt) await client.dataExport.updateMany({
      where: {id: dataExportId, status: 'PROCESSING', startedAt: attemptStartedAt},
      data: {status: 'FAILED', failedAt: new Date(), errorMessage: error instanceof Error ? error.message : String(error)}
    })
    throw error
  } finally {
    input?.destroy()
    try {
      if (temporaryDirectory) await rm(temporaryDirectory, {recursive: true, force: true})
    } finally {
      try {
        if (transactionOpen) await connection.query('ROLLBACK')
        if (acquired && !connectionError) await connection.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey])
      } catch (error) {
        connectionError ||= error
      } finally {
        connection.off('error', onConnectionError)
        // Never return a connection with an uncertain session lock to the pool.
        connection.release(connectionError)
      }
    }
  }
}
