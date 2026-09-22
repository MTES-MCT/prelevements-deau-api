import test from 'ava'
import {buildManifest, coordinates, digest, emails, stableId, normalizePointWorkbookRow} from '../epidropt.js'

function row(values, number = 3) {
  return {row: number, values}
}

function legacyPointHeaders() {
  return ['#', 'Nom du point *', 'Type point *', 'Coordonnée X - longitude (lambert93) *',
    'Coordonnée Y - latitude (lambert93) *', 'Date de mise en service du point *', 'nature du point',
    'type de milieu', 'origine du prélèvement ou du rejet', 'type prélèvement / rejet',
    'Zone de répartition des eaux (ZRE)', "Identifiant interne Agence de l'eau *", 'Autres identifiants internes',
    "Point référent de l'ouvrage", 'Autres noms (séparés par |)', 'Profondeur (m)', 'Réservoir biologique',
    "Nom de l'unité de gestion des volumes prélevables", 'Nom de la sous unité de gestion des volumes prélevables',
    'Code BSS', 'Code BNPE', 'Code AIOT', "Code EU Masse d'Eau", 'Code PTP', 'Numéro de série du compteur',
    'Code OPR', 'Code BDLISA', 'Code BDCarthage', 'Code BDTopage', 'plan_eau_connecté_cours_eau',
    'plan_eau_connecté_nappe', 'Code SISEAUX', 'Commentaire', null, null, null, null, null]
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

test('nouveaux en-têtes distinguent code comptage, numéro de série et retenue sans décaler les codes', t => {
  const headers = legacyPointHeaders()
  headers.splice(24, 0, "Code comptage (code Agence de l'eau)")
  headers.splice(32, 0, 'Volume nominal de la retenue', 'Identifiant plan eau')
  const values = Array(headers.length).fill(null)
  Object.assign(values, {24: '0012', 25: 'SN-001', 26: 'OPR', 32: 2500, 33: 'PE-01', 34: 'SISEAUX'})
  const parsed = normalizePointWorkbookRow(values, headers)
  t.is(parsed.countingCode, '0012')
  t.is(parsed.values[24], 'SN-001')
  t.is(parsed.values[25], 'OPR')
  t.is(parsed.values[31], 'SISEAUX')
  t.is(parsed.values.length, 38)
  t.is(parsed.reservoirNominalVolume, 2500)
  t.is(parsed.waterBodyIdentifier, 'PE-01')
})

test('chaque colonne des modèles ancien et nouveau garde son sens, y compris les booléens', t => {
  const oldHeaders = legacyPointHeaders()
  const expected = oldHeaders.map((header, column) => header ? `sentinel-${column}` : null)
  t.deepEqual(normalizePointWorkbookRow(expected, oldHeaders).values, expected)
  const headers = oldHeaders.map(header => header && `${header} *`)
  const values = [...expected]
  headers.splice(24, 0, "Code comptage (code Agence de l'eau)")
  values.splice(24, 0, '00123')
  headers.splice(32, 0, 'Volume nominal de la retenue', 'Identifiant plan eau')
  values.splice(32, 0, 2500, '00045')
  const parsed = normalizePointWorkbookRow(values, headers)
  t.deepEqual(parsed.values, expected)
  t.is(parsed.countingCode, '00123')
  t.is(parsed.waterBodyIdentifier, '00045')
  // Even if a source column is moved, its label owns the mapping.
  t.deepEqual(normalizePointWorkbookRow([...values].reverse(), [...headers].reverse()), parsed)
})

test('une colonne absente ou un en-tête dupliqué bloque au lieu de lire une autre colonne', t => {
  for (const label of ['Code BDTopage', 'Zone de répartition des eaux (ZRE)', 'Numéro de série du compteur']) {
    const headers = legacyPointHeaders()
    const values = headers.map((_, i) => `value-${i}`)
    t.throws(() => normalizePointWorkbookRow(values, headers.map(header => header === label ? null : header)), {message: /Colonne absente ou ambiguë/})
    t.throws(() => normalizePointWorkbookRow([...values, 'extra'], [...headers, label]), {message: /Colonne absente ou ambiguë/})
  }
})

test('un booléen sous Code BDTopage est signalé sans inventer un identifiant ni une connexion', t => {
  const input = fixture()
  const point = input.epidropt['Points prélèvement'][0].values
  point[28] = 'Non'
  const manifest = buildManifest(input)
  t.false(Object.hasOwn(manifest.points[0].data, 'codeBDTopage'))
  t.false(Object.hasOwn(manifest.points[0].data, 'isWaterBodyConnectedToStream'))
  t.true(manifest.issues.some(issue => issue.code === 'POINT_FIELD_INVALID' && issue.field === 'codeBDTopage'))
})

test('Oui/Non et valeurs manquantes restent distincts sur les indicateurs du point', t => {
  const input = fixture()
  const point = input.epidropt['Points prélèvement'][0].values
  Object.assign(point, {10: 'Oui', 13: 'Non renseigné', 16: 'Non', 28: 'T123', 29: 'Non', 30: 'Oui'})
  const {data} = buildManifest(input).points[0]
  t.true(data.isZre)
  t.false(data.isBiologicalReservoir)
  t.false(data.isWaterBodyConnectedToStream)
  t.true(data.isWaterBodyConnectedToGroundwater)
  t.false(Object.hasOwn(data, 'isReferencePoint'))
  t.is(data.codeBDTopage, 'T123')
})

test('les placeholders ne deviennent ni codes hydrologiques ni identifiants de plan eau', t => {
  for (const placeholder of ['Non concerné', 'Non renseigné', 'Sans objet', '#N/A', '?']) {
    const input = fixture()
    const point = input.epidropt['Points prélèvement'][0]
    point.values[28] = placeholder
    point.waterBodyIdentifier = placeholder
    point.reservoirNominalVolume = placeholder
    const manifest = buildManifest(input)
    for (const field of ['codeBDTopage', 'waterBodyIdentifier', 'reservoirNominalVolume']) t.false(Object.hasOwn(manifest.points[0].data, field))
    t.deepEqual(manifest.issues, [])
  }
})

test('une nature ou un indicateur contradictoire est omis sans effacer la valeur existante', t => {
  for (const reverse of [false, true]) {
    const input = fixture()
    const point = input.epidropt['Points prélèvement'][0]
    point.values[10] = 'Oui'
    const duplicate = structuredClone(point)
    duplicate.row = 4
    duplicate.values[8] = "plan d'eau"
    duplicate.values[10] = 'Non'
    input.epidropt['Points prélèvement'].push(duplicate)
    if (reverse) input.epidropt['Points prélèvement'].reverse()
    const manifest = buildManifest(input)
    t.false(Object.hasOwn(manifest.points[0].data, 'nature'))
    t.false(Object.hasOwn(manifest.points[0].data, 'isZre'))
    t.deepEqual(manifest.issues.filter(issue => issue.code === 'POINT_FIELD_CONFLICT').map(issue => issue.column).sort(), [9, 11].sort())
  }
})

test('doublons complémentaires et exemple du modèle ne dépendent pas de l’ordre des lignes', t => {
  const input = fixture()
  input.rives = {Contrat: [], Compteur: [], Lieu: [], Affectation: []}
  const duplicate = structuredClone(input.epidropt['Points prélèvement'][0])
  duplicate.row = 4
  duplicate.values[7] = null
  input.epidropt['Points prélèvement'].push(duplicate, row([1, 'Forage 1'], 5))
  const first = buildManifest(input)
  input.epidropt['Points prélèvement'].reverse()
  const second = buildManifest(input)
  t.is(first.points.length, 1)
  t.deepEqual(first.points[0].data, second.points[0].data)
  t.is(first.points[0].id, second.points[0].id)
})

test('un seul code et un seul propriétaire source permettent une attribution sans produit cartésien', t => {
  const input = fixture()
  input.epidropt['Points prélèvement'][0].countingCode = '001'
  const first = buildManifest(input)
  t.is(first.exploitations[0].countingCode, '001')
  input.epidropt['Points prélèvement'].push({...structuredClone(input.epidropt['Points prélèvement'][0]), row: 4, countingCode: '002'})
  const ambiguous = buildManifest(input)
  t.is(ambiguous.exploitations.length, 1)
  t.is(ambiguous.exploitations[0].countingCode, null)
  t.true(ambiguous.reconciliation.some(row => row.reason === 'MULTIPLE_CODES'))
})

test('un propriétaire source non résolu empêche l’inférence même si une seule exploitation est importée', t => {
  const input = fixture()
  input.epidropt['Points prélèvement'][0].countingCode = '001'
  input.epidropt.Exploitations.push(row([null, 'OU-A', 'unknown@example.test', 'Irrigation'], 4))
  const result = buildManifest(input)
  t.is(result.exploitations.length, 1)
  t.is(result.exploitations[0].countingCode, null)
})

test('un code explicite par ligne exploitation distingue deux comptages du même couple', t => {
  const input = fixture()
  input.epidropt.Exploitations[0].countingCode = '001'
  input.epidropt.Exploitations.push({...structuredClone(input.epidropt.Exploitations[0]), row: 4, countingCode: '002'})
  const result = buildManifest(input)
  t.deepEqual(result.exploitations.map(e => e.countingCode).sort(), ['001', '002'])
  t.is(new Set(result.exploitations.map(e => e.id)).size, 2)
  t.false(result.meters[0].allocationSnapshotValidated)
})

test('email partagé est résolu par nom exact Rives seulement avec une identité existante sans conflit', t => {
  const input = fixture()
  const second = [...input.epidropt.Préleveurs[0].values]
  second[3] = '12345678900002'
  second[4] = 'Ferme B'
  second[9] = 'AEAG-B'
  input.epidropt.Préleveurs.push(row(second, 4))
  input.snapshot = {tables: {declarants: [{userId: stableId('epidropt:preleveur:aeag:AEAG-A'), siret: '12345678900001'}]}}
  const strong = buildManifest(input)
  t.is(strong.exploitations.length, 1)
  t.true(strong.reconciliation.some(row => row.kind === 'DECLARANT' && row.status === 'ACCEPTED'))
  input.snapshot.tables.declarants[0].userId = 'another-identity'
  const conflict = buildManifest(input)
  t.is(conflict.exploitations.length, 0)
  t.true(conflict.reconciliation.some(row => row.reason === 'SIRET_IDENTITY_CONFLICT'))
})

test('un SIRET réel dans la colonne préleveur est accepté sans exiger un email', t => {
  const input = fixture()
  input.epidropt.Exploitations[0].values[2] = '12345678900001'
  t.is(buildManifest(input).exploitations.length, 1)
})

test('ajouter une référence Rives conserve UUID et sourceId du point et de l’exploitation', t => {
  const input = fixture()
  const initial = buildManifest({...input, rives: {Contrat: [], Compteur: [], Lieu: [], Affectation: []}})
  input.previousManifest = initial
  input.epidropt['Points prélèvement'][0].countingCode = '001'
  const enriched = buildManifest(input)
  t.is(enriched.points[0].id, initial.points[0].id)
  t.is(enriched.points[0].sourceId, initial.points[0].sourceId)
  t.is(enriched.exploitations[0].id, initial.exploitations[0].id)
  t.is(enriched.exploitations[0].sourceId, initial.exploitations[0].sourceId)
  t.is(enriched.allocations[0].exploitationId, initial.exploitations[0].id)
  t.is(enriched.exploitations[0].countingCode, '001')
  t.true(enriched.points[0].references.some(ref => ref.provider === 'rives-et-eaux'))
})

test('scinder une ancienne exploitation non codée exige une correspondance explicite', t => {
  const input = fixture()
  input.previousManifest = buildManifest(input)
  input.epidropt.Exploitations[0].countingCode = '001'
  input.epidropt.Exploitations.push({...structuredClone(input.epidropt.Exploitations[0]), row: 4, countingCode: '002'})
  const result = buildManifest(input)
  t.is(result.exploitations.length, 0)
  t.true(result.issues.some(issue => issue.code === 'EXPLOITATION_LEGACY_CODE_AMBIGUOUS'))
})
