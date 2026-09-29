import test from 'ava'
import {applyReviewedInputs, projectReviewedIdentities} from '../reviewed-inputs.js'
import {buildManifest, digest, stableId} from '../epidropt.js'

const id = label => stableId(`reviewed-input-test:${label}`)
const sourceName = '100CACG_99001'
const evidence = {file: 'synthetic-review.xlsx', cell: 'B2', decision: 'Arbitrage synthétique explicite'}
const row = (values, number = 3) => ({row: number, values})
const pointRow = (name = sourceName, number = 3) => {
  const values = Array(33).fill(null)
  Object.assign(values, {1: name, 3: 0.4, 4: 44.6, 7: 'Eau de surface'})
  return row(values, number)
}

function fixture() {
  return {
    epidropt: {
      'Points prélèvement': [pointRow()],
      Préleveurs: [row([null, 'Irrigant', 'synthetic@example.test', '12345678900001', 'Ferme Synthétique A', null, null, null, null, 'AEAG-SYNTHETIC'])],
      Exploitations: [row([null, sourceName, 'synthetic@example.test', 'Irrigation'])]
    },
    rives: {
      Contrat: [row(['CONTRACT-A', 'CLIENT-A', 'Ferme Synthétique A', 100, 1], 2)],
      Compteur: [row(['METER-A'], 2)],
      Lieu: [row(['PLACE-A', '100', 'Lieu synthétique A', 0.4, 44.6], 2)],
      Affectation: [row(['CONTRACT-A', 'PLACE-A', sourceName, 'METER-A', 100], 2)]
    }
  }
}

function correction(input, sheet, values = {}, fields = {}) {
  const record = input.epidropt[sheet][0]
  return {sheet, row: record.row, expectedHash: digest(record), values, fields, evidence}
}

test('une correction relue conserve la source brute et trace exactement la ligne avant/après', t => {
  const input = fixture()
  const original = structuredClone(input.epidropt)
  const patch = correction(input, 'Exploitations', {2: null}, {countingCode: '001', declarantName: 'Ferme Synthétique A'})
  const result = applyReviewedInputs(input.epidropt, {version: 1, corrections: [patch]})
  t.deepEqual(input.epidropt, original)
  t.is(result.epidropt.Exploitations[0].values[2], null)
  t.is(result.epidropt.Exploitations[0].countingCode, '001')
  t.is(result.epidropt.Exploitations[0].declarantName, 'Ferme Synthétique A')
  t.deepEqual(result.decisions, [{sheet: 'Exploitations', row: 3, beforeHash: patch.expectedHash,
    afterHash: digest(result.epidropt.Exploitations[0]), evidence}])
})

test('toute modification de la ligne source invalide l’arbitrage, y compris un champ annexe', t => {
  for (const mutate of [
    input => { input.epidropt.Exploitations[0].values[3] = 'Usage modifié' },
    input => { input.epidropt.Exploitations[0].countingCode = 'NEW' },
    input => { input.epidropt.Exploitations[0].row = 4 },
    input => { input.epidropt.Exploitations.push(structuredClone(input.epidropt.Exploitations[0])) }
  ]) {
    const input = fixture()
    const review = {version: 1, corrections: [correction(input, 'Exploitations', {2: null})]}
    mutate(input)
    t.throws(() => applyReviewedInputs(input.epidropt, review), {message: 'REVIEWED_INPUT_SOURCE_CHANGED'})
  }
})

test('une correction sans preuve, répétée ou sur un champ interdit est refusée', t => {
  const input = fixture()
  const patch = correction(input, 'Points prélèvement', {24: null})
  for (const broken of [{...patch, evidence: {}}, {...patch, expectedHash: 'unverified'}, {...patch, sheet: 'Autre feuille'}]) {
    t.throws(() => applyReviewedInputs(input.epidropt, {version: 1, corrections: [broken]}), {message: 'REVIEWED_INPUT_PROOF_REQUIRED'})
  }
  t.throws(() => applyReviewedInputs(input.epidropt, {version: 1, corrections: [patch, patch]}), {message: 'REVIEWED_INPUT_ROW_REPEATED'})
  for (const broken of [{...patch, values: {3: 0.8}}, {...patch, fields: {id: id('replacement')}}]) {
    t.throws(() => applyReviewedInputs(input.epidropt, {version: 1, corrections: [broken]}), {message: 'REVIEWED_INPUT_FIELD_FORBIDDEN'})
  }
})

test('une identité ajoutée avec SIRET explicite et sans mail permet une exploitation sans inventer de compte', t => {
  const input = fixture()
  input.epidropt.Préleveurs = []
  const added = row([null, 'Irrigant', null, '12345678900001', 'Ferme Synthétique A'], 100)
  input.overrides = {reviewedInputs: {version: 1,
    corrections: [correction(input, 'Exploitations', {2: null}, {declarantName: 'Ferme Synthétique A', countingCode: '001'})],
    additions: [{sheet: 'Préleveurs', record: added, evidence}]}}
  const manifest = buildManifest(input)
  t.is(manifest.declarants.length, 1)
  t.is(manifest.declarants[0].data.siret, '12345678900001')
  t.is(manifest.declarants[0].user.email, null)
  t.deepEqual(manifest.declarants[0].emails, [])
  t.is(manifest.exploitations.length, 1)
  t.is(manifest.exploitations[0].declarantId, manifest.declarants[0].id)
  t.is(manifest.exploitations[0].countingCode, '001')
  t.true(manifest.reconciliation.some(item => item.kind === 'SOURCE_REVIEW' && item.action === 'ADD_REVIEWED_IDENTITY'))
  t.is(input.epidropt.Préleveurs.length, 0)
})

