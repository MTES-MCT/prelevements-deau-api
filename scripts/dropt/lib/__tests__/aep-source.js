import test from 'ava'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import ExcelJS from 'exceljs'
import {buildAepManifest, prepareAepManifest, validateAepManifest, digest} from '../aep-source.js'

const sources = [{name: 'aep-synthetic.xlsx', sha256: 'a'.repeat(64)}, {name: 'legacy-synthetic.xlsx', sha256: 'b'.repeat(64)}]

function siret(seed) {
  const prefix = String(seed).padEnd(13, '0')
  const sum = [...prefix].reduce((sum, digit, index) => {
    const value = Number(digit) * (index % 2 === 0 ? 2 : 1)
    return sum + (value > 9 ? value - 9 : value)
  }, 0)
  return `${prefix}${(10 - sum % 10) % 10}`
}

function fixture() {
  return {
    sources,
    decisions: {version: 1, coordinateSystem: 'EPSG:2154', additionalOperators: [], pointOverrides: {},
      heldExploitationPointNames: [], activePointKeys: [], retirementPointNames: ['1']},
    aepWorkbook: {
      points: [{row: 3, name: 'Source du Test', x: 490000, y: 6395000, waterBodyType: 'Eaux souterraines',
        nature: 'source', aeag: 'C99000001', siseaux: '99000001', codeBSS: 'BSSSYNTHETIQUE1'}],
      declarants: [{row: 3, type: 'Syndicat AEP', email: 'Contact@syndicat.example.test\u00A0',
        siret: siret(12345), socialReason: 'Syndicat fictif', addressLine1: '1 rue fictive', postalCode: '99000', city: 'Ville fictive'}],
      exploitations: [{row: 3, pointName: 'Source du Test', email: 'contact@syndicat.example.test', usage: 'Alimentation en eau potable (AEP)'}]
    },
    legacyWorkbook: {points: [{row: 30, name: '1', codeBSS: 'BSSSYNTHETIQUE1'}, {row: 31, name: '7', codeBSS: 'BSSAUTRE'}],
      exploitations: [{row: 35, pointName: '1', usage: 'Alimentation en eau potable (AEP)'}, {row: 36, pointName: '7', usage: 'Irrigation'}]}
  }
}

function addPoint(input, {key = 'C99000002', name = 'Forage du Test', ...properties} = {}) {
  const row = input.aepWorkbook.points.length + 3
  input.aepWorkbook.points.push({...input.aepWorkbook.points[0], row, name, aeag: key, siseaux: null, codeBSS: null, ...properties})
  input.aepWorkbook.exploitations.push({...input.aepWorkbook.exploitations[0], row, pointName: name})
}

test('manifeste AEP minimal : personne morale, saisie rapide, projection et retrait strict', t => {
  const manifest = buildAepManifest(fixture())
  t.is(validateAepManifest(manifest), manifest)
  t.is(manifest.kind, 'dropt-aep')
  t.is(manifest.declarants[0].email, 'contact@syndicat.example.test')
  t.like(manifest.declarants[0].data, {declarantRole: 'PRELEVEUR', declarantType: 'LEGAL_PERSON', preleveurType: 'GESTIONNAIRE_AEP', quickDeclarationEnabled: true})
  t.like(manifest.points[0].data, {waterBodyType: 'SOUTERRAIN', flowType: 'PRELEVEMENT', pointKind: 'PHYSIQUE', collectionMode: 'MANUAL'})
  t.true(manifest.points[0].coordinates[0] > 0.3 && manifest.points[0].coordinates[0] < 0.4)
  t.true(manifest.points[0].coordinates[1] > 44.6 && manifest.points[0].coordinates[1] < 44.7)
  t.deepEqual(manifest.exploitations[0].data, {status: 'EN_ACTIVITE', excludeFromQuickDeclaration: false, startDate: null, endDate: null})
  t.is(manifest.retirements.length, 1)
  t.like(manifest.retirements[0], {name: '1', codeBSS: 'BSSSYNTHETIQUE1', sourcePrefix: 'dropt-epidropt:point:', replacementKey: 'aeag:C99000001'})
  t.deepEqual(manifest.issues, [])
})

