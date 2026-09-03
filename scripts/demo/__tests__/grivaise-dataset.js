import test from 'ava'

import {
  buildGrivaiseDataset,
  deterministicUuid as deterministicDatasetUuid,
  validateGrivaiseDataset
} from '../lib/grivaise-dataset.js'
import {
  buildExpectedOwnedContentRecords,
  deterministicUuid as deterministicContentUuid
} from '../lib/seed-content-digest.js'
import {deterministicUuid as deterministicDatabaseUuid} from '../lib/seed-database.js'

const UUID_V4_PATTERN = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/

function getApplicationIds(dataset) {
  return [
    dataset.zone.id,
    ...Object.values(dataset.personas).map(persona => persona.id),
    ...dataset.preleveurs.map(item => item.id),
    ...dataset.points.map(item => item.id),
    ...dataset.exploitations.map(item => item.id),
    ...dataset.collectorLinks.map(item => item.id),
    ...dataset.meters.map(item => item.id),
    ...dataset.declarations.flatMap(declaration => [
      declaration.id,
      ...declaration.chunks.map(chunk => chunk.id)
    ])
  ]
}

function countBy(items, getKey) {
  const result = {}

  for (const item of items) {
    const key = getKey(item)
    result[key] = (result[key] ?? 0) + 1
  }

  return result
}

function groupBy(items, getKey) {
  const result = new Map()

  for (const item of items) {
    const key = getKey(item)
    const values = result.get(key) ?? []
    values.push(item)
    result.set(key, values)
  }

  return result
}

test('construit un contrat JSON déterministe et valide', t => {
  const first = buildGrivaiseDataset()
  const firstJson = JSON.stringify(first)
  const secondJson = JSON.stringify(buildGrivaiseDataset())

  t.true(validateGrivaiseDataset(first))
  t.is(secondJson, firstJson)
  t.is(JSON.stringify(JSON.parse(firstJson)), firstJson)
  t.deepEqual(Object.keys(first), [
    'metadata',
    'zone',
    'personas',
    'preleveurs',
    'points',
    'exploitations',
    'collectorLinks',
    'meters',
    'declarations'
  ])
  t.is(first.metadata.id, 'grivaise-v1')
  t.is(first.metadata.version, 1)
  t.deepEqual(first.metadata.referenceYears, [2025, 2026])
  t.true(getApplicationIds(first).every(id => UUID_V4_PATTERN.test(id)))
})

test('génère exclusivement des UUID v4 jusque dans les enregistrements persistés', t => {
  const dataset = buildGrivaiseDataset()
  const contentRecords = buildExpectedOwnedContentRecords(dataset)
  const persistedContentIds = Object.values(contentRecords)
    .flatMap(records => records.map(record => record.id))

  t.true(persistedContentIds.every(id => UUID_V4_PATTERN.test(id)))
  t.regex(deterministicDatasetUuid('controle-dataset'), UUID_V4_PATTERN)
  t.regex(deterministicContentUuid(dataset.metadata.id, 'controle-contenu'), UUID_V4_PATTERN)
  t.regex(deterministicDatabaseUuid(dataset.metadata.id, 'controle-persistance'), UUID_V4_PATTERN)
})

test('respecte les populations, usages, départements et cohortes Grivaise', t => {
  const dataset = buildGrivaiseDataset()
  const activePreleveurs = dataset.preleveurs.filter(item => item.reporting.active)

  t.is(dataset.preleveurs.length, 300)
  t.deepEqual(countBy(dataset.preleveurs, item => item.type), {
    IRRIGANT: 240,
    ICPE: 30,
    GESTIONNAIRE_AEP: 30
  })
  t.is(activePreleveurs.length, 210)
  t.deepEqual(countBy(activePreleveurs, item => item.type), {
    IRRIGANT: 201,
    ICPE: 4,
    GESTIONNAIRE_AEP: 5
  })
  t.deepEqual(countBy(activePreleveurs, item => item.reporting.cadence), {
    MONTHLY: 150,
    WEEKLY: 40,
    DAILY: 20
  })

  t.is(dataset.points.length, 800)
  t.deepEqual(countBy(dataset.points, item => item.usageCode), {
    2: 700,
    4: 50,
    5: 50
  })
  t.deepEqual(countBy(dataset.points, item => item.departmentCode), {
    'dep-38': 400,
    'dep-26': 400
  })
  t.deepEqual(countBy(dataset.points, item => item.waterBodyType), {
    SUPERFICIELLE: 400,
    SOUTERRAIN: 400
  })
  t.is(dataset.points.filter(item => item.isCovered).length, 560)
  t.deepEqual(
    countBy(dataset.points.filter(item => item.isCovered), item => item.usageCode),
    {2: 511, 4: 24, 5: 25}
  )
  t.true(dataset.points.every(item => item.name.startsWith('Démo Grivaise — ')))
})