test('l’ajout relu ne remplace jamais un SIRET existant ni une ligne source et exige une identité', t => {
  const input = fixture()
  const existing = input.epidropt.Préleveurs[0]
  const add = record => applyReviewedInputs(input.epidropt, {version: 1, corrections: [], additions: [{sheet: 'Préleveurs', record, evidence}]})
  t.throws(() => add({...existing, row: 100}), {message: 'REVIEWED_INPUT_ADDITION_ALREADY_PRESENT'})
  t.throws(() => add(row([null, 'Irrigant', null, '12345678900002', 'Autre ferme'], existing.row)), {message: 'REVIEWED_INPUT_ADDITION_ALREADY_PRESENT'})
  for (const values of [[null, 'Irrigant', null, 'bad-siret', 'Autre ferme'], [null, 'Irrigant', null, '12345678900002', null]]) {
    t.throws(() => add(row(values, 100)), {message: 'REVIEWED_INPUT_ADDITION_INVALID'})
  }
})

test('retirer un ancien numéro de compteur dans la ligne relue ne réimporte pas son ancien rattachement', t => {
  const input = fixture()
  input.epidropt['Points prélèvement'][0].values[24] = 'OLD-METER'
  const previousManifest = buildManifest(input)
  t.true(previousManifest.meters.some(meter => meter.serial === 'OLD-METER'))
  input.overrides = {reviewedInputs: {version: 1, corrections: [correction(input, 'Points prélèvement', {24: null})]}}
  const manifest = buildManifest({...input, previousManifest})
  t.deepEqual(manifest.meters.map(meter => meter.serial), ['METER-A'])
  t.is(manifest.allocations.length, 1)
  t.is(manifest.allocations[0].compteurId, manifest.meters[0].id)
  t.is(input.epidropt['Points prélèvement'][0].values[24], 'OLD-METER')
})

test('le nom affiché relu et la précision géographique gardent le nom source comme alias', t => {
  const input = fixture()
  input.overrides = {points: {[sourceName]: {displayName: 'Point revu', geometryPrecision: 'Siège exploitant',
    locationDescription: 'Position provisoire au siège, pas à l’ouvrage', coordinates: [0.5, 44.7]}}}
  const point = buildManifest(input).points[0]
  t.is(point.data.name, 'Point revu')
  t.is(point.data.otherNames, sourceName)
  t.is(point.data.geometryPrecision, 'Siège exploitant')
  t.is(point.data.locationDescription, 'Position provisoire au siège, pas à l’ouvrage')
  t.deepEqual(point.coordinates, [0.5, 44.7])
  t.deepEqual(point.names, [sourceName])
  t.true(point.references.some(reference => reference.provider === 'epidropt' && reference.externalId === sourceName))
})

test('deux noms affichés contradictoires sur une fusion explicite sont refusés', t => {
  const input = fixture()
  const alias = '200CACG_99001'
  input.epidropt['Points prélèvement'].push(pointRow(alias, 4))
  input.overrides = {points: {
    [sourceName]: {lieuId: 'PLACE-A', displayName: 'Nom A'},
    [alias]: {lieuId: 'PLACE-A', displayName: 'Nom B'}
  }}
  t.throws(() => buildManifest(input), {message: 'REVIEWED_POINT_DISPLAY_NAME_CONFLICT'})
  input.overrides.points[alias].displayName = 'Nom A'
  const manifest = buildManifest(input)
  t.is(manifest.points.length, 1)
  t.is(manifest.points[0].data.name, 'Nom A')
  t.true(manifest.points[0].data.otherNames.includes(sourceName))
  t.true(manifest.points[0].data.otherNames.includes(alias))
})

test('deux lieux distincts restent deux PP même avec le même siège et les mêmes coordonnées', t => {
  const input = fixture()
  const secondName = '200CACG_99001'
  input.epidropt['Points prélèvement'].push(pointRow(secondName, 4))
  input.epidropt.Exploitations.push(row([null, secondName, 'synthetic@example.test', 'Irrigation'], 4))
  input.rives.Lieu.push(row(['PLACE-B', '200', 'Lieu synthétique B', 0.4, 44.6], 3))
  input.rives.Compteur.push(row(['METER-B'], 3))
  input.rives.Affectation.push(row(['CONTRACT-A', 'PLACE-B', secondName, 'METER-B', 100], 3))
  input.overrides = {points: Object.fromEntries([sourceName, secondName].map((name, index) => [name,
    {lieuId: index ? 'PLACE-B' : 'PLACE-A', displayName: `Point siège ${index + 1}`,
      coordinates: [0.5, 44.7], geometryPrecision: 'Siège exploitant'}]))}
  const manifest = buildManifest(input)
  t.is(manifest.points.length, 2)
  t.is(new Set(manifest.points.map(point => point.id)).size, 2)
  t.true(manifest.points.every(point => point.data.geometryPrecision === 'Siège exploitant'))
  t.deepEqual(manifest.points.map(point => point.coordinates), [[0.5, 44.7], [0.5, 44.7]])
  t.is(manifest.exploitations.length, 2)
  t.is(manifest.allocations.length, 2)
  t.deepEqual(manifest.issues, [])
})