test('identifiants indépendants des numéros/ordre des lignes et propriétés JSON', t => {
  const input = fixture()
  addPoint(input)
  const before = buildAepManifest(input)
  for (const records of Object.values(input.aepWorkbook)) {
    records.reverse()
    records.forEach((row, index) => { row.row = index + 20 })
  }
  const after = buildAepManifest(input)
  for (const field of ['declarants', 'points', 'exploitations']) {
    t.deepEqual(after[field].map(({id, sourceId, key}) => ({id, sourceId, key})), before[field].map(({id, sourceId, key}) => ({id, sourceId, key})))
  }
  t.not(after.manifestHash, before.manifestHash)
  t.is(digest({z: 1, a: {d: 2, c: 3}}), digest({a: {c: 3, d: 2}, z: 1}))
})

test('deux PP au même endroit et au même OPR restent distincts ; code SISEAUX remplace AEAG absent', t => {
  const input = fixture()
  input.aepWorkbook.points[0].codeOPR = 'OPR-SYNTHETIQUE'
  addPoint(input, {key: '', siseaux: '99000002'})
  const manifest = buildAepManifest(input)
  t.is(manifest.points.length, 2)
  t.is(manifest.points[1].key, 'siseaux:99000002')
  t.not(manifest.points[0].id, manifest.points[1].id)
  t.true(manifest.issues.some(issue => issue.code === 'AEP_SHARED_COORDINATES'))
  t.true(manifest.issues.some(issue => issue.code === 'AEP_SHARED_OPR'))
})

test('SISEAUX composite : seul code numérique extrait, valeur brute conservée', t => {
  const input = fixture()
  input.aepWorkbook.points[0].siseaux = '09999X0001, 99000001'
  const manifest = buildAepManifest(input)
  t.is(manifest.points[0].data.codeSISEAUX, '99000001')
  t.is(manifest.points[0].source.rawIdentifiers.siseaux, '09999X0001, 99000001')
  t.true(manifest.issues.some(issue => issue.code === 'AEP_SISEAUX_MIXED_VALUE'))
})

test('BSS contradictoire exige une décision explicite ; deux opérateurs par PP conservés', t => {
  const input = fixture()
  addPoint(input, {codeBSS: 'BSSSYNTHETIQUE1'})
  t.throws(() => buildAepManifest(input), {code: 'AEP_BSS_CONFLICT'})
  input.decisions.pointOverrides['aeag:C99000002'] = {codeBSS: null, reason: 'Contradiction vérifiée dans la source synthétique'}
  input.aepWorkbook.declarants.push({...input.aepWorkbook.declarants[0], row: 4, siret: siret(22345), email: 'second@example.test', socialReason: 'Second syndicat fictif'})
  input.decisions.additionalOperators = input.aepWorkbook.points.map(point => ({pointKey: `aeag:${point.aeag}`, declarantSiret: siret(22345), reason: 'Double exploitation validée'}))
  const manifest = buildAepManifest(input)
  t.is(manifest.points.length, 2)
  t.is(manifest.exploitations.length, 4)
  t.is(manifest.points[1].data.codeBSS, null)
  t.true(manifest.issues.some(issue => issue.code === 'AEP_BSS_CLEARED_BY_DECISION'))
  t.is(manifest.exploitations.filter(record => record.declarantId === manifest.declarants[1].id).length, 2)
})

test('point commenté abandonné reste bloqué jusqu’à confirmation explicite d’activité', t => {
  const input = fixture()
  input.aepWorkbook.points[0].comment = 'Abandonné ?'
  t.throws(() => buildAepManifest(input), {code: 'AEP_POINT_ACTIVITY_DECISION_REQUIRED'})
  input.decisions.activePointKeys = ['aeag:C99000001']
  const manifest = buildAepManifest(input)
  t.is(manifest.exploitations[0].data.status, 'EN_ACTIVITE')
  t.true(manifest.issues.some(issue => issue.code === 'AEP_ACTIVE_POINT_CONFIRMED'))
})

test('exploitation sans PP en attente explicite, sans point ni rattachement inventé', t => {
  const input = fixture()
  input.aepWorkbook.exploitations.push({...input.aepWorkbook.exploitations[0], row: 4, pointName: 'Forage non localisé'})
  t.throws(() => buildAepManifest(input), {code: 'AEP_EXPLOITATION_POINT_NOT_FOUND'})
  input.decisions.heldExploitationPointNames = ['Forage non localisé']
  const manifest = buildAepManifest(input)
  t.is(manifest.points.length, 1)
  t.is(manifest.exploitations.length, 1)
  t.true(manifest.issues.some(issue => issue.code === 'AEP_EXPLOITATION_HELD' && issue.row === 4))
})

