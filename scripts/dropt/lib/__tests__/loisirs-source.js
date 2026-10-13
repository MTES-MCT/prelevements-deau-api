import test from 'ava'
import {buildManifest, digest} from '../epidropt.js'
import {buildLoisirsManifest, validateLoisirsManifest, LOISIRS_POLICY} from '../loisirs-source.js'

const resign = manifest => {
  const {manifestHash: _hash, ...payload} = manifest
  return {...payload, manifestHash: digest(payload)}
}

function fixture() {
  const epidropt = {'Points prélèvement': [], Préleveurs: [], Exploitations: []}
  for (const [index, usage] of ['Loisirs', 'Loisirs', 'Domestique', 'Alimentation en eau potable'].entries()) {
    const row = index + 3
    const name = `POINT-SYNTHETIQUE-${index}`
    const point = Array(38).fill(null)
    Object.assign(point, {1: name, 3: 0.4 + (index / 100), 4: 44.6, 7: 'Eau de surface', 24: `COMPTEUR-SYNTHETIQUE-${index}`})
    epidropt['Points prélèvement'].push({row, values: point})
    const email = `club-${index}@example.test`
    epidropt.Préleveurs.push({row, values: [null, 'Autres', email, `1234567890000${index}`, `Club fictif ${index}`]})
    epidropt.Exploitations.push({row, values: [null, name, email, usage]})
  }
  // A historical unresolved row: a source contact belongs to two accounts.
  epidropt.Préleveurs.push({row: 7, values: [null, 'Autres', 'club-1@example.test', '12345678900009', 'Autre club fictif']})
  const previousManifest = buildManifest({epidropt, rives: {Contrat: [], Compteur: [], Lieu: [], Affectation: []}})
  const source = {name: 'loisirs-synthetic.xlsx', sha256: 'a'.repeat(64)}
  const decisions = {version: 1, sourceSha256: source.sha256, previousManifestHash: previousManifest.manifestHash,
    exploitations: epidropt.Exploitations.slice(0, 2).map(({row, values}, index) => ({row, rowHash: digest(values), pointName: values[1],
      declarantKey: previousManifest.declarants.find(owner => owner.data.siret === `1234567890000${index}`).key,
      declarantSiret: `1234567890000${index}`}))}
  return {epidropt, previousManifest, decisions, source}
}

test('Loisirs reprend les UUID historiques et ajoute seulement le lien manquant, sans compteur ni AEP', t => {
  const input = fixture()
  const before = structuredClone(input)
  const manifest = buildLoisirsManifest(input)
  t.is(validateLoisirsManifest(manifest), manifest)
  t.deepEqual(manifest.loisirsPolicy, LOISIRS_POLICY)
  t.deepEqual(input, before)
  t.is(manifest.points.length, 2)
  t.is(manifest.declarants.length, 2)
  t.is(manifest.exploitations.length, 2)
  t.true(manifest.exploitations.every(row => row.usageCode === '7'))
  for (const kind of ['points', 'declarants']) {
    for (const row of manifest[kind]) t.deepEqual(row, input.previousManifest[kind].find(previous => previous.id === row.id))
  }
  const old = input.previousManifest.exploitations.find(row => row.usageCode === '7')
  t.like(manifest.exploitations.find(row => row.id === old.id), {id: old.id, key: old.key, sourceId: old.sourceId})
  t.deepEqual(manifest.loisirsEvidence.anchors.exploitations.map(row => row.existedBefore).sort(), [false, true])
  t.true(input.previousManifest.meters.length > 0)
  t.deepEqual(manifest.meters, [])
  t.deepEqual(manifest.allocations, [])
  t.deepEqual(manifest.contracts, [])
  t.deepEqual(manifest.issues, [])
  t.false(Object.hasOwn(manifest, 'retirements'))
})

test('ordre des décisions stable et seconde préparation strictement identique', t => {
  const input = fixture()
  const first = buildLoisirsManifest(input)
  input.decisions.exploitations.reverse()
  t.deepEqual(buildLoisirsManifest(input), first)
  t.deepEqual(buildLoisirsManifest(input), first)
})

test('un UUID historique non régénéré reste une ancre exacte', t => {
  const input = fixture()
  const owner = input.previousManifest.declarants.find(row => row.key === input.decisions.exploitations[0].declarantKey)
  const point = input.previousManifest.points.find(row => row.data.name === input.decisions.exploitations[0].pointName)
  const oldOwnerId = owner.id
  const oldPointId = point.id
  owner.id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
  point.id = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
  const old = input.previousManifest.exploitations.find(row => row.declarantId === oldOwnerId && row.pointId === oldPointId)
  Object.assign(old, {declarantId: owner.id, pointId: point.id, id: 'cccccccc-cccc-4ccc-cccc-cccccccccccc'})
  input.previousManifest = resign(input.previousManifest)
  input.decisions.previousManifestHash = input.previousManifest.manifestHash
  const manifest = buildLoisirsManifest(input)
  t.like(manifest.exploitations.find(row => row.id === old.id), {pointId: point.id, declarantId: owner.id, sourceId: old.sourceId})
})

