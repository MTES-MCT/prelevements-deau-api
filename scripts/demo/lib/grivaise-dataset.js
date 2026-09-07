import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {parse} from 'csv-parse/sync'
import proj4 from 'proj4'

const DATASET_ID = 'grivaise-v1'
const SOURCE_PREFIX = 'fixture:grivaise:v1:'
const REFERENCE_YEARS = Object.freeze([2025, 2026])
const DEPARTMENT_CODES = Object.freeze(['dep-38', 'dep-26'])
const WATER_BODY_TYPES = Object.freeze(['SUPERFICIELLE', 'SOUTERRAIN'])
const CADENCES = Object.freeze(['MONTHLY', 'WEEKLY', 'DAILY'])

const PRELEVEUR_CONFIGS = Object.freeze([
  Object.freeze({
    key: 'irrigant',
    type: 'IRRIGANT',
    usageCode: '2',
    count: 240,
    pointCount: 700,
    coveredPointCount: 511,
    cohortCounts: Object.freeze({MONTHLY: 141, WEEKLY: 40, DAILY: 20}),
    namePrefix: 'Exploitation agricole fictive'
  }),
  Object.freeze({
    key: 'icpe',
    type: 'ICPE',
    usageCode: '4',
    count: 30,
    pointCount: 50,
    coveredPointCount: 24,
    cohortCounts: Object.freeze({MONTHLY: 4, WEEKLY: 0, DAILY: 0}),
    namePrefix: 'Site industriel fictif'
  }),
  Object.freeze({
    key: 'aep',
    type: 'GESTIONNAIRE_AEP',
    usageCode: '5',
    count: 30,
    pointCount: 50,
    coveredPointCount: 25,
    cohortCounts: Object.freeze({MONTHLY: 5, WEEKLY: 0, DAILY: 0}),
    namePrefix: 'Service d’eau potable fictif'
  })
])

const POINT_NAME_PREFIXES = Object.freeze({
  2: 'Démo Grivaise — Point d’irrigation',
  4: 'Démo Grivaise — Point industriel',
  5: 'Démo Grivaise — Point d’alimentation en eau potable'
})

// Les points historiques servent uniquement d'ancres de densité. Chaque
// coordonnée produite est déplacée de manière déterministe et reste synthétique.
const HISTORICAL_WATER_BODY_TYPES = Object.freeze({
  1: 'SUPERFICIELLE',
  2: 'SOUTERRAIN'
})
const HISTORICAL_POINT_CRS = '+proj=utm +zone=40 +south +datum=WGS84 +units=m +no_defs'
const WGS84_CRS = 'EPSG:4326'
const HISTORICAL_POINTS_URL = new URL('../../../data/point-prelevement.csv', import.meta.url)
const DEPARTMENTS_URL = new URL('../../../prisma/fixtures/zones/departements.geojson', import.meta.url)
const SAGE_REFERENCE_URL = new URL('../../../prisma/fixtures/zones/sage.geojson', import.meta.url)
const SAGE_REFERENCE_CODE = 'SAGE06025'
const MINIMUM_POINT_DISTANCE_METERS = 35
const MAXIMUM_LOCATION_ATTEMPTS = 256
const LOCATION_RADIUS_METERS = Object.freeze({
  SUPERFICIELLE: Object.freeze({minimum: 80, maximum: 650}),
  SOUTERRAIN: Object.freeze({minimum: 200, maximum: 1600})
})

const SPECIAL_CASES = Object.freeze({
  sharedPointSourceId: `${SOURCE_PREFIX}point-0001`,
  multiMeterPointSourceId: `${SOURCE_PREFIX}point-0002`
})

const VOLUME_BASES = Object.freeze({
  2: 3600,
  4: 2400,
  5: 7200
})

const CADENCE_DIVISORS = Object.freeze({
  MONTHLY: 1,
  WEEKLY: 4,
  DAILY: 30
})

const IRRIGATION_SEASONALITY = Object.freeze([
  0.08,
  0.1,
  0.2,
  0.5,
  0.9,
  1.25,
  1.45,
  1.35,
  0.8,
  0.35,
  0.15,
  0.08
])

const PERIOD_CACHE = new Map()
let locationReferencesCache

function pad(value, length) {
  return String(value).padStart(length, '0')
}

export function deterministicUuid(key) {
  const hex = createHash('sha256')
    .update(`${DATASET_ID}:${key}`)
    .digest('hex')
  const variant = (Number.parseInt(hex[16], 16) % 4 + 8).toString(16)

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32)
  ].join('-')
}

function formatDate(date) {
  return date.toISOString().slice(0, 10)
}

function createMonthlyPeriods(year) {
  return Array.from({length: 12}, (_, monthIndex) => ({
    periodStart: formatDate(new Date(Date.UTC(year, monthIndex, 1))),
    periodEnd: formatDate(new Date(Date.UTC(year, monthIndex + 1, 0)))
  }))
}

function createWeeklyPeriods(year) {
  const periods = []
  const yearEnd = new Date(Date.UTC(year, 11, 31))

  for (
    let start = new Date(Date.UTC(year, 0, 1));
    start <= yearEnd;
    start = new Date(start.getTime() + 7 * 86_400_000)
  ) {
    const nominalEnd = new Date(start.getTime() + 6 * 86_400_000)
    const end = new Date(Math.min(nominalEnd.getTime(), yearEnd.getTime()))

    periods.push({
      periodStart: formatDate(start),
      periodEnd: formatDate(end)
    })
  }

  return periods
}

function createDailyPeriods(year) {
  const periods = []
  const yearEnd = new Date(Date.UTC(year, 11, 31))

  for (
    let date = new Date(Date.UTC(year, 0, 1));
    date <= yearEnd;
    date = new Date(date.getTime() + 86_400_000)
  ) {
    const formattedDate = formatDate(date)
    periods.push({periodStart: formattedDate, periodEnd: formattedDate})
  }

  return periods
}