test('ne retire jamais un PP numérique d’irrigation, mixte ou un BSS différent', t => {
  for (const update of [
    input => { input.decisions.retirementPointNames.push('7') },
    input => { input.legacyWorkbook.exploitations.push({row: 37, pointName: '1', usage: 'Irrigation'}) }
  ]) {
    const input = fixture()
    update(input)
    t.throws(() => buildAepManifest(input), {code: 'AEP_RETIREMENT_NOT_EXCLUSIVELY_AEP'})
  }
  const input = fixture()
  input.legacyWorkbook.points[0].codeBSS = 'BSSDIFFERENT'
  t.throws(() => buildAepManifest(input), {code: 'AEP_RETIREMENT_REPLACEMENT_AMBIGUOUS'})
})

test('ancien classeur : noms numériques natifs et libellé abrégé AEP sont reconnus exactement', t => {
  const input = fixture()
  input.legacyWorkbook.points[0].name = 1
  input.legacyWorkbook.exploitations[0].pointName = 1
  input.legacyWorkbook.exploitations[0].usage = 'AEP'
  t.is(buildAepManifest(input).retirements[0].name, '1')
})

test('coordonnées Lambert93 groupées valides, format ambigu et WGS84 rejetés', t => {
  for (const space of [' ', '\u00A0', '\u202F']) {
    const input = fixture()
    input.aepWorkbook.points[0].x = `490${space}000,0`
    input.aepWorkbook.points[0].y = `6${space}395${space}000`
    t.deepEqual(buildAepManifest(input).points[0].coordinates, buildAepManifest(fixture()).points[0].coordinates)
  }
  for (const [x, y] of [[0.3, 44.6], ['49 00 00', 6395000], ['490\t000', 6395000], [null, 6395000], [490000, Number.NaN]]) {
    const input = fixture()
    Object.assign(input.aepWorkbook.points[0], {x, y})
    t.throws(() => buildAepManifest(input), {code: 'AEP_COORDINATES_INVALID'})
  }
  const input = fixture()
  input.aepWorkbook.points[0].x = 700000
  t.throws(() => buildAepManifest(input), {code: 'AEP_COORDINATES_OUTSIDE_DROPT'})
})

test('identités et relations ambiguës bloquent sans choisir arbitrairement', t => {
  const cases = [
    ['AEP_DECLARANT_DUPLICATE', input => input.aepWorkbook.declarants.push({...input.aepWorkbook.declarants[0], row: 4})],
    ['AEP_POINT_DUPLICATE', input => addPoint(input, {key: 'C99000001'})],
    ['AEP_POINT_DUPLICATE', input => addPoint(input, {name: 'Source du Test'})],
    ['AEP_POINT_IDENTITY_MISSING', input => Object.assign(input.aepWorkbook.points[0], {aeag: null, siseaux: null})],
    ['AEP_SISEAUX_INVALID', input => { input.aepWorkbook.points[0].siseaux = '99000001,99000002' }],
    ['AEP_EMAIL_INVALID', input => { input.aepWorkbook.declarants[0].email = 'a@example.test;b@example.test' }],
    ['AEP_DECLARANT_IDENTITY_INVALID', input => { input.aepWorkbook.declarants[0].siret = '12345678901234' }],
    ['AEP_EXPLOITATION_DUPLICATE', input => input.aepWorkbook.exploitations.push({...input.aepWorkbook.exploitations[0], row: 4})],
    ['AEP_EXPLOITATION_DECLARANT_NOT_FOUND', input => { input.aepWorkbook.exploitations[0].email = 'unknown@example.test' }],
    ['AEP_POINT_WITHOUT_EXPLOITATION', input => { addPoint(input); input.aepWorkbook.exploitations.pop() }]
  ]
  for (const [code, update] of cases) {
    const input = fixture()
    update(input)
    t.throws(() => buildAepManifest(input), {code})
  }
})

test('décisions inconnues, absentes, non consommées et comptes inattendus bloquent', t => {
  const cases = [
    ['AEP_DECISIONS_INVALID', input => { input.decisions.coordinateSystem = 'EPSG:4326' }],
    ['AEP_DECISION_UNKNOWN', input => { input.decisions.activePoints = [] }],
    ['AEP_POINT_OVERRIDE_INVALID', input => { input.decisions.pointOverrides['aeag:C99000001'] = {codeBSS: 'BSSAUTRE', reason: 'Test'} }],
    ['AEP_POINT_DECISION_NOT_FOUND', input => { input.decisions.activePointKeys = ['aeag:CINCONNU'] }],
    ['AEP_HOLD_NOT_FOUND', input => { input.decisions.heldExploitationPointNames = ['Inconnu'] }],
    ['AEP_HOLD_HAS_POINT', input => { input.decisions.heldExploitationPointNames = ['Source du Test'] }],
    ['AEP_OPERATOR_DECISION_NOT_FOUND', input => { input.decisions.additionalOperators = [{pointKey: 'aeag:CINCONNU', declarantSiret: siret(12345), reason: 'Test'}] }],
    ['AEP_EXPECTED_COUNTS_MISMATCH', input => { input.decisions.expectedCounts = {points: 2, declarants: 1, exploitations: 1, retirements: 1} }]
  ]
  for (const [code, update] of cases) {
    const input = fixture()
    update(input)
    t.throws(() => buildAepManifest(input), {code})
  }
})

