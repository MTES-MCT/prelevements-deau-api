import test from 'ava'
import {cacgNameVariants, resolvePointMatches} from '../reconciliation.js'

// Synthetic records only: the resolver neither opens workbooks nor touches a DB.
const sourceName = '24000000396CACG_99001'
const position = [0.4, 44.6]
const farPosition = [0.8, 44.7]

function point({name = sourceName, serial = '', location = position, identifier = null, row = 3} = {}) {
  const values = Array(25).fill(null)
  values[1] = name
  values[3] = location?.[0] ?? null
  values[4] = location?.[1] ?? null
  values[11] = identifier
  values[24] = serial
  return {row, values}
}

function place({id = 'L-A', codeOU = 'OU-A', location = position} = {}) {
  return {id, codeOU, coordinates: location}
}

function assignment({lieuId = 'L-A', pointName = 'AUTRE-CACG_99002', serial = 'SYNTHETIC-A', contractId = 'CACG_99001'} = {}) {
  return {lieuId, pointName, serial, contractId}
}

function match(input = {}) {
  return resolvePointMatches({pointRows: [point()], lieux: [place()], assignments: [assignment()], ...input})
    .get(input.pointRows?.[0]?.values[1] ?? sourceName)
}

test('le préfixe CACG normalisé sert de code OU avec une preuve géographique, sans altérer la source', t => {
  const input = {pointRows: [point()], lieux: [place({codeOU: '396'})], assignments: [assignment()]}
  const before = structuredClone(input)
  const result = match(input)
  t.is(result.status, 'ACCEPTED')
  t.is(result.method, 'CODE_OR_PLACE_WITH_EVIDENCE')
  t.deepEqual(result.candidates, ['L-A'])
  t.deepEqual(result.names, [sourceName])
  t.deepEqual(result.sources, [{sheet: 'Points prélèvement', row: 3}])
  t.deepEqual(result.evidence.variants, [sourceName, '396CACG_99001'])
  t.deepEqual(result.evidence.codePlaces, ['L-A'])
  t.deepEqual(input, before)
})

test('le code OU normalisé accepte la preuve compteur même sans coordonnées proches', t => {
  const result = match({
    pointRows: [point({serial: 'SYNTHETIC-A'})],
    lieux: [place({codeOU: '396', location: farPosition})]
  })
  t.is(result.status, 'ACCEPTED')
  t.is(result.method, 'CODE_OR_PLACE_WITH_EVIDENCE')
  t.deepEqual(result.evidence.coordinatePlaces, [])
  t.deepEqual(result.evidence.serialPlaces, ['L-A'])
})

test('un code OU normalisé sans compteur ni coordonnées concordantes reste en revue', t => {
  const result = match({lieux: [place({codeOU: '396', location: farPosition})]})
  t.is(result.status, 'REVIEW')
  t.is(result.reason, 'CORROBORATION_MISSING')
  t.is(result.method, 'CODE_OR_PLACE_WITH_EVIDENCE')
})

test('une contradiction compteur bloque le code normalisé malgré les coordonnées et le contrat concordants', t => {
  const result = match({
    pointRows: [point({serial: 'SYNTHETIC-B'})],
    lieux: [place({codeOU: '396'}), place({id: 'L-B', location: farPosition})],
    assignments: [assignment(), assignment({lieuId: 'L-B', serial: 'SYNTHETIC-B', contractId: 'CACG_99003'})]
  })
  t.is(result.status, 'REVIEW')
  t.is(result.reason, 'CONTRADICTORY_SERIAL_REFERENCE')
  t.deepEqual(result.candidates, ['L-A'])
})

test('plusieurs lieux portant le même code normalisé restent ambigus, même avec un compteur concordant', t => {
  const result = match({
    pointRows: [point({serial: 'SYNTHETIC-A'})],
    lieux: [place({codeOU: '396'}), place({id: 'L-B', codeOU: '396'})]
  })
  t.is(result.method, 'CODE_OR_PLACE_WITH_EVIDENCE')
  t.is(result.status, 'REVIEW')
  t.is(result.reason, 'MULTIPLE_RIVES_PLACES')
  t.deepEqual(result.candidates, ['L-A', 'L-B'])
})