function getPeriods(year, cadence) {
  const cacheKey = `${year}:${cadence}`

  if (!PERIOD_CACHE.has(cacheKey)) {
    let periods

    if (cadence === 'MONTHLY') {
      periods = createMonthlyPeriods(year)
    } else if (cadence === 'WEEKLY') {
      periods = createWeeklyPeriods(year)
    } else {
      periods = createDailyPeriods(year)
    }

    PERIOD_CACHE.set(cacheKey, periods)
  }

  return PERIOD_CACHE.get(cacheKey)
}

function stringHash(value) {
  let hash = 0

  for (const character of value) {
    hash = (hash * 31 + character.codePointAt(0)) % 2_147_483_647
  }

  return hash
}

function seasonalityFactor(usageCode, month) {
  if (usageCode === '2') {
    return IRRIGATION_SEASONALITY[month - 1]
  }

  if (usageCode === '5') {
    return month >= 6 && month <= 9 ? 1.12 : 0.96
  }

  return month === 8 ? 0.82 : 1
}

function buildValues({sourceKey, usageCode, cadence, year}) {
  const base = VOLUME_BASES[usageCode] / CADENCE_DIVISORS[cadence]

  return getPeriods(year, cadence).map(period => {
    const month = Number(period.periodStart.slice(5, 7))
    const noise = 0.8 + stringHash(`${sourceKey}:${period.periodStart}`) % 41 / 100
    const valueM3 = Math.max(
      0,
      Math.round(base * seasonalityFactor(usageCode, month) * noise)
    )

    return {...period, valueM3}
  })
}

function cadenceForOrdinal(ordinal, cohortCounts) {
  if (ordinal <= cohortCounts.MONTHLY) {
    return 'MONTHLY'
  }

  if (ordinal <= cohortCounts.MONTHLY + cohortCounts.WEEKLY) {
    return 'WEEKLY'
  }

  if (ordinal <= cohortCounts.MONTHLY + cohortCounts.WEEKLY + cohortCounts.DAILY) {
    return 'DAILY'
  }

  return null
}

function buildPreleveurs() {
  return PRELEVEUR_CONFIGS.flatMap(config =>
    Array.from({length: config.count}, (_, index) => {
      const ordinal = index + 1
      const sourceId = `${SOURCE_PREFIX}preleveur-${config.key}-${pad(ordinal, 3)}`
      const cadence = cadenceForOrdinal(ordinal, config.cohortCounts)

      return {
        id: deterministicUuid(sourceId),
        sourceId,
        name: `${config.namePrefix} ${pad(ordinal, 3)}`,
        type: config.type,
        usageCode: config.usageCode,
        departmentCode: DEPARTMENT_CODES[index % DEPARTMENT_CODES.length],
        reporting: {
          active: cadence !== null,
          cadence
        },
        personaKey: ordinal === 1
          ? (config.key === 'icpe' ? 'industriel' : config.key)
          : null
      }
    })
  )
}

function pointIsInRing([longitude, latitude], ring) {
  let isInside = false

  for (let index = 0, previousIndex = ring.length - 1; index < ring.length; previousIndex = index++) {
    const [longitudeA, latitudeA] = ring[index]
    const [longitudeB, latitudeB] = ring[previousIndex]
    const crossesLatitude = (latitudeA > latitude) !== (latitudeB > latitude)

    if (crossesLatitude
      && longitude < (longitudeB - longitudeA) * (latitude - latitudeA)
      / (latitudeB - latitudeA) + longitudeA) {
      isInside = !isInside
    }
  }

  return isInside
}

function pointIsInGeometry(coordinates, geometry) {
  const polygons = geometry.type === 'Polygon'
    ? [geometry.coordinates]
    : geometry.coordinates

  return polygons.some(rings =>
    pointIsInRing(coordinates, rings[0])
    && !rings.slice(1).some(ring => pointIsInRing(coordinates, ring)))
}

function decodeHistoricalCoordinates(encodedGeometry) {
  if (typeof encodedGeometry !== 'string') {
    return null
  }

  const geometry = Buffer.from(encodedGeometry, 'hex')
  if (geometry.length < 25 || geometry.readUInt8(0) !== 1 || geometry.readUInt32LE(5) !== 32_740) {
    return null
  }

  const coordinates = proj4(HISTORICAL_POINT_CRS, WGS84_CRS, [
    geometry.readDoubleLE(9),
    geometry.readDoubleLE(17)
  ])

  return coordinates.every(Number.isFinite) ? coordinates : null
}

function loadLocationReferences() {
  if (locationReferencesCache) {
    return locationReferencesCache
  }

  const departments = JSON.parse(readFileSync(DEPARTMENTS_URL, 'utf8'))
  const departmentGeometries = Object.fromEntries(departments.features
    .filter(feature => ['26', '38'].includes(feature.properties.code))
    .map(feature => [`dep-${feature.properties.code}`, feature.geometry]))
  const sageFeatures = JSON.parse(readFileSync(SAGE_REFERENCE_URL, 'utf8'))
  const sageGeometry = sageFeatures.features.find(
    feature => feature.properties.code === SAGE_REFERENCE_CODE
  )?.geometry

  if (!sageGeometry) {
    throw new Error(`Géométrie de référence ${SAGE_REFERENCE_CODE} absente`)
  }

  const rows = parse(readFileSync(HISTORICAL_POINTS_URL), {
    columns: true,
    skip_empty_lines: true
  })
  const anchorPools = new Map()

  for (const row of rows) {
    const departmentCode = `dep-${row.insee_com?.slice(0, 2)}`
    const waterBodyType = HISTORICAL_WATER_BODY_TYPES[row.type_milieu]
    const coordinates = decodeHistoricalCoordinates(row.geom)
    const departmentGeometry = departmentGeometries[departmentCode]

    if (!waterBodyType || !coordinates || !departmentGeometry
      || !pointIsInGeometry(coordinates, departmentGeometry)
      || !pointIsInGeometry(coordinates, sageGeometry)) {
      continue
    }

    const key = `${departmentCode}:${waterBodyType}`
    const anchors = anchorPools.get(key) ?? []
    anchors.push(coordinates)
    anchorPools.set(key, anchors)
  }

  locationReferencesCache = {anchorPools, departmentGeometries, sageGeometry}
  return locationReferencesCache
}

function deterministicUnits(key) {
  const hash = createHash('sha256').update(`${DATASET_ID}:location:${key}`).digest()

  return [0, 4, 8].map(offset => hash.readUInt32BE(offset) / 2 ** 32)
}