test('dates, usages secondaires ou milieu inattendus ne sont pas ignorés', t => {
  for (const field of ['startDate', 'endDate', 'secondaryUsage1', 'secondaryUsage2', 'usage']) {
    const input = fixture()
    input.aepWorkbook.exploitations[0][field] = 'Valeur inattendue'
    t.throws(() => buildAepManifest(input), {code: 'AEP_EXPLOITATION_DATA_INVALID'})
  }
  const input = fixture()
  input.aepWorkbook.points[0].waterBodyType = 'Eaux de surface'
  t.throws(() => buildAepManifest(input), {code: 'AEP_WATER_BODY_TYPE_INVALID'})
})

test('empreinte du manifeste couvre décisions, sources, relations et retraits', t => {
  const original = buildAepManifest(fixture())
  for (const change of [
    manifest => { manifest.points[0].data.name = 'Modifié' },
    manifest => { manifest.sources[0].sha256 = 'c'.repeat(64) },
    manifest => { manifest.decisions.retirementPointNames = [] },
    manifest => { manifest.retirements[0].codeBSS = 'AUTRE' }
  ]) {
    const modified = structuredClone(original)
    change(modified)
    t.throws(() => validateAepManifest(modified), {code: 'AEP_MANIFEST_HASH_MISMATCH'})
  }
  const modified = structuredClone(original)
  modified.exploitations[0].declarantId = 'missing'
  delete modified.manifestHash
  modified.manifestHash = digest(modified)
  t.throws(() => validateAepManifest(modified), {code: 'AEP_MANIFEST_EXPLOITATION_INVALID'})
})

// Full public template headers, no private rows. Reordered columns exercise the
// workbook adapter independently from the semantic fixture used above.
const pointHeaders = ['Nom du point *', 'Coordonnée X - longitude (WGS84) *', 'Coordonnée Y - latitude (WGS84) *', 'Type de milieu *',
  'nature_prelevement_ou_rejet', 'Code SISEAUX', 'Identifiant interne AEAG', 'identifiant interne DDT', 'Profondeur (m)',
  'Zone de répartition des eaux', 'Réservoir biologique', "Nom de l'unité de gestion", 'Code entité de gestion', 'Nom de la sous unité gestion',
  "Nom de la masse d'eau", 'Description du lieu', 'Code BSS AEAG', 'Code BSS SAGE', 'Code BNPE', 'Code AIOT', "Code EU Masse d'Eau", 'Code PTP',
  'Code OPR', 'Code BDLISA', 'libelle entité hydrogeol', 'Code BDCarthage', 'Code BDTopage', 'Commentaire']
const ownerHeaders = ['Type de préleveur *', 'Email *', 'Syndicat des eaux', 'Délégataire', 'Code SYSPEA', 'Raison sociale', 'SIRET', 'Téléphone',
  'Adresse', "Complément d'adresse", 'Boîte postale', 'Code postal', 'Ville']
const exploitationHeaders = ['Point de prélèvement *', 'Préleveur *', 'Usage principal *', 'Date de début', 'Date de fin', 'Usage complémentaire 1', 'Usage complémentaire 2', 'Commentaire']