test('répartit les points selon une implantation réaliste sans quadrillage', t => {
  const dataset = buildGrivaiseDataset()
  const coordinateKeys = dataset.points.map(point => point.coordinates.coordinates.join(':'))

  t.is(new Set(coordinateKeys).size, 800)
  t.true(dataset.zone.geojson.geometry.coordinates[0].length > 100)

  for (const [departmentCode, minimumSpans] of Object.entries({
    'dep-26': {longitude: 0.2, latitude: 0.1},
    'dep-38': {longitude: 0.5, latitude: 0.15}
  })) {
    const coordinates = dataset.points
      .filter(point => point.departmentCode === departmentCode)
      .map(point => point.coordinates.coordinates)
    const longitudes = coordinates.map(([longitude]) => longitude)
    const latitudes = coordinates.map(([, latitude]) => latitude)

    t.true(new Set(longitudes).size >= 390)
    t.true(new Set(latitudes).size >= 390)
    t.true(Math.max(...longitudes) - Math.min(...longitudes) > minimumSpans.longitude)
    t.true(Math.max(...latitudes) - Math.min(...latitudes) > minimumSpans.latitude)
  }
})

test('matérialise les bénéficiaires OUGC et les deux cas de points spéciaux', t => {
  const dataset = buildGrivaiseDataset()
  const exploitationsByPoint = groupBy(
    dataset.exploitations,
    item => item.pointSourceId
  )
  const metersByPoint = groupBy(dataset.meters, item => item.pointSourceId)
  const {
    sharedPointSourceId,
    multiMeterPointSourceId
  } = dataset.metadata.specialCases

  t.is(dataset.collectorLinks.length, 200)
  t.is(new Set(dataset.collectorLinks.map(item => item.preleveurSourceId)).size, 200)
  t.true(dataset.collectorLinks.every(item => item.collectorKey === 'ougc'))
  t.true(dataset.collectorLinks.every(link =>
    dataset.preleveurs.find(item => item.sourceId === link.preleveurSourceId).reporting.active))
  t.false(dataset.collectorLinks.some(link =>
    link.preleveurSourceId === dataset.personas.irrigant.preleveurSourceId))
  t.is(new Set(
    dataset.exploitations
      .filter(item => item.isPrimary)
      .map(item => item.preleveurSourceId)
  ).size, 300)
  t.true(dataset.exploitations.every(exploitation => {
    const point = dataset.points.find(item => item.sourceId === exploitation.pointSourceId)
    const preleveur = dataset.preleveurs.find(
      item => item.sourceId === exploitation.preleveurSourceId
    )

    return point.departmentCode === preleveur.departmentCode
  }))
  t.is(exploitationsByPoint.get(sharedPointSourceId).length, 2)
  t.is(new Set(
    exploitationsByPoint.get(sharedPointSourceId).map(item => item.preleveurSourceId)
  ).size, 2)
  t.is(metersByPoint.get(multiMeterPointSourceId).length, 2)
  t.is([...metersByPoint.values()].filter(items => items.length > 1).length, 1)
})

