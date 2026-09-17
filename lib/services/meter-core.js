import {createHash} from 'node:crypto'

const SCALE = 10_000n
const PERCENT_SCALE = 1_000_000n
const localFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
})

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function meterHash(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

export function scaledDecimal(value) {
  const text = String(value ?? '')
  const match = /^(\d{1,16})(?:\.(\d{1,4}))?$/.exec(text)
  if (!match) throw new Error('Décimal positif à quatre décimales maximum attendu.')
  return BigInt(match[1]) * SCALE + BigInt((match[2] ?? '').padEnd(4, '0'))
}

export function decimalString(value) {
  return `${value / SCALE}.${String(value % SCALE).padStart(4, '0')}`
}

function localParts(milliseconds) {
  const parts = Object.fromEntries(localFormatter.formatToParts(milliseconds).map(part => [part.type, part.value]))
  return [parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second].map(Number)
}

// The API only accepts normalized instants with an explicit offset. Provider
// calendars, timezone ambiguity and quality codes belong to the producer.
export function parseMeterInstant(value) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,3})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value ?? '')
  if (!match) return null
  const calendar = new Date(`${match[1]}${match[2] ?? ''}Z`)
  if (Number.isNaN(calendar.getTime()) || calendar.toISOString().slice(0, 19) !== match[1]) return null
  const instant = new Date(value)
  return Number.isNaN(instant.getTime()) ? null : instant
}

export function normalizeMeterReading(row, {windowStart, windowEnd}) {
  const externalId = row.externalId
  const observedAt = row.observedAt === null ? null : parseMeterInstant(row.observedAt)
  if (!externalId) return {reason: row.reason ?? 'MISSING_METER'}
  if (!observedAt) return {externalId, reason: row.reason ?? 'UNLOCATED_READING'}
  if (observedAt < new Date(windowStart) || observedAt > new Date(windowEnd)) return {externalId, reason: 'OUTSIDE_WINDOW'}
  return {
    externalId, observedAt, index: row.index === null ? null : decimalString(scaledDecimal(row.index)),
    quality: row.quality ?? null, origin: row.origin ?? null,
    admissible: row.status === 'VALID', reason: row.status === 'VALID' ? null : (row.reason ?? 'INVALID_READING')
  }
}

export function validateAllocationSnapshot(snapshot, validated) {
  if (!validated || !Array.isArray(snapshot) || snapshot.length === 0) throw new Error('ALLOCATION_SNAPSHOT_UNVALIDATED')
  const keys = new Set()
  const entries = snapshot.map(entry => {
    if (!entry || typeof entry.key !== 'string' || !entry.key || keys.has(entry.key)
      || typeof entry.inScope !== 'boolean') throw new Error('ALLOCATION_SNAPSHOT_INVALID')
    keys.add(entry.key)
    const percentage = scaledDecimal(entry.percentage)
    if (percentage > PERCENT_SCALE) throw new Error('ALLOCATION_PERCENTAGE_INVALID')
    return {...entry, percentage}
  })
  if (entries.reduce((sum, entry) => sum + entry.percentage, 0n) !== PERCENT_SCALE) throw new Error('ALLOCATION_TOTAL_NOT_100')
  return entries
}

// Largest remainder gives deterministic four-decimal conservation, including
// external beneficiaries. Grouping by exploitation happens only afterwards.
export function apportionMeterVolume(volume, entries) {
  const physical = typeof volume === 'bigint' ? volume : scaledDecimal(volume)
  const shares = entries.map(entry => ({
    ...entry,
    volume: physical * entry.percentage / PERCENT_SCALE,
    remainder: physical * entry.percentage % PERCENT_SCALE
  }))
  let remainder = physical - shares.reduce((sum, share) => sum + share.volume, 0n)
  const ordered = [...shares].sort((a, b) => a.remainder === b.remainder
    ? a.key.localeCompare(b.key, 'en') : (a.remainder > b.remainder ? -1 : 1))
  for (const share of ordered) {
    if (remainder <= 0n) break
    share.volume++
    remainder--
  }
  return shares
}

export function shouldPromoteMeterRevision(reading, incomingMode, fetchedAt) {
  if (!reading.currentRevisionId) return true
  if (reading.currentMode === 'LIVE' && incomingMode === 'OFFLINE') return false
  if (reading.currentMode === 'OFFLINE' && incomingMode === 'LIVE') return true
  return new Date(fetchedAt) > new Date(reading.lastFetchedAt)
}

export function meterBusinessDateBoundary(value, followingDay = false) {
  if (!value) return null
  const date = new Date(value)
  if (followingDay) date.setUTCDate(date.getUTCDate() + 1)
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth()
  const day = date.getUTCDate()
  // Business dates are French calendar days, not supplier timestamps. Noon
  // determines the day's offset safely even on a daylight-saving transition.
  const noon = Date.UTC(year, month, day, 12)
  const parts = localParts(noon)
  const offset = Date.UTC(parts[0], parts[1] - 1, ...parts.slice(2)) - noon
  const guess = Date.UTC(year, month, day) - offset
  const midnightParts = localParts(guess)
  const midnightOffset = Date.UTC(midnightParts[0], midnightParts[1] - 1, ...midnightParts.slice(2)) - guess
  return new Date(Date.UTC(year, month, day) - midnightOffset)
}