function distanceInMeters(first, second) {
  const averageLatitude = (first[1] + second[1]) / 2 * Math.PI / 180
  const longitudeDistance = (first[0] - second[0]) * 111_320 * Math.cos(averageLatitude)
  const latitudeDistance = (first[1] - second[1]) * 111_320

  return Math.hypot(longitudeDistance, latitudeDistance)
}

function locationCandidate({anchor, waterBodyType, radiusUnit, angleUnit}) {
  const radiusBounds = LOCATION_RADIUS_METERS[waterBodyType]
  const radius = radiusBounds.minimum
    + (radiusBounds.maximum - radiusBounds.minimum) * Math.sqrt(radiusUnit)
  const angle = 2 * Math.PI * angleUnit

  return [
    anchor[0] + Math.cos(angle) * radius / (111_320 * Math.cos(anchor[1] * Math.PI / 180)),
    anchor[1] + Math.sin(angle) * radius / 111_320
  ]
}

function coordinatesFor({sourceId, departmentCode, waterBodyType, ordinal, occupiedCoordinates}) {
  const {anchorPools, departmentGeometries, sageGeometry} = loadLocationReferences()
  const poolKey = `${departmentCode}:${waterBodyType}`
  const anchors = anchorPools.get(poolKey)
  const departmentGeometry = departmentGeometries[departmentCode]

  if (!anchors?.length || !departmentGeometry) {
    throw new Error(`Référentiel géographique absent pour ${poolKey}`)
  }

  for (let attempt = 0; attempt < MAXIMUM_LOCATION_ATTEMPTS; attempt += 1) {
    const [anchorUnit, radiusUnit, angleUnit] = deterministicUnits(`${sourceId}:${attempt}`)
    const anchorIndex = (ordinal * 73 + Math.floor(anchorUnit * anchors.length)) % anchors.length
    const candidate = locationCandidate({
      anchor: anchors[anchorIndex],
      waterBodyType,
      radiusUnit,
      angleUnit
    })

    if (!pointIsInGeometry(candidate, departmentGeometry)
      || !pointIsInGeometry(candidate, sageGeometry)
      || occupiedCoordinates.some(coordinates =>
        distanceInMeters(coordinates, candidate) < MINIMUM_POINT_DISTANCE_METERS)) {
      continue
    }

    const roundedCoordinates = candidate.map(value => Number(value.toFixed(6)))
    occupiedCoordinates.push(roundedCoordinates)

    return {type: 'Point', coordinates: roundedCoordinates}
  }

  throw new Error(`Impossible de positionner ${sourceId} de façon réaliste`)
}

function pointScenarioTags(sourceId) {
  if (sourceId === SPECIAL_CASES.sharedPointSourceId) {
    return ['SHARED']
  }

  if (sourceId === SPECIAL_CASES.multiMeterPointSourceId) {
    return ['MULTI_METER']
  }

  return []
}

function buildPointsAndExploitations(preleveurs) {
  const points = []
  const exploitations = []
  const locationOrdinals = new Map()
  const occupiedCoordinates = []
  const ownerOrdinals = new Map()
  let globalPointIndex = 0

  for (const config of PRELEVEUR_CONFIGS) {
    const compatiblePreleveurs = preleveurs.filter(item => item.type === config.type)
    const activePreleveurs = compatiblePreleveurs.filter(item => item.reporting.active)
    const inactivePreleveurs = compatiblePreleveurs.filter(item => !item.reporting.active)

    for (let index = 0; index < config.pointCount; index += 1) {
      globalPointIndex += 1
      const sourceId = `${SOURCE_PREFIX}point-${pad(globalPointIndex, 4)}`
      const isCovered = index < config.coveredPointCount
      const departmentCode = DEPARTMENT_CODES[(globalPointIndex - 1) % 2]
      const ownerPool = (isCovered ? activePreleveurs : inactivePreleveurs)
        .filter(item => item.departmentCode === departmentCode)
      const ownerKey = `${config.key}:${isCovered}:${departmentCode}`
      const ownerOrdinal = ownerOrdinals.get(ownerKey) ?? 0
      const owner = ownerPool[ownerOrdinal % ownerPool.length]
      const waterBodyType = WATER_BODY_TYPES[Math.floor((globalPointIndex - 1) / 2) % 2]
      const locationKey = `${departmentCode}:${waterBodyType}`
      const locationOrdinal = locationOrdinals.get(locationKey) ?? 0
      const exploitationSourceId = `${SOURCE_PREFIX}exploitation-${pad(globalPointIndex, 4)}`

      locationOrdinals.set(locationKey, locationOrdinal + 1)
      ownerOrdinals.set(ownerKey, ownerOrdinal + 1)
      points.push({
        id: deterministicUuid(sourceId),
        sourceId,
        name: `${POINT_NAME_PREFIXES[config.usageCode]} ${pad(index + 1, 3)}`,
        usageCode: config.usageCode,
        departmentCode,
        waterBodyType,
        flowType: 'PRELEVEMENT',
        coordinates: coordinatesFor({
          sourceId,
          departmentCode,
          waterBodyType,
          ordinal: locationOrdinal,
          occupiedCoordinates
        }),
        isCovered,
        scenarioTags: pointScenarioTags(sourceId)
      })
      exploitations.push({
        id: deterministicUuid(exploitationSourceId),
        sourceId: exploitationSourceId,
        preleveurSourceId: owner.sourceId,
        pointSourceId: sourceId,
        usageCode: config.usageCode,
        startDate: '2020-01-01',
        endDate: null,
        isPrimary: true
      })
    }
  }

  const sharedPrimary = exploitations.find(
    item => item.pointSourceId === SPECIAL_CASES.sharedPointSourceId
  )
  const sharedPoint = points.find(item => item.sourceId === SPECIAL_CASES.sharedPointSourceId)
  const secondOwner = preleveurs.find(item =>
    item.type === 'IRRIGANT'
    && item.reporting.active
    && item.departmentCode === sharedPoint.departmentCode
    && item.sourceId !== sharedPrimary.preleveurSourceId)
  const sharedSourceId = `${SOURCE_PREFIX}exploitation-0001-shared`

  exploitations.push({
    id: deterministicUuid(sharedSourceId),
    sourceId: sharedSourceId,
    preleveurSourceId: secondOwner.sourceId,
    pointSourceId: SPECIAL_CASES.sharedPointSourceId,
    usageCode: '2',
    startDate: '2020-01-01',
    endDate: null,
    isPrimary: false
  })

  return {points, exploitations}
}