test('compteur et coordonnées à moins de cinq mètres rapprochent des noms et codes différents', t => {
  const result = match({
    pointRows: [point({serial: 'SYNTHETIC-A'})],
    lieux: [place({location: [0.40005, 44.6]})]
  })
  t.is(result.status, 'ACCEPTED')
  t.is(result.method, 'SERIAL_AND_COORDINATES')
  t.deepEqual(result.candidates, ['L-A'])
  t.deepEqual(result.evidence.codePlaces, [])
  t.deepEqual(result.matchedNames, ['AUTRE-CACG_99002'])
})

test('le repli compteur exige bien les deux preuves, pas un numéro seul ou des coordonnées seules', t => {
  for (const location of [null, [0.4001, 44.6]]) {
    const result = match({pointRows: [point({serial: 'SYNTHETIC-A', location})]})
    t.is(result.status, 'UNMATCHED')
    t.is(result.reason, 'NO_RIVES_MATCH')
    t.deepEqual(result.candidates, [])
  }
  const onlyCoordinates = match({assignments: [assignment({contractId: 'CACG_99003'})]})
  t.is(onlyCoordinates.status, 'UNMATCHED')
  t.deepEqual(onlyCoordinates.candidates, [])
})

test('un compteur partagé ne choisit qu’un lieu géographiquement corroboré, sans perdre les autres preuves', t => {
  const result = match({
    pointRows: [point({serial: 'SYNTHETIC-A'})],
    lieux: [place(), place({id: 'L-B', location: farPosition})],
    assignments: [assignment(), assignment({lieuId: 'L-B'})]
  })
  t.is(result.status, 'ACCEPTED')
  t.is(result.method, 'SERIAL_AND_COORDINATES')
  t.deepEqual(result.candidates, ['L-A'])
  t.deepEqual(result.evidence.serialPlaces, ['L-A', 'L-B'])
})

test('plusieurs lieux proches du même compteur restent en revue, indépendamment de leur ordre', t => {
  const input = {
    pointRows: [point({serial: ' SYNTHETIC-A ; SYNTHETIC-B ; SYNTHETIC-A '})],
    lieux: [place(), place({id: 'L-B'})],
    assignments: [assignment(), assignment({lieuId: 'L-B', serial: 'SYNTHETIC-B'})]
  }
  for (const reversed of [false, true]) {
    if (reversed) {
      input.lieux.reverse()
      input.assignments.reverse()
    }
    const result = match(input)
    t.is(result.method, 'SERIAL_AND_COORDINATES')
    t.is(result.status, 'REVIEW')
    t.is(result.reason, 'MULTIPLE_RIVES_PLACES')
    t.deepEqual([...result.candidates].sort(), ['L-A', 'L-B'])
    t.deepEqual(result.evidence.serials, ['SYNTHETIC-A', 'SYNTHETIC-B'])
  }
})

test('le contrat CACG complet et les coordonnées rapprochent un point sans numéro de compteur source', t => {
  const result = match()
  t.is(result.status, 'ACCEPTED')
  t.is(result.method, 'CONTRACT_AND_COORDINATES')
  t.deepEqual(result.candidates, ['L-A'])
  t.deepEqual(result.evidence.contractPlaces, ['L-A'])
  t.deepEqual(result.evidence.serialPlaces, [])
})

test('un contrat seul, un suffixe tronqué ou un numéro client seul ne suffisent pas', t => {
  const withoutCoordinates = match({pointRows: [point({location: null})]})
  t.is(withoutCoordinates.status, 'UNMATCHED')
  for (const contractId of ['CACG_990010', 'CACG_9900', '99001', 'CACG_99002']) {
    const result = match({assignments: [assignment({contractId})]})
    t.is(result.status, 'UNMATCHED')
    t.deepEqual(result.evidence.contractPlaces, [])
  }
})

test('le contrat ne contourne jamais un numéro de compteur reconnu sur un autre lieu', t => {
  const result = match({
    pointRows: [point({serial: 'SYNTHETIC-B'})],
    lieux: [place(), place({id: 'L-B', location: farPosition})],
    assignments: [assignment(), assignment({lieuId: 'L-B', serial: 'SYNTHETIC-B', contractId: 'CACG_99003'})]
  })
  t.is(result.status, 'UNMATCHED')
  t.is(result.method, 'NO_MATCH')
  t.deepEqual(result.evidence.contractPlaces, ['L-A'])
  t.deepEqual(result.evidence.coordinatePlaces, ['L-A'])
  t.deepEqual(result.evidence.serialPlaces, ['L-B'])
})

