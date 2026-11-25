import {getCompatibleMetricTypeCodes} from '../constants/metric-type-codes.js'
import {getDeclarationTypeLabel, normalizeDeclarationTypeCode} from '../models/declaration-type.js'
import {getQuickPreviousReadings, quickSeriesKey} from '../services/quick-declaration-impact.js'
import {getQuickDeclarationDates, sameQuickMeasure} from '../services/quick-declaration-dates.js'
import {recordDeclarationReceipt} from '../services/declaration-receipts.js'
import {getQuickDeclarationPointDisplayName} from './declarations.js'

const day = date => date.toISOString().slice(0, 10)

// Freeze what was actually published for each reading. Another reading on the same
// day or a direct volume over part of the interval may take precedence.
export async function captureReceiptIndexMeasures(client, declarantUserId, entries) {
  const readings = entries.filter(row => row.readingDate)
  if (!readings.length) return new Map()
  const previous = await getQuickPreviousReadings(client, {declarantUserId, entries: readings})
  const published = await client.chunkValue.findMany({
    where: {chunkId: {in: readings.map(row => row.id)}, valueKind: 'COMPUTED', metricTypeCode: {in: getCompatibleMetricTypeCodes('volume')}},
    select: {chunkId: true, periodStart: true, periodEnd: true, value: true}
  })
  const volumes = new Map(published.map(v => [[v.chunkId, day(v.periodStart), day(v.periodEnd)].join('/'), Number(v.value)]))
  return new Map(readings.map(row => {
    const prior = previous.get(row.id)
    return [row.id, {type: 'INDEX', value: row.value, readingDate: row.readingDate,
      previousReading: prior ? {date: prior.date, value: prior.value} : null,
      computedVolume: prior ? volumes.get([row.id, prior.date, row.readingDate].join('/')) ?? null : null}]
  }))
}

function measure(row, indices) {
  if (!row) return null
  if (row.readingDate) return indices.get(row.id)
  return {type: 'VOLUME', value: row.value, periodStartDate: row.periodStartDate, periodEndDate: row.periodEndDate}
}

function receiptRows(previous, saved, order) {
  const byId = new Map(previous.map(before => [before.id, {before, after: null}]))
  const additions = new Map()
  for (const after of saved) {
    const pair = {before: byId.get(after.id)?.before ?? null, after}
    byId.set(after.id, pair)
    if (!pair.before) additions.set(after.exploitationId, pair)
  }
  // Presentation hints may only order known rows. A legacy client provides its
  // retained rows in form order; append any omitted (removed) rows once.
  const rows = new Set(order.map(ref => ref.id ? byId.get(ref.id) : additions.get(ref.exploitationId)).filter(Boolean))
  for (const pair of byId.values()) rows.add(pair)
  return [...rows]
}

function changeStatus(before, after) {
  if (!before) return 'ADDED'
  if (!after) return 'REMOVED'
  return sameQuickMeasure(before, after) ? 'UNCHANGED' : 'MODIFIED'
}

export async function recordQuickDeclarationReceipt(client, {req, declaration, revision, draft, body, current, resultingEntries, beforeIndices, changes, warnings}) {
  const old = current?.entries ?? []
  const afterIndices = await captureReceiptIndexMeasures(client, draft.declarantUserId, resultingEntries)
  const order = current ? body.receiptRowOrder ?? body.entries : resultingEntries
  const rows = receiptRows(old, resultingEntries, order)
  const ids = new Set([...old, ...resultingEntries].map(row => row.effectiveExploitationId ?? row.exploitationId).filter(Boolean))
  const exploitations = await client.declarantPointPrelevement.findMany({
    where: {id: {in: [...ids]}},
    select: {id: true, countingCode: true, pointPrelevement: {select: {name: true, sourceId: true, usageName: true}}}
  })
  const labels = new Map(exploitations.map(row => [row.id, row]))
  const meters = new Map(current?.declaration.source.chunks.map(chunk => [chunk.compteurId, chunk.compteur?.identifier]) ?? [])
  const byEntry = new Map()
  const bySeries = new Map()
  const series = rows.map(({before, after}) => {
    const row = after ?? before
    const exploitation = labels.get(row.effectiveExploitationId ?? row.exploitationId)
    const item = {
      pointName: exploitation ? getQuickDeclarationPointDisplayName(exploitation.pointPrelevement) : row.pointName,
      countingCode: exploitation?.countingCode ?? row.countingCode ?? null, compteurName: row.compteurName ?? meters.get(row.compteurId) ?? null,
      flowType: row.flowType, status: changeStatus(before, after),
      before: measure(before, beforeIndices), after: measure(after, afterIndices), periods: [], warnings: []
    }
    byEntry.set(row.id, item)
    const key = quickSeriesKey(row)
    if (!bySeries.has(key)) bySeries.set(key, item)
    return item
  })
  // The volume comparison is per (point, exploitation, meter). A historical
  // dossier may contain two measures in that series. Report its impact once.
  for (const {pointPrelevementId, pointName, exploitationId, compteurId, ...period} of changes) {
    bySeries.get(quickSeriesKey({pointPrelevementId, exploitationId, compteurId}))?.periods.push(period)
  }
  for (const warning of warnings) {
    const item = byEntry.get(warning.entryId) ?? bySeries.get(quickSeriesKey(warning))
    item?.warnings.push({code: warning.code, message: warning.message})
  }
  const code = normalizeDeclarationTypeCode(declaration.type)
  const catalogType = await client.declarationType.findUnique({where: {code}, select: {name: true}})
  const {measurementType} = draft
  const dates = getQuickDeclarationDates({measurementType, entries: resultingEntries})
  await recordDeclarationReceipt(client, {req, declaration, revision: current ? revision + 1 : 0,
    kind: current ? 'QUICK_UPDATED' : 'QUICK_CREATED', snapshot: {
      declarationType: getDeclarationTypeLabel(code, catalogType), measurementType, ...dates, series
    }})
}
