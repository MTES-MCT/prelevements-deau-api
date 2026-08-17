import {createHash} from 'node:crypto'
import process from 'node:process'
import {setTimeout as sleep} from 'node:timers/promises'

/* Sandre pagination and retry attempts are intentionally sequential. */
/* eslint-disable no-await-in-loop */

export const SANDRE_PAGE_SIZE = 1000
export const SANDRE_MAX_PAGES_PER_DEPARTMENT = 100

const DEFAULT_BASE_URL = 'https://services.sandre.eaufrance.fr'
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_REQUEST_RETRIES = 3
const POSTGRES_INTEGER_MAX = 2_147_483_647
const SANDRE_CODE_MAX_LENGTH = 32
const SANDRE_NAME_MAX_LENGTH = 200

export class SandreAlertZoneError extends Error {
  constructor(message, {status = null, cause = null} = {}) {
    super(message, {cause})
    this.name = 'SandreAlertZoneError'
    this.status = status
  }
}

export function buildSandreZonesURL(baseURL, departmentCode, startIndex, count) {
  const url = new URL(`${baseURL.replace(/\/$/, '')}/geo/zas`)
  url.search = new URLSearchParams({
    SERVICE: 'WFS',
    VERSION: '2.0.0',
    REQUEST: 'GetFeature',
    typename: 'ZAS',
    SRSNAME: 'EPSG:4326',
    OUTPUTFORMAT: 'GeoJSON',
    COUNT: String(count),
    STARTINDEX: String(startIndex),
    SORTBY: 'CdZAS',
    Filter: buildDepartmentFilter(departmentCode)
  }).toString()
  return url.toString()
}

export function buildSandreFeatureCountURL(baseURL, departmentCode) {
  const url = new URL(`${baseURL.replace(/\/$/, '')}/geo/zas`)
  url.search = new URLSearchParams({
    SERVICE: 'WFS',
    VERSION: '2.0.0',
    REQUEST: 'GetFeature',
    typename: 'ZAS',
    RESULTTYPE: 'hits',
    Filter: buildDepartmentFilter(departmentCode)
  }).toString()
  return url.toString()
}

export function parseSandreFeatureCount(xml) {
  if (typeof xml !== 'string' || !xml.trim()) {
    throw new SandreAlertZoneError('Réponse de comptage SANDRE invalide.')
  }

  const match = xml.match(/\bnumbermatched\s*=\s*["'](\d+)["']/i)
  const count = match ? Number(match[1]) : Number.NaN
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new SandreAlertZoneError('Réponse de comptage SANDRE invalide.')
  }

  return count
}

export function parseSandreZoneFeature(rawFeature, departmentCode) {
  const properties = rawFeature?.properties
  if (!properties || String(properties.CdDepartement) !== departmentCode) {
    throw new SandreAlertZoneError(
      `Département SANDRE invalide : attendu ${departmentCode}, reçu ${properties?.CdDepartement ?? 'absent'}.`
    )
  }

  const metadata = parseSandreFeatureMetadata(properties, departmentCode)
  const {rawStatus, ...storedMetadata} = metadata
  const {codeSandre} = storedMetadata

  const geometry = rawFeature.geometry ?? null
  if ((rawStatus === 'Validé' || geometry !== null) && !isUsablePolygonGeometry(geometry)) {
    throw new SandreAlertZoneError(`Géométrie SANDRE invalide pour la zone ${codeSandre}.`)
  }

  const explicitAlternateCode = nonEmptyString(properties.CdAltZAS)
  const extractedAlternateCodes = extractAlternateCodes(properties.CodesAlternatifs)
  const alternateCodes = [...new Set([
    ...(explicitAlternateCode ? [explicitAlternateCode] : []),
    ...extractedAlternateCodes
  ])].sort()
  const preferredAlternateCode = explicitAlternateCode
    ?? extractPreferredAlternateCode(properties.CodesAlternatifs)

  if ((preferredAlternateCode?.length ?? 0) > SANDRE_CODE_MAX_LENGTH) {
    throw new SandreAlertZoneError(`Code alternatif SANDRE invalide pour la zone ${codeSandre}.`)
  }

  const feature = {
    ...storedMetadata,
    alternateCodes,
    preferredAlternateCode,
    departmentCode,
    status: rawStatus === 'Validé' ? 'VALIDATED' : 'FROZEN',
    geometry
  }

  return {
    ...feature,
    payloadHash: hashValue(feature)
  }
}

export function createSandreZoneSnapshot(rawFeatures, expectedCount, departmentCode) {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
    throw new SandreAlertZoneError(`Comptage SANDRE invalide pour le département ${departmentCode}.`)
  }

  if (!Array.isArray(rawFeatures) || rawFeatures.length !== expectedCount) {
    throw new SandreAlertZoneError(
      `Snapshot SANDRE incomplet pour le département ${departmentCode} : ${rawFeatures?.length ?? 0}/${expectedCount}.`
    )
  }

  const features = rawFeatures.map(feature => parseSandreZoneFeature(feature, departmentCode))
  const codes = new Set()
  const gids = new Set()
  for (const feature of features) {
    if (codes.has(feature.codeSandre)) {
      throw new SandreAlertZoneError(`Code SANDRE dupliqué ${feature.codeSandre} (${departmentCode}).`)
    }

    if (gids.has(feature.gid)) {
      throw new SandreAlertZoneError(`GID SANDRE dupliqué ${feature.gid} (${departmentCode}).`)
    }

    codes.add(feature.codeSandre)
    gids.add(feature.gid)
  }

  const sourceDates = features.map(feature => feature.sourceUpdatedAt).sort()
  return {
    features,
    featureCount: features.length,
    sourceUpdatedAt: sourceDates.at(-1) ?? null,
    snapshotHash: hashSandreZoneFeatures(features)
  }
}