test('un même contrat présent sur deux lieux proches reste ambigu et les doublons de lignes ne votent pas', t => {
  const result = match({
    lieux: [place(), place({id: 'L-B'})],
    assignments: [assignment(), assignment(), assignment({lieuId: 'L-B'})]
  })
  t.is(result.method, 'CONTRACT_AND_COORDINATES')
  t.is(result.status, 'REVIEW')
  t.is(result.reason, 'MULTIPLE_RIVES_PLACES')
  t.deepEqual(result.candidates, ['L-A', 'L-B'])
})

test('les codes OU 34175 et 34453 restent deux identités même avec contrat et coordonnées identiques', t => {
  const names = ['4700034175CACG_99001', '4700034453CACG_99001']
  t.deepEqual(cacgNameVariants(names[0]), [names[0], '34175CACG_99001'])
  t.deepEqual(cacgNameVariants(names[1]), [names[1], '34453CACG_99001'])
  const input = {
    pointRows: names.map((name, index) => point({name, row: index + 3})),
    lieux: [place({codeOU: '34175'}), place({id: 'L-B', codeOU: '34453'})],
    assignments: [assignment(), assignment({lieuId: 'L-B', serial: 'SYNTHETIC-B'})]
  }
  const results = resolvePointMatches(input)
  for (const [index, name] of names.entries()) {
    const result = results.get(name)
    t.is(result.status, 'ACCEPTED')
    t.is(result.method, 'CODE_OR_PLACE_WITH_EVIDENCE')
    t.deepEqual(result.candidates, [index ? 'L-B' : 'L-A'])
    t.deepEqual(result.evidence.contractPlaces, ['L-A', 'L-B'])
  }
})

test('les nouveaux replis ne remplacent pas un nom exact ou un arbitrage explicite', t => {
  const input = {
    pointRows: [point()],
    lieux: [place({location: farPosition}), place({id: 'L-B'})],
    assignments: [assignment({pointName: sourceName}), assignment({lieuId: 'L-B'})]
  }
  t.is(match(input).method, 'EXACT_NAME')
  t.deepEqual(match(input).candidates, ['L-A'])
  const explicit = match({...input, overrides: {points: {[sourceName]: {lieuId: 'L-B'}}}})
  t.is(explicit.method, 'EXPLICIT_MAPPING')
  t.is(explicit.status, 'ACCEPTED')
  t.deepEqual(explicit.candidates, ['L-B'])
})

test('une nouvelle preuve ne fusionne pas deux PP déjà importés et ancrés sur des UUID distincts', t => {
  for (const serial of ['', 'SYNTHETIC-A']) {
    const result = match({
      pointRows: [point({serial})],
      snapshot: {tables: {externalReferences: [
        {kind: 'POINT', provider: 'epidropt', externalId: sourceName, pointPrelevementId: '11111111-1111-4111-8111-111111111111'},
        {kind: 'POINT', provider: 'rives-et-eaux', externalId: 'L-A', pointPrelevementId: '22222222-2222-4222-8222-222222222222'}
      ]}}
    })
    t.is(result.method, serial ? 'SERIAL_AND_COORDINATES' : 'CONTRACT_AND_COORDINATES')
    t.is(result.status, 'REVIEW')
    t.is(result.reason, 'EXISTING_POINT_IDENTITIES_COLLIDE')
    t.is(result.evidence.existingPointIds.length, 2)
  }
})

test('un nouveau rapprochement conserve un PP existant déjà ancré sur le même lieu', t => {
  const id = '11111111-1111-4111-8111-111111111111'
  const result = match({previousManifest: {points: [{id, references: [
    {provider: 'epidropt', externalId: sourceName},
    {provider: 'rives-et-eaux', externalId: 'L-A'}
  ]}]}})
  t.is(result.status, 'ACCEPTED')
  t.is(result.method, 'CONTRACT_AND_COORDINATES')
  t.is(result.reason, null)
})

test('un PP non CACG reste exclu de Rives même avec compteur et coordonnées concordants', t => {
  const result = match({pointRows: [point({name: '24000000396', serial: 'SYNTHETIC-A'})]})
  t.is(result.supplyCategory, 'NON_REALIMENTE')
  t.is(result.status, 'EXCLUDED')
  t.is(result.method, 'NON_REALIMENTE')
  t.deepEqual(result.candidates, [])
})
