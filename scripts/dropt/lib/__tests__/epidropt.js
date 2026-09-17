import test from 'ava'
import {buildManifest, coordinates, digest, emails, stableId} from '../epidropt.js'

function row(values, number = 3) {
  return {row: number, values}
}

function fixture() {
  const point = Array(33).fill(null)
  point[1] = 'OU-A'
  point[2] = 'prélèvement'
  point[3] = 0.4
  point[4] = 44.6
  point[7] = 'Eau de surface'
  point[8] = "cours d'eau"
  point[9] = 'Superficiel'
  const owner = [null, 'Irrigant', 'contact@example.test;', '12345678900001', 'Ferme A', null, null, null, null, 'AEAG-A']
  return {
    epidropt: {'Points prélèvement': [row(point)], Préleveurs: [row(owner)], Exploitations: [row([null, 'OU-A', 'contact@example.test', 'Irrigation'])]},
    rives: {Contrat: [row(['C-A', 'CLIENT-A', 'Ferme A', 10000, 5], 2)], Compteur: [row(['SN/A'], 2)], Lieu: [row(['L-A', 'OU-A', 'Lieu A', 0.4, 44.6], 2)], Affectation: [row(['C-A', 'L-A', 'OU-A', 'SN/A', 100], 2)]}
  }
}

test('identités stables, contacts distincts de l’accès et compteur physique non découpé', t => {
  const manifest = buildManifest(fixture())
  t.is(manifest.points.length, 1)
  t.is(manifest.declarants.length, 1)
  t.is(manifest.exploitations.length, 1)
  t.is(manifest.meters[0].serial, 'SN/A')
  t.true(manifest.meters[0].allocationSnapshotValidated)
  t.is(manifest.declarants[0].user.email, null)
  t.deepEqual(manifest.declarants[0].emails, ['contact@example.test'])
  t.deepEqual(manifest.issues, [])
  t.is(stableId('a'), stableId('a'))
  t.not(stableId('a'), stableId('b'))
})

test('deux contrats du même client ne créent ni deux points ni deux exploitations', t => {
  const input = fixture()
  input.rives.Contrat.push(row(['C-B', 'CLIENT-A', 'Ferme A', 20000, 8]))
  input.rives.Affectation[0].values[4] = 60
  input.rives.Affectation.push(row(['C-B', 'L-A', 'OU-A', 'SN/A', 40]))
  const result = buildManifest(input)
  t.is(result.points.length, 1)
  t.is(result.exploitations.length, 1)
  t.is(result.allocations.length, 2)
  t.true(result.meters[0].allocationSnapshotValidated)
})

test('part extérieure conservée sans créer le point ni renormaliser', t => {
  const input = fixture()
  input.rives.Contrat.push(row(['C-B', 'CLIENT-B', 'Ferme B', 20000, 8]))
  input.rives.Lieu.push(row(['L-B', 'OU-B', 'Lieu B', 0.5, 44.7]))
  input.rives.Affectation[0].values[4] = 70
  input.rives.Affectation.push(row(['C-B', 'L-B', 'OU-B', 'SN/A', 30]))
  const result = buildManifest(input)
  t.is(result.points.length, 1)
  t.is(result.allocations.length, 1)
  t.is(result.allocations[0].percentage, '70')
  t.true(result.meters[0].allocationSnapshotValidated)
  t.false(result.meters[0].allocationSnapshot.find(a => a.lieuId === 'L-B').inScope)
})

test('coefficient négatif, total incomplet et compteur absent bloquent la publication', t => {
  for (const percentage of [-100, 70, '', null, 101]) {
    const input = fixture()
    input.rives.Affectation[0].values[4] = percentage
    t.false(buildManifest(input).meters[0].allocationSnapshotValidated)
  }

  const input = fixture()
  input.rives.Compteur = []
  t.false(buildManifest(input).meters[0].allocationSnapshotValidated)
})

test('email partagé ne fusionne pas deux préleveurs', t => {
  const input = fixture()
  const person = [...input.epidropt.Préleveurs[0].values]
  person[3] = '12345678900002'
  person[4] = 'Ferme B'
  person[9] = 'AEAG-B'
  input.epidropt.Préleveurs.push(row(person, 4))
  const result = buildManifest(input)
  t.is(result.declarants.length, 2)
  t.is(result.exploitations.length, 0)
  t.true(result.issues.some(i => i.code === 'EXPLOITATION_UNRESOLVED'))
})