export function hashSandreZoneFeatures(features) {
  return hashValue(
    features
      .map(feature => `${feature.codeSandre}:${feature.payloadHash}`)
      .sort()
  )
}

export async function fetchSandreZoneSnapshot(
  departmentCode,
  {
    baseURL = process.env.SANDRE_API_BASE_URL || DEFAULT_BASE_URL,
    transport = sandreTransport
  } = {}
) {
  const firstSnapshot = await readSandreZoneSnapshot(baseURL, departmentCode, transport)
  if (firstSnapshot.featureCount <= SANDRE_PAGE_SIZE) {
    return firstSnapshot
  }

  const verificationSnapshot = await readSandreZoneSnapshot(baseURL, departmentCode, transport)
  if (verificationSnapshot.snapshotHash !== firstSnapshot.snapshotHash) {
    throw new SandreAlertZoneError(
      `Le snapshot SANDRE a changé pendant la lecture du département ${departmentCode}.`
    )
  }

  return verificationSnapshot
}

export function createSandreTransport({
  fetchImpl = globalThis.fetch,
  retries = Number(process.env.SANDRE_REQUEST_RETRIES || DEFAULT_REQUEST_RETRIES),
  sleepImpl = sleep,
  timeoutMs = Number(process.env.SANDRE_REQUEST_TIMEOUT_MS || DEFAULT_REQUEST_TIMEOUT_MS)
} = {}) {
  async function request(url, responseType) {
    let lastError

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const response = await fetchImpl(new URL(url), {
          signal: controller.signal,
          headers: {
            accept: responseType === 'json' ? 'application/json' : 'application/xml,text/xml',
            'user-agent': 'partageonsleau-api/1.0'
          }
        })
        const responseBody = await response.text()

        if (response.ok) {
          if (responseType === 'text') {
            return responseBody
          }

          try {
            return JSON.parse(responseBody)
          } catch (error) {
            throw new SandreAlertZoneError('Le SANDRE a renvoyé un JSON invalide.', {cause: error})
          }
        }

        const error = new SandreAlertZoneError(
          `Le SANDRE a répondu HTTP ${response.status} : ${responseBody.slice(0, 300)}`,
          {status: response.status}
        )
        if (response.status !== 429 && response.status < 500) {
          throw error
        }

        lastError = error
      } catch (error) {
        if (error instanceof SandreAlertZoneError && error.status && error.status < 500 && error.status !== 429) {
          throw error
        }

        lastError = error
      } finally {
        clearTimeout(timeout)
      }

      if (attempt < retries) {
        await sleepImpl(attempt * 1000)
      }
    }

    throw new SandreAlertZoneError('Impossible de joindre le service SANDRE.', {cause: lastError})
  }

  return {
    getJson: url => request(url, 'json'),
    getText: url => request(url, 'text')
  }
}