function isOugcBeneficiary(preleveur) {
  if (preleveur.type !== 'IRRIGANT') {
    return false
  }

  const ordinal = Number(preleveur.sourceId.slice(-3))
  return ordinal >= 2 && ordinal <= 201
}

function buildCollectorLinks(preleveurs, exploitations) {
  const beneficiaries = preleveurs.filter(isOugcBeneficiary)

  return beneficiaries.map((preleveur, index) => {
    const sourceId = `${SOURCE_PREFIX}collector-link-${pad(index + 1, 3)}`
    const exploitationSourceIds = exploitations
      .filter(item => item.preleveurSourceId === preleveur.sourceId)
      .map(item => item.sourceId)

    return {
      id: deterministicUuid(sourceId),
      sourceId,
      collectorKey: 'ougc',
      preleveurSourceId: preleveur.sourceId,
      exploitationSourceIds,
      startDate: '2020-01-01',
      endDate: null
    }
  })
}

function buildMeters(points) {
  const meters = points.map((point, index) => {
    const sourceId = `${SOURCE_PREFIX}meter-${pad(index + 1, 4)}`

    return {
      id: deterministicUuid(sourceId),
      sourceId,
      identifier: sourceId,
      serialNumber: `GRIVAISE-${pad(index + 1, 5)}`,
      pointSourceId: point.sourceId,
      coefficient: 1,
      initialReading: 0,
      installedAt: '2020-01-01',
      removedAt: null
    }
  })
  const extraSourceId = `${SOURCE_PREFIX}meter-0002-extra`

  meters.push({
    id: deterministicUuid(extraSourceId),
    sourceId: extraSourceId,
    identifier: extraSourceId,
    serialNumber: 'GRIVAISE-00002-B',
    pointSourceId: SPECIAL_CASES.multiMeterPointSourceId,
    coefficient: 0.5,
    initialReading: 120,
    installedAt: '2024-01-01',
    removedAt: null
  })

  return meters
}

function getDeclarationSource(preleveur, ougcBeneficiarySourceIds) {
  if (preleveur.personaKey === 'industriel') {
    return {
      key: 'manual',
      type: 'quick-declaration',
      sourceCode: 'SELF_DECLARATION',
      dataSourceType: 'MANUAL',
      authorKey: 'industriel'
    }
  }

  if (preleveur.type === 'ICPE') {
    return {
      key: 'gidaf',
      type: 'gidaf',
      sourceCode: 'GIDAF',
      dataSourceType: 'SPREADSHEET',
      authorKey: null
    }
  }

  if (ougcBeneficiarySourceIds.has(preleveur.sourceId)) {
    const isDailyTelemetry = preleveur.reporting.cadence === 'DAILY'

    return {
      key: 'ougc',
      type: isDailyTelemetry ? 'api' : 'quick-declaration',
      sourceCode: 'OUGC',
      dataSourceType: isDailyTelemetry ? 'API' : 'MANUAL',
      authorKey: 'ougc'
    }
  }

  if (preleveur.type === 'GESTIONNAIRE_AEP' && preleveur.personaKey !== 'aep') {
    return {
      key: 'telemetry',
      type: 'api',
      sourceCode: 'TELEMETRY',
      dataSourceType: 'API',
      authorKey: null
    }
  }

  return {
    key: 'manual',
    type: 'quick-declaration',
    sourceCode: 'SELF_DECLARATION',
    dataSourceType: 'MANUAL',
    authorKey: preleveur.personaKey
  }
}

function buildMatchedChunk({point, preleveur, year, cadence}) {
  const sourceId = [
    SOURCE_PREFIX,
    'chunk-',
    point.sourceId.slice(SOURCE_PREFIX.length),
    `-${year}`
  ].join('')

  return {
    id: deterministicUuid(sourceId),
    sourceId,
    pointSourceId: point.sourceId,
    externalPointId: point.sourceId,
    status: 'MATCHED',
    usageCode: point.usageCode,
    cadence,
    values: buildValues({
      sourceKey: `${preleveur.sourceId}:${point.sourceId}`,
      usageCode: point.usageCode,
      cadence,
      year
    })
  }
}

function buildUnmatchedGidafChunks({year, cadence}) {
  return Array.from({length: 2}, (_, index) => {
    const externalPointId = `GIDAF-GRIVAISE-INCONNU-${pad(index + 1, 2)}`
    const sourceId = `${SOURCE_PREFIX}chunk-gidaf-unmatched-${year}-${pad(index + 1, 2)}`

    return {
      id: deterministicUuid(sourceId),
      sourceId,
      pointSourceId: null,
      externalPointId,
      status: 'UNMATCHED',
      usageCode: '4',
      cadence,
      values: buildValues({
        sourceKey: externalPointId,
        usageCode: '4',
        cadence,
        year
      })
    }
  })
}