test('reclassement des lignes ne change pas les identités', t => {
  const input = fixture()
  const first = buildManifest(input)
  input.epidropt['Points prélèvement'][0].row = 12
  input.rives.Affectation[0].row = 52
  const second = buildManifest(input)
  t.is(first.points[0].id, second.points[0].id)
  t.is(first.allocations[0].sourceId, second.allocations[0].sourceId)
  t.is(digest({a: 1, b: 2}), digest({b: 2, a: 1}))
})

test('coordonnées nulles/incohérentes isolées, Lambert et WGS84 acceptés', t => {
  t.is(coordinates(0, 0), null)
  t.is(coordinates(80, 30), null)
  t.deepEqual(coordinates(0.4, 44.6), [0.4, 44.6])
  t.deepEqual(coordinates(44.6, 0.4), [0.4, 44.6])
  t.truthy(coordinates(517286.43, 6395982.4))
  const input = fixture()
  input.rives.Lieu[0].values[3] = 0
  input.rives.Lieu[0].values[4] = 0
  input.epidropt['Points prélèvement'][0].values[3] = 0
  input.epidropt['Points prélèvement'][0].values[4] = 0
  t.is(buildManifest(input).points.length, 0)
})

test('contacts nettoyés sans alias de connexion ni séparateur dans un numéro compteur', t => {
  t.deepEqual(emails('a@example.test; A@example.test; b@example.test'), ['a@example.test', 'b@example.test'])
})

test('coordonnées corrigées normalisées avant stockage, jamais un Lambert stocké en WGS84', t => {
  for (const inputCoordinates of [[44.6, 0.4], [517286.43, 6395982.4]]) {
    const input = fixture()
    input.overrides = {points: {'OU-A': {coordinates: inputCoordinates}}}
    const manifest = buildManifest(input)
    t.deepEqual(manifest.points[0].coordinates, coordinates(...inputCoordinates))
  }
})

test('ressources contradictoires pour une même identité de point mises en attente', t => {
  const input = fixture()
  const duplicate = [...input.epidropt['Points prélèvement'][0].values]
  duplicate[7] = 'Eau souterraine'
  input.epidropt['Points prélèvement'].push(row(duplicate, 4))
  const manifest = buildManifest(input)
  t.is(manifest.points.length, 0)
  t.true(manifest.issues.some(issue => issue.code === 'POINT_RESOURCE_CONFLICT'))
})

test('un contrat au même point ne prouve pas l’identité du préleveur', t => {
  const input = fixture()
  input.rives.Contrat[0].values[2] = 'Ferme B'
  const manifest = buildManifest(input)
  t.is(manifest.allocations.length, 0)
  t.false(manifest.meters[0].allocationSnapshotValidated)
  t.true(manifest.issues.some(issue => issue.code === 'RIVES_CLIENT_IDENTITY_UNRESOLVED'))
  t.false(manifest.declarants[0].references.some(ref => ref.provider === 'rives-et-eaux'))
})

test('la part ambiguë ne revient pas au seul préleveur du point partagé', t => {
  const input = fixture()
  input.rives.Contrat.push(row(['C-B', 'CLIENT-B', 'Ferme B', 20000, 8]))
  input.rives.Affectation[0].values[4] = 70
  input.rives.Affectation.push(row(['C-B', 'L-A', 'OU-A', 'SN/A', 30]))
  const manifest = buildManifest(input)
  t.deepEqual(manifest.allocations.map(allocation => allocation.percentage), ['70'])
  t.is(manifest.meters[0].allocationSnapshot.length, 2)
  t.false(manifest.meters[0].allocationSnapshotValidated)
})

test('un rapprochement client explicite résout un libellé différent sans changer les comptes', t => {
  const input = fixture()
  input.rives.Contrat[0].values[2] = 'Ancien nom'
  input.overrides = {rivesClients: {'CLIENT-A': {declarantKey: 'epidropt:preleveur:aeag:AEAG-A'}}}
  const manifest = buildManifest(input)
  t.is(manifest.allocations.length, 1)
  t.true(manifest.meters[0].allocationSnapshotValidated)
  t.is(manifest.declarants[0].user.email, null)
})

test('un client absent ou un rapprochement invalide ne valide pas la répartition', t => {
  for (const missingClient of [true, false]) {
    const input = fixture()
    if (missingClient) input.rives.Contrat[0].values[1] = ''
    else input.overrides = {rivesClients: {'CLIENT-A': {declarantKey: 'inconnu'}}}
    const manifest = buildManifest(input)
    t.false(manifest.meters[0].allocationSnapshotValidated)
    t.is(manifest.allocations.length, 0)
  }
})