export const sandreTransport = createSandreTransport()

async function readSandreZoneSnapshot(baseURL, departmentCode, transport) {
  const countURL = buildSandreFeatureCountURL(baseURL, departmentCode)
  const expectedCount = parseSandreFeatureCount(await transport.getText(countURL))
  const rawFeatures = []
  let startIndex = 0
  let pageCount = 0

  while (rawFeatures.length < expectedCount) {
    pageCount += 1
    if (pageCount > SANDRE_MAX_PAGES_PER_DEPARTMENT) {
      throw new SandreAlertZoneError(
        `Le département ${departmentCode} dépasse ${SANDRE_MAX_PAGES_PER_DEPARTMENT} pages SANDRE.`
      )
    }

    const page = await transport.getJson(
      buildSandreZonesURL(baseURL, departmentCode, startIndex, SANDRE_PAGE_SIZE)
    )
    if (!page || !Array.isArray(page.features) || page.features.length === 0) {
      throw new SandreAlertZoneError(`Pagination SANDRE incomplète pour le département ${departmentCode}.`)
    }

    rawFeatures.push(...page.features)
    startIndex += page.features.length
    if (rawFeatures.length > expectedCount) {
      throw new SandreAlertZoneError(`Pagination SANDRE incohérente pour le département ${departmentCode}.`)
    }
  }

  const endingCount = parseSandreFeatureCount(await transport.getText(countURL))
  if (endingCount !== expectedCount) {
    throw new SandreAlertZoneError(
      `Le snapshot SANDRE a changé pendant la lecture du département ${departmentCode}.`
    )
  }

  return createSandreZoneSnapshot(rawFeatures, expectedCount, departmentCode)
}

function buildDepartmentFilter(departmentCode) {
  return '<Filter><PropertyIsEqualTo>'
    + '<PropertyName>CdDepartement</PropertyName>'
    + `<Literal>${escapeXML(departmentCode)}</Literal>`
    + '</PropertyIsEqualTo></Filter>'
}

function parseSandreFeatureMetadata(properties, departmentCode) {
  const metadata = {
    gid: positiveInteger(properties.gid),
    codeSandre: nonEmptyString(properties.CdZAS),
    name: nonEmptyString(properties.LbZAS),
    type: properties.TypeZAS,
    rawStatus: nonEmptyString(properties.StZAS),
    sourceUpdatedAt: normalizeDate(properties.DateMajZAS),
    basinCode: positiveInteger(properties.NumCircAdminBassin),
    influencedResource: binaryIndicator(properties.RessInfluenceeZAS),
    version: optionalNonNegativeInteger(properties.NumeroVersionZAS)
  }
  const hasVersion = ![null, undefined, ''].includes(properties.NumeroVersionZAS)
  const validMetadata = [
    metadata.gid !== null,
    Boolean(metadata.codeSandre),
    (metadata.codeSandre?.length ?? 0) <= SANDRE_CODE_MAX_LENGTH,
    Boolean(metadata.name),
    (metadata.name?.length ?? 0) <= SANDRE_NAME_MAX_LENGTH,
    ['SUP', 'SOU'].includes(metadata.type),
    ['Validé', 'Gelé'].includes(metadata.rawStatus),
    Boolean(metadata.sourceUpdatedAt),
    metadata.basinCode !== null,
    metadata.influencedResource !== null,
    !hasVersion || metadata.version !== null
  ]
  if (validMetadata.includes(false)) {
    throw new SandreAlertZoneError(`Données SANDRE invalides pour le département ${departmentCode}.`)
  }

  return metadata
}