export function coversHistoricalMeterPublication(version, start, end) {
  const authorization = version.metadata?.historicalPublication
  const from = parseMeterInstant(authorization?.from)
  const to = parseMeterInstant(authorization?.to)
  return Boolean(authorization?.reference && authorization.confirmedBy && parseMeterInstant(authorization.confirmedAt)
    && from && to && from <= start && to >= end && version.enabled
    && version.metadata?.allocationSnapshotValidated === true)
}

export function planMeterInterval(start, end, stream, allocations) {
  if (!start.currentRevision?.admissible || !end.currentRevision?.admissible) return {reason: 'BLOCKED_READING'}
  if (start.currentRevision.streamId !== stream.id || end.currentRevision.streamId !== stream.id) return {reason: 'STREAM_CHANGED'}
  if (!stream.enabled || !stream.activatedAt) return {reason: 'NOT_ACTIVATED'}
  const historical = start.observedAt < new Date(stream.activatedAt)
  if ((stream.blockedWindows ?? []).some(window => (window.mode !== 'OFFLINE'
    || start.currentRevision.mode !== 'LIVE' || end.currentRevision.mode !== 'LIVE') && new Date(window.windowStart) < end.observedAt
    && new Date(window.windowEnd) > start.observedAt)) return {reason: 'UNLOCATED_READING_IN_WINDOW'}
  const before = scaledDecimal(start.currentRevision.index)
  const after = scaledDecimal(end.currentRevision.index)
  if (after < before) return {reason: 'INDEX_DECREASE'}
  let snapshot
  const effectiveVersions = allocations.flatMap(allocation => allocation.versions.filter(version => version.enabled && version.startDate
    && new Date(version.startDate) <= start.observedAt
    && (!version.endDate || new Date(version.endDate) >= end.observedAt)))
  if (historical && !effectiveVersions.some(version => coversHistoricalMeterPublication(version, start.observedAt, end.observedAt))) {
    return {reason: 'NOT_ACTIVATED'}
  }
  const historicalSnapshots = effectiveVersions.map(version => version.metadata?.allocationSnapshot).filter(Boolean)
  const snapshotValue = historicalSnapshots[0] ?? stream.allocationSnapshot
  if (historicalSnapshots.some(value => stableJson(value) !== stableJson(snapshotValue))) return {reason: 'ALLOCATION_SNAPSHOT_MISMATCH'}
  const snapshotValidated = historicalSnapshots.length
    ? effectiveVersions.filter(version => version.metadata?.allocationSnapshot).every(version => version.metadata.allocationSnapshotValidated === true)
    : stream.allocationSnapshotValidated
  try {
    snapshot = validateAllocationSnapshot(snapshotValue, snapshotValidated)
  } catch (error) {
    return {reason: error.message}
  }
  const shares = apportionMeterVolume(after - before, snapshot)
  const groups = new Map()
  for (const share of shares.filter(entry => entry.inScope)) {
    const allocation = allocations.find(item => item.sourceId === share.key)
    if (!allocation) return {reason: 'MISSING_ALLOCATION'}
    const versions = allocation.versions.filter(version => version.enabled && version.startDate
      && new Date(version.startDate) <= start.observedAt
      && (!version.endDate || new Date(version.endDate) >= end.observedAt))
    if (versions.length !== 1) return {reason: 'ALLOCATION_PERIOD_UNRESOLVED'}
    const version = versions[0]
    if (historical && !coversHistoricalMeterPublication(version, start.observedAt, end.observedAt)) return {reason: 'HISTORICAL_ALLOCATION_NOT_AUTHORIZED'}
    if (version.percentage === null || scaledDecimal(version.percentage) !== share.percentage) return {reason: 'ALLOCATION_PERCENTAGE_MISMATCH'}
    const exploitation = allocation.exploitation
    const exploitationStart = meterBusinessDateBoundary(exploitation?.startDate)
    const exploitationEnd = meterBusinessDateBoundary(exploitation?.endDate, true)
    if (!exploitation || !['EN_ACTIVITE', 'NON_RENSEIGNE'].includes(exploitation.status)
      || (exploitationStart && exploitationStart > start.observedAt)
      || (exploitationEnd && exploitationEnd < end.observedAt)) return {reason: 'EXPLOITATION_PERIOD_UNRESOLVED'}
    const group = groups.get(exploitation.id) ?? {exploitation, shares: [], volume: 0n, additive: true}
    group.shares.push({...share, version})
    group.volume += share.volume
    group.additive &&= version.additive === true
    groups.set(exploitation.id, group)
  }
  return {
    historical,
    preserveOrdinary: [...groups.values()].some(group => group.shares.some(share => share.version.metadata?.preserveOrdinary === true)),
    allocationSnapshot: snapshotValue,
    physicalVolume: after - before,
    inScopeVolume: shares.filter(entry => entry.inScope).reduce((sum, entry) => sum + entry.volume, 0n),
    outOfScopeVolume: shares.filter(entry => !entry.inScope).reduce((sum, entry) => sum + entry.volume, 0n),
    groups: [...groups.values()]
  }
}