function projectionFixture() {
  const plan = {scope: 'epidropt', merges: [{sourcePointId: id('old-point'), targetPointId: id('canonical-point'),
    exploitationMerges: [{sourceId: id('old-exploitation'), targetId: id('canonical-exploitation')}]}], retireExploitationIds: [id('retired-exploitation')]}
  const snapshot = {tables: {
    points: [{id: id('old-point')}, {id: id('canonical-point')}],
    exploitations: [{id: id('old-exploitation'), sourceId: 'dropt-epidropt:exploitation:old'},
      {id: id('canonical-exploitation')}, {id: id('retired-exploitation')}], externalReferences: []
  }}
  return {snapshot, plan}
}

test('la projection explicite prépare les alias PP/exploitations sans changer le snapshot source', t => {
  const {snapshot, plan} = projectionFixture()
  const original = structuredClone(snapshot)
  const projected = projectReviewedIdentities(snapshot, plan)
  t.deepEqual(snapshot, original)
  t.deepEqual(projected.tables.points, snapshot.tables.points)
  t.false(projected.tables.exploitations.some(item => item.id === id('retired-exploitation')))
  t.deepEqual(projected.tables.externalReferences, [{provider: 'pe-import-alias', scope: 'epidropt', kind: 'POINT',
    externalId: id('old-point'), pointPrelevementId: id('canonical-point'), metadata: {projectedPlanHash: digest(plan),
      exploitationAliases: [{sourceId: id('old-exploitation'), targetId: id('canonical-exploitation'), sourceSourceId: 'dropt-epidropt:exploitation:old'}]}}])
  t.deepEqual(projectReviewedIdentities(projected, plan), projected)
})

test('la projection refuse un survivant absent, supprimé ou un alias existant contradictoire', t => {
  for (const mutate of [
    snapshot => { snapshot.tables.points.pop() },
    snapshot => { snapshot.tables.points[1].deletedAt = '2026-01-01T00:00:00Z' }
  ]) {
    const {snapshot, plan} = projectionFixture()
    mutate(snapshot)
    t.throws(() => projectReviewedIdentities(snapshot, plan), {message: 'REVIEWED_IDENTITIES_TARGET_INVALID'})
  }
  const {snapshot, plan} = projectionFixture()
  snapshot.tables.externalReferences.push({provider: 'pe-import-alias', scope: 'epidropt', kind: 'POINT',
    externalId: id('old-point'), pointPrelevementId: id('different-point')})
  t.throws(() => projectReviewedIdentities(snapshot, plan), {message: 'REVIEWED_IDENTITIES_ALIAS_CONFLICT'})
})

test('une fusion relue autorise l’ancrage au survivant Rives, jamais une nouvelle identité', t => {
  const input = fixture()
  const previous = buildManifest(input)
  const previousPoint = previous.points[0]
  input.snapshot = {tables: {points: [
    {id: id('old-point'), sourceId: 'dropt-epidropt:point:old'},
    {id: id('canonical-point'), sourceId: 'dropt-epidropt:point:canonical'}
  ], exploitations: [], externalReferences: [
    {provider: 'epidropt', scope: 'epidropt', kind: 'POINT', externalId: sourceName, pointPrelevementId: id('old-point')},
    {provider: 'rives-et-eaux', scope: 'epidropt', kind: 'POINT', externalId: 'PLACE-A', pointPrelevementId: id('canonical-point')}
  ]}}
  t.true(buildManifest(input).reconciliation.some(item => item.reason === 'EXISTING_POINT_IDENTITIES_COLLIDE'))
  input.overrides = {reviewedConsolidationPlan: {scope: 'epidropt', merges: [{sourcePointId: id('old-point'), targetPointId: id('canonical-point')}]}}
  const manifest = buildManifest(input)
  t.is(manifest.points.length, 1)
  t.is(manifest.points[0].id, id('canonical-point'))
  t.not(manifest.points[0].id, previousPoint.id)
  t.is(manifest.points[0].sourceId, 'dropt-epidropt:point:canonical')
  t.is(manifest.exploitations[0].pointId, id('canonical-point'))
  t.deepEqual(manifest.reviewedConsolidationPlan, input.overrides.reviewedConsolidationPlan)
  t.false(manifest.issues.some(item => item.code === 'IDENTITY_LEDGER_CONFLICT'))
})