function escapeXML(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&apos;')
}

function positiveInteger(value) {
  if (!((typeof value === 'number' && Number.isInteger(value)) || (typeof value === 'string' && /^\d+$/.test(value)))) {
    return null
  }

  const parsed = Number(value)
  return parsed > 0 && parsed <= POSTGRES_INTEGER_MAX ? parsed : null
}

function optionalNonNegativeInteger(value) {
  if ([null, undefined, ''].includes(value)) {
    return null
  }

  if (!((typeof value === 'number' && Number.isInteger(value)) || (typeof value === 'string' && /^\d+$/.test(value)))) {
    return null
  }

  const parsed = Number(value)
  return parsed >= 0 && parsed <= POSTGRES_INTEGER_MAX ? parsed : null
}

function binaryIndicator(value) {
  if (value === 0 || value === '0') {
    return false
  }

  if (value === 1 || value === '1') {
    return true
  }

  return null
}

function normalizeDate(value) {
  const date = nonEmptyString(value)
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function extractAlternateCodes(value) {
  const codes = new Set()
  collectAlternateCodes(value, codes)
  return [...codes].sort()
}

function collectAlternateCodes(value, codes) {
  if (!value) {
    return
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectAlternateCodes(item, codes)
    }

    return
  }

  if (typeof value === 'object') {
    const directCode = nonEmptyString(value.code)
    if (directCode) {
      codes.add(directCode)
    }

    for (const item of Object.values(value)) {
      collectAlternateCodes(item, codes)
    }

    return
  }

  if (typeof value !== 'string') {
    return
  }

  const normalizedValue = value.replaceAll(String.raw`\"`, '"')
  for (const match of normalizedValue.matchAll(/"code"\s*:\s*"([^"]+)"/g)) {
    const code = nonEmptyString(match[1])
    if (code) {
      codes.add(code)
    }
  }

  try {
    collectAlternateCodes(JSON.parse(value), codes)
  } catch {
    // Certaines valeurs SANDRE utilisent un format proche d'un tableau PostgreSQL.
  }
}

function extractPreferredAlternateCode(value) {
  if (!value) {
    return null
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const code = extractPreferredAlternateCode(item)
      if (code) {
        return code
      }
    }

    return null
  }

  if (typeof value === 'object') {
    return nonEmptyString(value.code) ?? extractPreferredAlternateCode(Object.values(value))
  }

  if (typeof value !== 'string') {
    return null
  }

  const normalizedValue = value.replaceAll(String.raw`\"`, '"')
  const directCode = nonEmptyString(normalizedValue.match(/"code"\s*:\s*"([^"]+)"/)?.[1])
  if (directCode) {
    return directCode
  }

  try {
    return extractPreferredAlternateCode(JSON.parse(value))
  } catch {
    return null
  }
}

function isUsablePolygonGeometry(value) {
  if (!value || typeof value !== 'object') {
    return false
  }

  if (value.type === 'Polygon') {
    return isUsablePolygonCoordinates(value.coordinates)
  }

  return value.type === 'MultiPolygon'
    && Array.isArray(value.coordinates)
    && value.coordinates.length > 0
    && value.coordinates.every(isUsablePolygonCoordinates)
}

function isUsablePolygonCoordinates(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isUsableLinearRing)
}

function isUsableLinearRing(value) {
  if (!Array.isArray(value) || value.length < 4 || !value.every(isUsablePosition)) {
    return false
  }

  const first = value[0]
  const last = value.at(-1)
  return first[0] === last[0] && first[1] === last[1]
}

function isUsablePosition(value) {
  if (!Array.isArray(value) || value.length < 2) {
    return false
  }

  const [longitude, latitude] = value
  return typeof longitude === 'number'
    && Number.isFinite(longitude)
    && longitude >= -180
    && longitude <= 180
    && typeof latitude === 'number'
    && Number.isFinite(latitude)
    && latitude >= -90
    && latitude <= 90
}

function hashValue(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/* eslint-enable no-await-in-loop */