function buildDeclarations({preleveurs, points, exploitations, collectorLinks}) {
  const declarations = []
  const pointsBySourceId = new Map(points.map(point => [point.sourceId, point]))
  const ougcBeneficiarySourceIds = new Set(
    collectorLinks.map(link => link.preleveurSourceId)
  )
  const primaryExploitationsByPreleveur = new Map()

  for (const exploitation of exploitations.filter(item => item.isPrimary)) {
    const current = primaryExploitationsByPreleveur.get(exploitation.preleveurSourceId) ?? []
    current.push(exploitation)
    primaryExploitationsByPreleveur.set(exploitation.preleveurSourceId, current)
  }

  const activePreleveurs = preleveurs.filter(item => item.reporting.active)
  const firstGidafPreleveurSourceId = activePreleveurs.find(item =>
    item.type === 'ICPE' && !item.personaKey).sourceId
  let declarationOrdinal = 0

  for (const preleveur of activePreleveurs) {
    const source = getDeclarationSource(preleveur, ougcBeneficiarySourceIds)
    const ownedExploitations = primaryExploitationsByPreleveur.get(preleveur.sourceId) ?? []

    for (const year of REFERENCE_YEARS) {
      declarationOrdinal += 1
      const sourceId = `${SOURCE_PREFIX}declaration-${pad(declarationOrdinal, 4)}`
      const importSourceId = `${DATASET_ID}:${source.key}:${preleveur.sourceId}:${year}`
      const chunks = ownedExploitations.map(exploitation => buildMatchedChunk({
        point: pointsBySourceId.get(exploitation.pointSourceId),
        preleveur,
        year,
        cadence: preleveur.reporting.cadence
      }))

      if (preleveur.sourceId === firstGidafPreleveurSourceId) {
        chunks.push(...buildUnmatchedGidafChunks({
          year,
          cadence: preleveur.reporting.cadence
        }))
      }

      declarations.push({
        id: deterministicUuid(sourceId),
        sourceId,
        importSourceId,
        code: `GR${pad(declarationOrdinal, 4)}`,
        targetKey: preleveur.sourceId,
        authorKey: source.authorKey,
        type: source.type,
        dataSourceType: source.dataSourceType,
        sourceCode: source.sourceCode,
        waterWithdrawalType: 'unknown',
        year,
        cadence: preleveur.reporting.cadence,
        chunks
      })
    }
  }

  return declarations
}

function buildPersonas(preleveurs) {
  const preleveurSourceId = key => preleveurs.find(item => item.personaKey === key).sourceId

  return {
    ddt: {
      id: deterministicUuid('persona:ddt'),
      key: 'ddt',
      profile: 'INSTRUCTOR',
      email: 'agent-ddt@demo.invalid',
      firstName: 'Diane',
      lastName: 'DDT Grivaise',
      permissions: [
        {zoneCode: 'dep-38', access: 'FULL'},
        {zoneCode: 'SAGE-DEMO-GRIVAISE', access: 'READ_ONLY'}
      ]
    },
    sage: {
      id: deterministicUuid('persona:sage'),
      key: 'sage',
      profile: 'INSTRUCTOR',
      email: 'agent-sage@demo.invalid',
      firstName: 'Simon',
      lastName: 'SAGE Grivaise',
      permissions: [
        {zoneCode: 'SAGE-DEMO-GRIVAISE', access: 'FULL'}
      ]
    },
    irrigant: {
      id: deterministicUuid('persona:irrigant'),
      key: 'irrigant',
      profile: 'PRELEVEUR',
      email: 'irrigant@demo.invalid',
      preleveurSourceId: preleveurSourceId('irrigant')
    },
    industriel: {
      id: deterministicUuid('persona:industriel'),
      key: 'industriel',
      profile: 'PRELEVEUR',
      email: 'industriel@demo.invalid',
      preleveurSourceId: preleveurSourceId('industriel')
    },
    aep: {
      id: deterministicUuid('persona:aep'),
      key: 'aep',
      profile: 'PRELEVEUR',
      email: 'aep@demo.invalid',
      preleveurSourceId: preleveurSourceId('aep')
    },
    ougc: {
      id: deterministicUuid('persona:ougc'),
      key: 'ougc',
      profile: 'COLLECTEUR',
      email: 'ougc@demo.invalid',
      collectorSourceId: `${SOURCE_PREFIX}collector-ougc`
    }
  }
}

function buildZone() {
  const {sageGeometry} = loadLocationReferences()

  return {
    id: deterministicUuid('zone:sage-grivaise'),
    code: 'SAGE-DEMO-GRIVAISE',
    name: 'SAGE Grivaise',
    geojson: {
      type: 'Feature',
      properties: {
        code: 'SAGE-DEMO-GRIVAISE',
        name: 'SAGE Grivaise',
        synthetic: true
      },
      geometry: structuredClone(sageGeometry)
    }
  }
}

function countBy(items, getKey) {
  const counts = {}

  for (const item of items) {
    const key = getKey(item)
    counts[key] = (counts[key] ?? 0) + 1
  }

  return counts
}

function assertInvariant(condition, message) {
  if (!condition) {
    throw new Error(`Jeu Grivaise invalide : ${message}`)
  }
}

function assertExactCounts(actual, expected, label) {
  for (const [key, count] of Object.entries(expected)) {
    assertInvariant(actual[key] === count, `${label} ${key} doit valoir ${count}`)
  }
}

function assertUnique(items, getValue, label) {
  const values = items.map(getValue)
  assertInvariant(new Set(values).size === values.length, `${label} doivent être uniques`)
}

function assertJsonValue(value, path = '$') {
  if (value === null || ['string', 'boolean'].includes(typeof value)) {
    return
  }

  if (typeof value === 'number') {
    assertInvariant(Number.isFinite(value), `${path} contient un nombre non fini`)
    return
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertJsonValue(item, `${path}[${index}]`)
    }

    return
  }

  assertInvariant(
    typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype,
    `${path} n’est pas une valeur JSON simple`
  )

  for (const [key, item] of Object.entries(value)) {
    assertJsonValue(item, `${path}.${key}`)
  }
}

function validateMetadataAndPersonas(dataset) {
  assertInvariant(dataset.metadata?.id === DATASET_ID, `metadata.id doit valoir ${DATASET_ID}`)
  assertInvariant(dataset.metadata?.version === 1, 'metadata.version doit valoir 1')
  assertInvariant(dataset.metadata?.sourcePrefix === SOURCE_PREFIX, 'metadata.sourcePrefix est invalide')
  assertInvariant(
    JSON.stringify(dataset.metadata?.referenceYears) === JSON.stringify(REFERENCE_YEARS),
    'les années de référence doivent être 2025 et 2026'
  )
  assertInvariant(dataset.metadata?.synthetic === true, 'le jeu doit être identifié comme synthétique')
  assertInvariant(dataset.zone?.code === 'SAGE-DEMO-GRIVAISE', 'le code du SAGE est invalide')
  assertInvariant(dataset.zone?.geojson?.type === 'Feature', 'la zone doit être une Feature GeoJSON')
  assertInvariant(dataset.zone?.geojson?.geometry?.type === 'Polygon', 'la zone doit être un Polygon GeoJSON')

  const personaKeys = ['ddt', 'sage', 'irrigant', 'industriel', 'aep', 'ougc']
  assertInvariant(
    personaKeys.every(key => dataset.personas?.[key]?.key === key),
    'les six personas attendus doivent être présents'
  )
  assertInvariant(dataset.personas.ddt.profile === 'INSTRUCTOR', 'le persona DDT doit être instructeur')
  assertInvariant(dataset.personas.sage.profile === 'INSTRUCTOR', 'le persona SAGE doit être instructeur')
  assertInvariant(dataset.personas.ougc.profile === 'COLLECTEUR', 'le persona OUGC doit être collecteur')
}