test('le propriétaire ambigu exige une décision exacte et ne devient jamais un choix approximatif', t => {
  const input = fixture()
  input.decisions.exploitations[1].declarantSiret = '12345678900999'
  t.throws(() => buildLoisirsManifest(input), {code: 'LOISIRS_EXISTING_DECLARANT_REQUIRED'})
  const missing = fixture()
  missing.decisions.exploitations[1].declarantKey = 'epidropt:preleveur:siret:12345678900999'
  t.throws(() => buildLoisirsManifest(missing), {code: 'LOISIRS_EXISTING_DECLARANT_REQUIRED'})
})

test('une ligne, un classeur ou un registre historique modifié invalide la préparation', t => {
  const changedRow = fixture()
  changedRow.epidropt.Exploitations[0].values[2] = 'changed@example.test'
  t.throws(() => buildLoisirsManifest(changedRow), {code: 'LOISIRS_SOURCE_ROW_CHANGED'})
  const changedFile = fixture()
  changedFile.source.sha256 = 'b'.repeat(64)
  t.throws(() => buildLoisirsManifest(changedFile), {code: 'LOISIRS_SOURCE_CHANGED'})
  const changedPrevious = fixture()
  changedPrevious.previousManifest.points[0].data.name = 'Changed'
  t.throws(() => buildLoisirsManifest(changedPrevious), {code: 'LOISIRS_PREVIOUS_MANIFEST_HASH_INVALID'})
})

test('Domestique17 et AEP5 ne peuvent pas entrer dans une sélection Loisirs7', t => {
  for (const index of [2, 3]) {
    const input = fixture()
    const source = input.epidropt.Exploitations[index]
    input.decisions.exploitations[0] = {...input.decisions.exploitations[0], row: source.row, rowHash: digest(source.values), pointName: source.values[1]}
    t.throws(() => buildLoisirsManifest(input), {code: 'LOISIRS_SOURCE_ROW_CHANGED'})
  }
})

test('une exploitation historiquement classée autrement exige une revue séparée', t => {
  const input = fixture()
  input.previousManifest.exploitations.find(row => row.usageCode === '7').usageCode = '17'
  input.previousManifest = resign(input.previousManifest)
  input.decisions.previousManifestHash = input.previousManifest.manifestHash
  t.throws(() => buildLoisirsManifest(input), {code: 'LOISIRS_EXISTING_EXPLOITATION_CHANGED'})
})

test('un point absent du registre historique ne devient pas une création implicite', t => {
  const input = fixture()
  input.previousManifest.points = input.previousManifest.points.filter(row => row.data.name !== input.decisions.exploitations[1].pointName)
  input.previousManifest = resign(input.previousManifest)
  input.decisions.previousManifestHash = input.previousManifest.manifestHash
  t.throws(() => buildLoisirsManifest(input), {code: 'LOISIRS_EXISTING_IDENTITY_REQUIRED'})
})

test('doublons et extension arbitraire des décisions sont refusés', t => {
  const duplicate = fixture()
  duplicate.decisions.exploitations.push(duplicate.decisions.exploitations[0])
  t.throws(() => buildLoisirsManifest(duplicate), {code: 'LOISIRS_SELECTION_INVALID'})
  const override = fixture()
  override.decisions.exploitations[0].id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
  t.throws(() => buildLoisirsManifest(override), {code: 'LOISIRS_SELECTION_INVALID'})
})

test('validation autonome refuse un manifeste resigné contenant compteurs, retraits ou une politique différente', t => {
  const initial = buildLoisirsManifest(fixture())
  for (const change of [manifest => manifest.meters.push({id: 'unexpected'}), manifest => { manifest.retirements = [] },
    manifest => { manifest.loisirsPolicy.collectors = 'CREATE' }]) {
    const manifest = structuredClone(initial)
    change(manifest)
    t.throws(() => validateLoisirsManifest(resign(manifest)), {code: 'LOISIRS_POLICY_INVALID'})
  }
})

test('validation protège les profils historiques, les dépendances et les ancrages', t => {
  const initial = buildLoisirsManifest(fixture())
  const changed = structuredClone(initial)
  changed.declarants[0].data.socialReason = 'Une autre personne morale'
  t.throws(() => validateLoisirsManifest(resign(changed)), {code: 'LOISIRS_ANCHOR_INVALID'})
  const reassigned = structuredClone(initial)
  reassigned.exploitations[0].declarantId = reassigned.declarants.find(row => row.id !== reassigned.exploitations[0].declarantId).id
  const anchor = reassigned.loisirsEvidence.anchors.exploitations.find(row => row.id === reassigned.exploitations[0].id)
  anchor.recordHash = digest(reassigned.exploitations[0])
  t.throws(() => validateLoisirsManifest(resign(reassigned)), {code: 'LOISIRS_EXPLOITATION_INVALID'})
})