test('produit les déclarations 2025/2026, GIDAF et les lignes non rapprochées', t => {
  const dataset = buildGrivaiseDataset()
  const chunks = dataset.declarations.flatMap(declaration => declaration.chunks)
  const matchedChunks = chunks.filter(chunk => chunk.status === 'MATCHED')
  const unmatchedChunks = chunks.filter(chunk => chunk.status === 'UNMATCHED')
  const sourceCodes = new Set(dataset.declarations.map(item => item.sourceCode))
  const industrialPersonaSourceId = dataset.personas.industriel.preleveurSourceId
  const industrialPersonaDeclarations = dataset.declarations.filter(
    declaration => declaration.targetKey === industrialPersonaSourceId
  )
  const gidafDeclarations = dataset.declarations.filter(item => item.sourceCode === 'GIDAF')
  const ougcDeclarations = dataset.declarations.filter(item => item.sourceCode === 'OUGC')
  const dailyOugcDeclarations = ougcDeclarations.filter(item => item.cadence === 'DAILY')

  t.is(dataset.declarations.length, 420)
  t.is(dataset.declarations[0].code, 'GR0001')
  t.is(dataset.declarations.at(-1).code, 'GR0420')
  t.true(dataset.declarations.every(declaration => /^GR\d{4}$/.test(declaration.code)))
  t.deepEqual(countBy(dataset.declarations, item => item.year), {
    2025: 210,
    2026: 210
  })
  t.is(new Set(matchedChunks.map(chunk => chunk.pointSourceId)).size, 560)
  t.is(new Set(matchedChunks.map(chunk => `${chunk.sourceId}:${chunk.pointSourceId}`)).size, 1120)
  t.is(unmatchedChunks.length, 4)
  t.true(unmatchedChunks.every(chunk => chunk.pointSourceId === null))
  t.true(unmatchedChunks.every(chunk => chunk.usageCode === '4'))
  t.deepEqual([...sourceCodes].sort(), [
    'GIDAF',
    'OUGC',
    'SELF_DECLARATION',
    'TELEMETRY'
  ])
  t.true(dataset.declarations
    .filter(item => item.sourceCode === 'GIDAF')
    .every(item => item.type === 'gidaf' && item.dataSourceType === 'SPREADSHEET'))
  t.true(gidafDeclarations.every(item => item.targetKey !== industrialPersonaSourceId))
  t.true(gidafDeclarations.every(declaration => {
    const preleveur = dataset.preleveurs.find(item => item.sourceId === declaration.targetKey)
    return preleveur.type === 'ICPE' && preleveur.personaKey === null
  }))
  t.is(industrialPersonaDeclarations.length, 2)
  t.true(industrialPersonaDeclarations.every(declaration =>
    declaration.sourceCode === 'SELF_DECLARATION'
    && declaration.type === 'quick-declaration'
    && declaration.dataSourceType === 'MANUAL'
    && declaration.authorKey === 'industriel'))
  t.true(unmatchedChunks.every(chunk => gidafDeclarations.some(declaration =>
    declaration.chunks.includes(chunk))))
  t.is(dailyOugcDeclarations.length, 40)
  t.true(dailyOugcDeclarations.every(item =>
    item.type === 'api'
    && item.dataSourceType === 'API'
    && item.authorKey === 'ougc'))
  t.true(ougcDeclarations
    .filter(item => item.cadence !== 'DAILY')
    .every(item => item.type === 'quick-declaration' && item.dataSourceType === 'MANUAL'))
  t.true(dataset.declarations
    .filter(item => item.cadence === 'DAILY')
    .every(item => item.dataSourceType === 'API'))
  t.true(dataset.declarations.every(declaration =>
    declaration.sourceId.startsWith(dataset.metadata.sourcePrefix)
    && declaration.importSourceId.startsWith(`${dataset.metadata.id}:`)
    && /^GR\d{4}$/.test(declaration.code)))
  t.true(chunks.every(chunk =>
    typeof chunk.usageCode === 'string'
    && ['MONTHLY', 'WEEKLY', 'DAILY'].includes(chunk.cadence)
    && chunk.values.length > 0))
})

test('refuse un jeu dont une postcondition métier dérive', t => {
  const dataset = buildGrivaiseDataset()
  dataset.points[0].departmentCode = 'dep-26'

  const error = t.throws(() => validateGrivaiseDataset(dataset))

  t.regex(error.message, /le département dep-38 doit valoir 400/)
})
