import {Prisma} from '@prisma/client'

// Native Réunion values are UTC instants, unlike historical calendar timestamps.
export const NATIVE_TIME_ZONE = 'Indian/Reunion'
const OFFSET_MS = 4 * 60 * 60 * 1000
export const NATIVE_CHUNK_WHERE = {metadata: {path: ['nativeTemporal'], equals: true}}
// JSON path negation does not match SQL NULL or a missing key. Include both explicitly.
export const NON_NATIVE_CHUNK_WHERE = {OR: [
  {metadata: {path: ['nativeTemporal'], equals: Prisma.AnyNull}},
  {NOT: NATIVE_CHUNK_WHERE}
]}

export function isNativeTemporal(metadata) {
  return metadata?.nativeTemporal === true
}

export function nativeBusinessDateBoundary(date, endExclusive = false) {
  const day = date instanceof Date ? date.toISOString().slice(0, 10) : String(date).slice(0, 10)
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - OFFSET_MS + (endExclusive ? 86400000 : 0))
}

export function nativeDateTimeParts(value) {
  if (!value) return {date: '', time: '', dateTime: ''}
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return {date: '', time: '', dateTime: ''}
  const local = new Date(date.getTime() + OFFSET_MS).toISOString()
  const time = local.slice(11, 23)
  return {date: local.slice(0, 10), time, dateTime: `${local.slice(0, 10)} ${time}`}
}