function validatePreleveurs(preleveurs) {
  assertInvariant(Array.isArray(preleveurs) && preleveurs.length === 300, 'il faut 300 préleveurs')
  assertUnique(preleveurs, item => item.id, 'les UUID des préleveurs')
  assertUnique(preleveurs, item => item.sourceId, 'les sourceId des préleveurs')
  assertExactCounts(countBy(preleveurs, item => item.type), {
    IRRIGANT: 240,
    ICPE: 30,
    GESTIONNAIRE_AEP: 30
  }, 'le nombre de préleveurs de type')

  const active = preleveurs.filter(item => item.reporting?.active)
  assertInvariant(active.length === 210, 'il faut 210 préleveurs actifs')
  assertExactCounts(countBy(active, item => item.type), {
    IRRIGANT: 201,
    ICPE: 4,
    GESTIONNAIRE_AEP: 5
  }, 'le nombre de préleveurs actifs de type')
  assertInvariant(
    active.every(item => CADENCES.includes(item.reporting.cadence)),
    'chaque préleveur actif doit avoir une cadence valide'
  )
  assertExactCounts(countBy(active, item => item.reporting.cadence), {
    MONTHLY: 150,
    WEEKLY: 40,
    DAILY: 20
  }, 'la cohorte')
  assertInvariant(
    preleveurs.filter(item => !item.reporting?.active).every(item => item.reporting.cadence === null),
    'un préleveur inactif ne doit pas avoir de cadence'
  )
}

function validatePoints(points) {
  assertInvariant(Array.isArray(points) && points.length === 800, 'il faut 800 points')
  assertUnique(points, item => item.id, 'les UUID des points')
  assertUnique(points, item => item.sourceId, 'les sourceId des points')
  assertExactCounts(countBy(points, item => item.usageCode), {2: 700, 4: 50, 5: 50}, 'l’usage')
  assertExactCounts(countBy(points, item => item.departmentCode), {
    'dep-38': 400,
    'dep-26': 400
  }, 'le département')
  assertExactCounts(countBy(points, item => item.waterBodyType), {
    SUPERFICIELLE: 400,
    SOUTERRAIN: 400
  }, 'le type de milieu')
  assertInvariant(points.filter(item => item.isCovered).length === 560, 'il faut 560 points couverts')
  assertExactCounts(countBy(points.filter(item => item.isCovered), item => item.usageCode), {
    2: 511,
    4: 24,
    5: 25
  }, 'le nombre de points couverts pour l’usage')
  assertUnique(
    points,
    item => item.coordinates?.coordinates?.join(':'),
    'les coordonnées des points'
  )
  assertInvariant(
    points.every(item =>
      item.coordinates?.type === 'Point'
      && Array.isArray(item.coordinates.coordinates)
      && item.coordinates.coordinates.length === 2
      && item.coordinates.coordinates.every(Number.isFinite)),
    'chaque point doit avoir des coordonnées GeoJSON'
  )
}

function groupBy(items, getKey) {
  const groups = new Map()

  for (const item of items) {
    const key = getKey(item)
    const values = groups.get(key) ?? []
    values.push(item)
    groups.set(key, values)
  }

  return groups
}

function validateExploitations(dataset, preleveursBySourceId, pointsBySourceId) {
  const {exploitations} = dataset
  assertInvariant(Array.isArray(exploitations) && exploitations.length === 801, 'il faut 801 exploitations')
  assertUnique(exploitations, item => item.id, 'les UUID des exploitations')
  assertUnique(exploitations, item => item.sourceId, 'les sourceId des exploitations')

  for (const exploitation of exploitations) {
    const preleveur = preleveursBySourceId.get(exploitation.preleveurSourceId)
    const point = pointsBySourceId.get(exploitation.pointSourceId)
    assertInvariant(preleveur, `préleveur inconnu pour ${exploitation.sourceId}`)
    assertInvariant(point, `point inconnu pour ${exploitation.sourceId}`)
    assertInvariant(point.usageCode === exploitation.usageCode, `usage incohérent pour ${exploitation.sourceId}`)
    assertInvariant(
      point.departmentCode === preleveur.departmentCode,
      `département incohérent pour ${exploitation.sourceId}`
    )
  }

  const byPoint = groupBy(exploitations, item => item.pointSourceId)
  const sharedPoints = [...byPoint.entries()].filter(([, items]) => items.length === 2)
  assertInvariant(sharedPoints.length === 1, 'il faut exactement un point partagé')
  assertInvariant(sharedPoints[0][0] === SPECIAL_CASES.sharedPointSourceId, 'le point partagé attendu est absent')
  assertInvariant(
    new Set(sharedPoints[0][1].map(item => item.preleveurSourceId)).size === 2,
    'le point partagé doit appartenir à deux préleveurs distincts'
  )
  assertInvariant(
    [...byPoint.values()].every(items => items.filter(item => item.isPrimary).length === 1),
    'chaque point doit avoir une exploitation primaire'
  )

  const primary = exploitations.filter(item => item.isPrimary)
  const primaryByPoint = new Map(primary.map(item => [item.pointSourceId, item]))

  for (const point of dataset.points) {
    const owner = preleveursBySourceId.get(primaryByPoint.get(point.sourceId).preleveurSourceId)
    assertInvariant(
      owner.reporting.active === point.isCovered,
      `couverture incohérente pour ${point.sourceId}`
    )
  }

  const activeOwners = new Set(
    primary
      .filter(item => pointsBySourceId.get(item.pointSourceId).isCovered)
      .map(item => item.preleveurSourceId)
  )
  assertInvariant(activeOwners.size === 210, 'les 210 préleveurs actifs doivent couvrir au moins un point')
  assertInvariant(
    new Set(primary.map(item => item.preleveurSourceId)).size === 300,
    'les 300 préleveurs doivent avoir au moins une exploitation'
  )
}