test('fusion explicite de préleveurs conserve toutes leurs références externes', t => {
  const input = fixture()
  const duplicate = [...input.epidropt.Préleveurs[0].values]
  duplicate[9] = 'AEAG-B'
  input.epidropt.Préleveurs.push(row(duplicate, 4))
  input.overrides = {declarants: {'AEAG-B': {key: 'epidropt:preleveur:aeag:AEAG-A'}}}
  const manifest = buildManifest(input)
  t.is(manifest.declarants.length, 1)
  t.deepEqual(manifest.declarants[0].references.filter(ref => ref.provider === 'epidropt').map(ref => ref.externalId).sort(), ['AEAG-A', 'AEAG-B'])
})

test('un identifiant lieu contradictoire est isolé, quelle que soit la dernière ligne', t => {
  for (const reverse of [false, true]) {
    const input = fixture()
    input.rives.Lieu.push(row(['L-A', 'OU-A', 'Autre lieu', 0.8, 44.9], 3))
    if (reverse) input.rives.Lieu.reverse()
    const manifest = buildManifest(input)
    t.is(manifest.points.length, 0)
    t.is(manifest.exploitations.length, 0)
    t.true(manifest.issues.some(issue => issue.code === 'RIVES_PLACE_IDENTITY_CONFLICT'))
  }
})

test('un identifiant contrat contradictoire ne change pas silencieusement de client', t => {
  for (const reverse of [false, true]) {
    const input = fixture()
    input.rives.Contrat.push(row(['C-A', 'CLIENT-B', 'Ferme B', 10000, 5], 3))
    if (reverse) input.rives.Contrat.reverse()
    const manifest = buildManifest(input)
    t.is(manifest.contracts.length, 0)
    t.is(manifest.allocations.length, 0)
    t.false(manifest.meters[0].allocationSnapshotValidated)
    t.true(manifest.issues.some(issue => issue.code === 'RIVES_CONTRACT_IDENTITY_CONFLICT'))
  }
})

test('les répétitions strictement identiques des référentiels ne bloquent pas', t => {
  const input = fixture()
  for (const sheet of ['Lieu', 'Contrat']) input.rives[sheet].push(row([...input.rives[sheet][0].values], 3))
  const manifest = buildManifest(input)
  t.is(manifest.points.length, 1)
  t.is(manifest.contracts.length, 1)
  t.true(manifest.meters[0].allocationSnapshotValidated)
  t.deepEqual(manifest.issues, [])
})

test('un compteur connu de Rives sans rattachement local reste signalé et non réaffecté', t => {
  const input = fixture()
  input.epidropt['Points prélèvement'][0].values[24] = 'SN/A'
  input.rives.Affectation[0].values[1] = 'L-EXTERIEUR'
  input.rives.Affectation[0].values[2] = 'OU-EXTERIEUR'
  const manifest = buildManifest(input)
  t.is(manifest.meters.length, 0)
  t.is(manifest.allocations.length, 0)
  t.true(manifest.issues.some(issue => issue.code === 'EPIDROPT_METER_RIVES_LINK_UNRESOLVED'))
})

test('un compteur Rives existant mais sans préleveur identifié reste signalé', t => {
  const input = fixture()
  input.epidropt['Points prélèvement'][0].values[24] = 'SN/A'
  input.rives.Contrat[0].values[2] = 'Autre préleveur'
  const manifest = buildManifest(input)
  t.is(manifest.meters.length, 1)
  t.is(manifest.allocations.length, 0)
  t.true(manifest.issues.some(issue => issue.code === 'EPIDROPT_METER_RIVES_LINK_UNRESOLVED'))
})

test('un compteur déjà affecté par Rives ne crée ni doublon ni fausse anomalie', t => {
  const input = fixture()
  input.epidropt['Points prélèvement'][0].values[24] = 'SN/A'
  const manifest = buildManifest(input)
  t.is(manifest.meters.length, 1)
  t.is(manifest.allocations.length, 1)
  t.deepEqual(manifest.issues, [])
})

test('un préleveur identifié seulement par SIRET conserve une référence stable pour le rejeu', t => {
  const input = fixture()
  input.epidropt.Préleveurs[0].values[9] = null
  input.rives.Contrat[0].values[2] = 'Autre préleveur'
  const first = buildManifest(input)
  input.epidropt.Préleveurs[0].row = 25
  const second = buildManifest(input)
  t.deepEqual(first.declarants[0].references, [{provider: 'epidropt', externalId: 'siret:12345678900001'}])
  t.deepEqual(first.declarants[0].references, second.declarants[0].references)
  t.is(first.declarants[0].id, second.declarants[0].id)
})