function xlsxFixture() {
  const aepWorkbook = new ExcelJS.Workbook()
  const legacyWorkbook = new ExcelJS.Workbook()
  function sheet(book, name, headers, values) {
    const result = book.addWorksheet(name)
    result.addRow(['#', ...headers.toReversed()])
    result.addRow([null, 'EXEMPLE NON IMPORTÉ'])
    result.addRow([{formula: 'ROW()-2', result: 1}, ...headers.toReversed().map(header => values[header] ?? null)])
    result.getCell(30, 1).value = {formula: 'ROW()-2', result: 28}
    return result
  }
  sheet(aepWorkbook, 'Points prélèvement', pointHeaders, {'Nom du point *': 'Source du Test', 'Coordonnée X - longitude (WGS84) *': 490000,
    'Coordonnée Y - latitude (WGS84) *': 6395000, 'Type de milieu *': 'Eaux souterraines', nature_prelevement_ou_rejet: 'source',
    'Identifiant interne AEAG': 'C99000001', 'Code BSS AEAG': 'BSSSYNTHETIQUE1'})
  sheet(aepWorkbook, 'Préleveurs', ownerHeaders, {'Type de préleveur *': 'Syndicat AEP', 'Email *': {text: 'contact@syndicat.example.test', hyperlink: 'mailto:contact@syndicat.example.test'},
    'Raison sociale': {richText: [{text: 'Syndicat '}, {text: 'fictif'}]}, SIRET: siret(12345)})
  const exploitation = {'Point de prélèvement *': 'Source du Test', 'Préleveur *': 'contact@syndicat.example.test', 'Usage principal *': 'Alimentation en eau potable (AEP)'}
  sheet(aepWorkbook, 'Exploitations', exploitationHeaders, exploitation)
  sheet(legacyWorkbook, 'Points prélèvement', ['Nom du point *', 'Code BSS'], {'Nom du point *': '1', 'Code BSS': 'BSSSYNTHETIQUE1'})
  sheet(legacyWorkbook, 'Exploitations', exploitationHeaders, {...exploitation, 'Point de prélèvement *': '1'})
  return {aepWorkbook, legacyWorkbook, sources, decisions: fixture().decisions}
}

test('ExcelJS : en-têtes réordonnés, cellules riches, exemple et numérotation ignorés', t => {
  const manifest = buildAepManifest(xlsxFixture())
  t.is(manifest.points.length, 1)
  t.is(manifest.declarants.length, 1)
  t.is(manifest.exploitations.length, 1)
  t.is(manifest.declarants[0].data.socialReason, 'Syndicat fictif')
  t.is(manifest.declarants[0].email, 'contact@syndicat.example.test')
  t.is(manifest.points[0].source.row, 3)
})

test('ExcelJS : changement de schéma et formule métier ne sont pas acceptés silencieusement', t => {
  const input = xlsxFixture()
  const sheet = input.aepWorkbook.getWorksheet('Points prélèvement')
  sheet.getCell(1, 2).value = 'En-tête inconnu'
  t.throws(() => buildAepManifest(input), {code: 'AEP_REQUIRED_HEADER_MISSING'})
  const formulaInput = xlsxFixture()
  const pointSheet = formulaInput.aepWorkbook.getWorksheet('Points prélèvement')
  pointSheet.getCell(3, pointSheet.columnCount).value = {formula: '"Source du Test"', result: 'Source du Test'}
  t.throws(() => buildAepManifest(formulaInput), {code: 'AEP_UNSUPPORTED_CELL'})
  const incompleteInput = xlsxFixture()
  const incompleteSheet = incompleteInput.aepWorkbook.getWorksheet('Points prélèvement')
  incompleteSheet.getCell(3, incompleteSheet.columnCount).value = null
  t.throws(() => buildAepManifest(incompleteInput), {code: 'AEP_REQUIRED_CELL_MISSING'})
})

test('préparation lit deux XLSX et lie leurs octets exacts sans modifier les originaux', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dropt-aep-source-test-'))
  t.teardown(() => rm(directory, {recursive: true, force: true}))
  const input = xlsxFixture()
  const aepBuffer = await input.aepWorkbook.xlsx.writeBuffer()
  const legacyBuffer = await input.legacyWorkbook.xlsx.writeBuffer()
  const aepFile = join(directory, 'aep.xlsx')
  const legacyFile = join(directory, 'legacy.xlsx')
  await Promise.all([writeFile(aepFile, aepBuffer, {mode: 0o600}), writeFile(legacyFile, legacyBuffer, {mode: 0o600})])
  const manifest = await prepareAepManifest({aepFile, legacyFile, decisions: input.decisions})
  t.deepEqual(manifest.sources, [{name: 'aep.xlsx', sha256: createHash('sha256').update(aepBuffer).digest('hex')},
    {name: 'legacy.xlsx', sha256: createHash('sha256').update(legacyBuffer).digest('hex')}])
  t.is(manifest.points.length, 1)
  const replay = await prepareAepManifest({aepFile, legacyFile, decisions: input.decisions})
  t.is(replay.manifestHash, manifest.manifestHash)
})