function validateCollectorLinks(dataset, preleveursBySourceId, exploitationsBySourceId) {
  const {collectorLinks} = dataset
  assertInvariant(Array.isArray(collectorLinks) && collectorLinks.length === 200, 'il faut 200 bénéficiaires OUGC')
  assertUnique(collectorLinks, item => item.sourceId, 'les sourceId des liens OUGC')
  assertUnique(collectorLinks, item => item.preleveurSourceId, 'les bénéficiaires OUGC')

  for (const link of collectorLinks) {
    const preleveur = preleveursBySourceId.get(link.preleveurSourceId)
    assertInvariant(link.collectorKey === 'ougc', `${link.sourceId} doit référencer l’OUGC`)
    assertInvariant(preleveur?.type === 'IRRIGANT', `${link.sourceId} doit référencer un irrigant`)
    assertInvariant(preleveur.reporting.active, `${link.sourceId} doit référencer un préleveur actif`)
    assertInvariant(
      link.preleveurSourceId !== dataset.personas.irrigant.preleveurSourceId,
      `${link.sourceId} ne doit pas référencer le persona irrigant`
    )
    assertInvariant(link.exploitationSourceIds.length > 0, `${link.sourceId} doit couvrir une exploitation`)
    assertInvariant(
      link.exploitationSourceIds.every(sourceId =>
        exploitationsBySourceId.get(sourceId)?.preleveurSourceId === link.preleveurSourceId),
      `${link.sourceId} contient une exploitation étrangère`
    )
  }
}

function validateMeters(meters, pointsBySourceId) {
  assertInvariant(Array.isArray(meters) && meters.length === 801, 'il faut 801 compteurs')
  assertUnique(meters, item => item.sourceId, 'les sourceId des compteurs')
  assertUnique(meters, item => item.identifier, 'les identifiants des compteurs')
  assertInvariant(
    meters.every(item => item.identifier === item.sourceId),
    'l’identifiant de chaque compteur doit reprendre son sourceId'
  )
  assertInvariant(
    meters.every(item => pointsBySourceId.has(item.pointSourceId)),
    'chaque compteur doit référencer un point'
  )

  const byPoint = groupBy(meters, item => item.pointSourceId)
  const multiMeterPoints = [...byPoint.entries()].filter(([, items]) => items.length > 1)
  assertInvariant(multiMeterPoints.length === 1, 'il faut exactement un point multi-compteurs')
  assertInvariant(
    multiMeterPoints[0][0] === SPECIAL_CASES.multiMeterPointSourceId
    && multiMeterPoints[0][1].length === 2,
    'le point multi-compteurs doit porter exactement deux compteurs'
  )
}

function validateChunkValues(chunk, declaration) {
  assertInvariant(chunk.cadence === declaration.cadence, `cadence incohérente pour ${chunk.sourceId}`)
  assertInvariant(Array.isArray(chunk.values) && chunk.values.length > 0, `${chunk.sourceId} doit contenir des valeurs`)

  for (const value of chunk.values) {
    assertInvariant(value.periodStart.startsWith(`${declaration.year}-`), `année invalide pour ${chunk.sourceId}`)
    assertInvariant(value.periodEnd.startsWith(`${declaration.year}-`), `année de fin invalide pour ${chunk.sourceId}`)
    assertInvariant(Number.isFinite(value.valueM3) && value.valueM3 >= 0, `volume invalide pour ${chunk.sourceId}`)
  }
}

function validateDeclarationSource(declaration, preleveur) {
  if (declaration.sourceCode === 'GIDAF') {
    assertInvariant(preleveur.type === 'ICPE', `${declaration.sourceId} doit cibler un industriel`)
    assertInvariant(!preleveur.personaKey, `${declaration.sourceId} doit cibler un industriel de fond`)
    assertInvariant(declaration.type === 'gidaf', `${declaration.sourceId} doit être de type gidaf`)
    assertInvariant(declaration.dataSourceType === 'SPREADSHEET', `${declaration.sourceId} doit provenir d’un tableur`)
    assertInvariant(declaration.authorKey === null, `${declaration.sourceId} ne doit pas avoir d’auteur`)
    return
  }

  if (declaration.sourceCode === 'OUGC') {
    const isDailyTelemetry = declaration.cadence === 'DAILY'
    assertInvariant(
      declaration.type === (isDailyTelemetry ? 'api' : 'quick-declaration'),
      `${declaration.sourceId} porte un type OUGC incohérent avec sa cadence`
    )
    assertInvariant(
      declaration.dataSourceType === (isDailyTelemetry ? 'API' : 'MANUAL'),
      `${declaration.sourceId} porte une source OUGC incohérente avec sa cadence`
    )
    assertInvariant(declaration.authorKey === 'ougc', `${declaration.sourceId} doit être saisi par l’OUGC`)
    return
  }

  if (declaration.sourceCode === 'TELEMETRY') {
    assertInvariant(preleveur.type === 'GESTIONNAIRE_AEP', `${declaration.sourceId} doit cibler un gestionnaire AEP`)
    assertInvariant(declaration.type === 'api', `${declaration.sourceId} doit être de type api`)
    assertInvariant(declaration.dataSourceType === 'API', `${declaration.sourceId} doit provenir de l’API`)
    assertInvariant(declaration.authorKey === null, `${declaration.sourceId} ne doit pas avoir d’auteur`)
    return
  }

  assertInvariant(declaration.sourceCode === 'SELF_DECLARATION', `${declaration.sourceId} porte une source inconnue`)
  assertInvariant(declaration.type === 'quick-declaration', `${declaration.sourceId} doit être une déclaration rapide`)
  assertInvariant(declaration.dataSourceType === 'MANUAL', `${declaration.sourceId} doit être manuel`)
  assertInvariant(
    ['irrigant', 'industriel', 'aep'].includes(declaration.authorKey),
    `${declaration.sourceId} doit être saisi par un persona préleveur`
  )
}

function validateDeclarations(dataset, preleveursBySourceId, pointsBySourceId) {
  const {declarations} = dataset
  assertInvariant(Array.isArray(declarations) && declarations.length === 420, 'il faut 420 déclarations')
  assertUnique(declarations, item => item.id, 'les UUID des déclarations')
  assertUnique(declarations, item => item.sourceId, 'les sourceId des déclarations')
  assertUnique(declarations, item => item.importSourceId, 'les importSourceId')
  assertUnique(declarations, item => item.code, 'les codes de déclaration')
  assertInvariant(
    declarations.every(item => /^GR\d{4}$/.test(item.code)),
    'les codes de déclaration doivent suivre le format distinctif GR0001'
  )

  const personaKeys = new Set(Object.keys(dataset.personas))
  const coveredPointIds = new Set(dataset.points.filter(item => item.isCovered).map(item => item.sourceId))
  const matchedPointYears = new Set()
  const matchedPointIds = new Set()
  let unmatchedGidafChunks = 0

  for (const declaration of declarations) {
    const preleveur = preleveursBySourceId.get(declaration.targetKey)
    assertInvariant(preleveur?.reporting.active, `${declaration.sourceId} cible un préleveur inactif ou inconnu`)
    assertInvariant(REFERENCE_YEARS.includes(declaration.year), `${declaration.sourceId} porte une année invalide`)
    assertInvariant(declaration.cadence === preleveur.reporting.cadence, `${declaration.sourceId} porte une cadence invalide`)
    assertInvariant(
      declaration.authorKey === null || personaKeys.has(declaration.authorKey),
      `${declaration.sourceId} porte un auteur inconnu`
    )
    validateDeclarationSource(declaration, preleveur)

    for (const chunk of declaration.chunks) {
      validateChunkValues(chunk, declaration)

      if (chunk.pointSourceId === null) {
        unmatchedGidafChunks += 1
        assertInvariant(declaration.sourceCode === 'GIDAF', `${chunk.sourceId} doit provenir de GIDAF`)
        assertInvariant(chunk.status === 'UNMATCHED', `${chunk.sourceId} doit être non rapproché`)
        assertInvariant(chunk.usageCode === '4', `${chunk.sourceId} doit porter l’usage industriel`)
        assertInvariant(!pointsBySourceId.has(chunk.externalPointId), `${chunk.sourceId} ne doit pas correspondre à un point`)
        continue
      }

      const point = pointsBySourceId.get(chunk.pointSourceId)
      assertInvariant(point?.isCovered, `${chunk.sourceId} doit référencer un point couvert`)
      assertInvariant(chunk.status === 'MATCHED', `${chunk.sourceId} doit être rapproché`)
      assertInvariant(chunk.usageCode === point.usageCode, `${chunk.sourceId} porte un usage incohérent`)
      matchedPointIds.add(chunk.pointSourceId)
      matchedPointYears.add(`${declaration.year}:${chunk.pointSourceId}`)
    }
  }

  assertExactCounts(countBy(declarations, item => item.year), {2025: 210, 2026: 210}, 'l’année')
  const dailyDeclarations = declarations.filter(item => item.cadence === 'DAILY')
  assertInvariant(dailyDeclarations.length === 40, 'les 20 télérelèves journalières doivent couvrir deux années')
  assertInvariant(
    dailyDeclarations.every(item => item.dataSourceType === 'API'),
    'chaque série journalière doit être une télérelève API'
  )
  assertInvariant(matchedPointIds.size === 560, 'les déclarations doivent couvrir 560 points distincts')
  assertInvariant(matchedPointYears.size === 1120, 'chaque point couvert doit être déclaré sur les deux années')
  assertInvariant(
    [...matchedPointIds].every(sourceId => coveredPointIds.has(sourceId)),
    'une déclaration référence un point hors couverture'
  )
  assertInvariant(unmatchedGidafChunks === 4, 'il faut quatre lignes GIDAF non rapprochées')
  assertInvariant(declarations.some(item => item.sourceCode === 'GIDAF'), 'il faut des déclarations GIDAF')
  assertInvariant(declarations.some(item => item.sourceCode === 'OUGC'), 'il faut des déclarations OUGC')
}

export function validateGrivaiseDataset(dataset) {
  assertJsonValue(dataset)
  validateMetadataAndPersonas(dataset)
  validatePreleveurs(dataset.preleveurs)
  validatePoints(dataset.points)

  const preleveursBySourceId = new Map(
    dataset.preleveurs.map(item => [item.sourceId, item])
  )
  const pointsBySourceId = new Map(
    dataset.points.map(item => [item.sourceId, item])
  )
  const exploitationsBySourceId = new Map(
    dataset.exploitations.map(item => [item.sourceId, item])
  )

  validateExploitations(dataset, preleveursBySourceId, pointsBySourceId)
  validateCollectorLinks(dataset, preleveursBySourceId, exploitationsBySourceId)
  validateMeters(dataset.meters, pointsBySourceId)
  validateDeclarations(dataset, preleveursBySourceId, pointsBySourceId)

  return true
}

export function buildGrivaiseDataset() {
  const preleveurs = buildPreleveurs()
  const {points, exploitations} = buildPointsAndExploitations(preleveurs)
  const collectorLinks = buildCollectorLinks(preleveurs, exploitations)
  const meters = buildMeters(points)
  const declarations = buildDeclarations({
    preleveurs,
    points,
    exploitations,
    collectorLinks
  })

  const dataset = {
    metadata: {
      id: DATASET_ID,
      version: 1,
      seed: DATASET_ID,
      sourcePrefix: SOURCE_PREFIX,
      referenceYears: [...REFERENCE_YEARS],
      synthetic: true,
      specialCases: {...SPECIAL_CASES}
    },
    zone: buildZone(),
    personas: buildPersonas(preleveurs),
    preleveurs,
    points,
    exploitations,
    collectorLinks,
    meters,
    declarations
  }

  validateGrivaiseDataset(dataset)
  return dataset
}
