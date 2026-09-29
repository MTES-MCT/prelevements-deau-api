import test from 'ava'
import {buildManifest, digest, stableId, normalizeExploitationWorkbookRow} from '../epidropt.js'

function fixture() {
  const point = Array(33).fill(null)
  Object.assign(point, {1: 'POINT-SYNTHETIQUE', 3: 0.4, 4: 44.6, 7: 'Eau de surface'})
  return {
    epidropt: {
      'Points prélèvement': [{row: 3, values: point}],
      Préleveurs: [{row: 3, values: [null, 'Irrigant', 'ferme@example.test', '12345678900001', 'Ferme des Prés', null, null, null, null, 'AEAG-A']}],
      Exploitations: [{row: 3, values: [null, 'POINT-SYNTHETIQUE', null, 'Irrigation'], declarantName: 'Ferme des Prés'}]
    },
    rives: {Contrat: [], Compteur: [], Lieu: [], Affectation: []}
  }
}

function nameDecision(manifest) {
  return manifest.reconciliation.find(item => item.method === 'EXACT_SOURCE_NAME_WITHOUT_EMAIL')
}

function addDeclarant(input, {name = 'Ferme des Prés', agencyId = 'AEAG-B', siret = '12345678900002', email = 'autre@example.test'} = {}) {
  input.epidropt.Préleveurs.push({row: 4, values: [null, 'Irrigant', email, siret, name, null, null, null, null, agencyId]})
}

test('le commentaire et le code comptage sont lus par leurs entêtes sans déplacer les données', t => {
  const values = [null, 'POINT-SYNTHETIQUE', null, 'Irrigation', 'Ferme des Prés', '001']
  const headers = ['#', 'Point de prélèvement *', 'Préleveur *', 'Usage principal *', 'Commentaire', 'Code comptage (code Agence de l’eau)']
  t.deepEqual(normalizeExploitationWorkbookRow(values, headers), {values, declarantName: 'Ferme des Prés', countingCode: '001'})
  t.deepEqual(normalizeExploitationWorkbookRow(values, headers.slice(0, 4)), {values})
  t.throws(() => normalizeExploitationWorkbookRow(values, [...headers, 'Commentaire']), {message: 'Colonne ambiguë : Commentaire'})
})

test('sans email, le nom complet source unique relie une exploitation au préleveur existant', t => {
  const input = fixture()
  input.epidropt.Exploitations[0].declarantName = '  FERME  des\u00a0PRES '
  const result = buildManifest(input)
  t.is(result.exploitations.length, 1)
  t.is(result.exploitations[0].declarantId, result.declarants[0].id)
  t.is(result.declarants[0].id, stableId('epidropt:preleveur:aeag:AEAG-A'))
  t.is(result.declarants[0].user.email, null)
  t.deepEqual(result.declarants[0].emails, ['ferme@example.test'])
  t.deepEqual(result.exploitations[0].source, [{sheet: 'Exploitations', row: 3}])
  const decision = nameDecision(result)
  t.is(decision.status, 'ACCEPTED')
  t.is(decision.candidateKey, result.declarants[0].key)
  t.deepEqual(decision.sources, [{sheet: 'Préleveurs', row: 3}])
  t.deepEqual(result.issues, [])
})

test('le fallback conserve un préleveur sans aucune adresse email, sans en inventer', t => {
  const input = fixture()
  input.epidropt.Préleveurs[0].values[2] = null
  input.epidropt.Exploitations[0].values[2] = 'Non renseigné'
  const result = buildManifest(input)
  t.is(result.exploitations.length, 1)
  t.deepEqual(result.declarants[0].emails, [])
  t.is(result.declarants[0].user.email, null)
})

test('la mention exacte pas de mail permet le rapprochement par nom sans inventer d’adresse', t => {
  for (const identifier of ['pas de mail', ' PAS  DE\u00a0MAIL ']) {
    const input = fixture()
    input.epidropt.Préleveurs[0].values[2] = null
    input.epidropt.Exploitations[0].values[2] = identifier
    const before = structuredClone(input)
    const result = buildManifest(input)
    t.is(result.exploitations.length, 1)
    t.is(result.exploitations[0].declarantId, result.declarants[0].id)
    t.deepEqual(result.declarants[0].emails, [])
    t.is(result.declarants[0].user.email, null)
    t.deepEqual(result.exploitations[0].source, [{sheet: 'Exploitations', row: 3}])
    t.deepEqual(nameDecision(result).sources, [{sheet: 'Préleveurs', row: 3}])
    t.is(nameDecision(result).status, 'ACCEPTED')
    t.deepEqual(input, before)
  }
})

test('pas de mail ne contourne ni les homonymes ni un nom inconnu', t => {
  const ambiguous = fixture()
  ambiguous.epidropt.Exploitations[0].values[2] = 'pas de mail'
  addDeclarant(ambiguous)
  const result = buildManifest(ambiguous)
  t.is(result.exploitations.length, 0)
  t.is(nameDecision(result).reason, 'NAME_AMBIGUOUS')

  const unknown = fixture()
  unknown.epidropt.Exploitations[0].values[2] = 'pas de mail'
  unknown.epidropt.Exploitations[0].declarantName = 'Ferme introuvable'
  const unresolved = buildManifest(unknown)
  t.is(unresolved.exploitations.length, 0)
  t.is(nameDecision(unresolved).reason, 'NAME_NOT_FOUND')
})

test('un email connu reste prioritaire même accompagné de la mention pas de mail', t => {
  const input = fixture()
  addDeclarant(input, {name: 'Autre ferme'})
  input.epidropt.Exploitations[0].values[2] = 'pas de mail ferme@example.test'
  input.epidropt.Exploitations[0].declarantName = 'Autre ferme'
  const result = buildManifest(input)
  t.is(result.exploitations.length, 1)
  t.is(result.exploitations[0].declarantId, stableId('epidropt:preleveur:aeag:AEAG-A'))
  t.is(nameDecision(result), undefined)
})

test('une mention complétée ou un email invalide ne devient pas une absence d’email', t => {
  for (const identifier of ['pas de mail absent@example.test', 'pas de mail broken@', 'pas de mail à vérifier']) {
    const input = fixture()
    input.epidropt.Exploitations[0].values[2] = identifier
    const result = buildManifest(input)
    t.is(result.exploitations.length, 0)
    t.is(nameDecision(result), undefined)
  }
})

test('la mention pas de mail ne masque pas les champs hydrologiques invalides', t => {
  const input = fixture()
  Object.assign(input.epidropt['Points prélèvement'][0].values, {10: 'pas de mail', 17: 'pas de mail'})
  const result = buildManifest(input)
  t.true(result.issues.some(item => item.code === 'POINT_FIELD_INVALID' && item.field === 'isZre'))
  t.is(result.points[0].data.managementUnit, 'pas de mail')
})

test('l’usage Loisirs utilise le code Sandre 7 sans être confondu avec Domestique', t => {
  for (const [label, expected] of [['Loisirs', '7'], [' LOISIRS ', '7'], ['Domestique', '17']]) {
    const input = fixture()
    input.epidropt.Exploitations[0].values[3] = label
    const result = buildManifest(input)
    t.is(result.exploitations.length, 1)
    t.is(result.exploitations[0].usageCode, expected)
    t.deepEqual(result.issues, [])
  }
})

test('le nom complet personnel suit l’ordre prénom puis nom de la feuille source', t => {
  const input = fixture()
  Object.assign(input.epidropt.Préleveurs[0].values, {3: null, 4: null, 6: 'Camille', 7: 'Exemple'})
  input.epidropt.Exploitations[0].declarantName = 'Camille Exemple'
  t.is(buildManifest(input).exploitations.length, 1)
  input.epidropt.Exploitations[0].declarantName = 'Exemple Camille'
  const reversed = buildManifest(input)
  t.is(reversed.exploitations.length, 0)
  t.is(nameDecision(reversed).reason, 'NAME_NOT_FOUND')
})

test('un nom partiel ou approximatif ne rapproche jamais un préleveur', t => {
  for (const name of ['Prés', 'Ferme des Prés et Fils', 'Ferme des Pres.', 'Ferme des Près A']) {
    const input = fixture()
    input.epidropt.Exploitations[0].declarantName = name
    const result = buildManifest(input)
    t.is(result.exploitations.length, 0)
    t.is(nameDecision(result).reason, 'NAME_NOT_FOUND')
  }
})

test('deux homonymes conservent leurs identités distinctes et bloquent le fallback', t => {
  const input = fixture()
  addDeclarant(input)
  const result = buildManifest(input)
  t.is(result.declarants.length, 2)
  t.is(result.exploitations.length, 0)
  t.is(nameDecision(result).reason, 'NAME_AMBIGUOUS')
  t.is(nameDecision(result).candidateKeys.length, 2)
})

test('un homonyme privé d’identité n’est pas ignoré pour fabriquer une correspondance unique', t => {
  const input = fixture()
  addDeclarant(input, {agencyId: null, siret: null})
  const result = buildManifest(input)
  t.is(result.declarants.length, 1)
  t.is(result.exploitations.length, 0)
  t.is(nameDecision(result).reason, 'NAME_AMBIGUOUS')
  t.true(result.issues.some(item => item.code === 'PRELEVEUR_IDENTITY_MISSING'))
})

test('une identité contradictoire ou ignorée ne devient pas une ancre par son nom', t => {
  const conflict = fixture()
  addDeclarant(conflict, {name: 'Autre nom', agencyId: 'AEAG-A'})
  const unresolved = buildManifest(conflict)
  t.is(unresolved.exploitations.length, 0)
  t.is(nameDecision(unresolved).reason, 'NAME_IDENTITY_UNRESOLVED')

  const skipped = fixture()
  skipped.overrides = {declarants: {'AEAG-A': {skip: true}}}
  const result = buildManifest(skipped)
  t.is(result.exploitations.length, 0)
  t.is(nameDecision(result).reason, 'NAME_IDENTITY_UNRESOLVED')
})

test('un SIRET porté par plusieurs identités source bloque le rapprochement par nom', t => {
  const input = fixture()
  addDeclarant(input, {name: 'Autre ferme', siret: '12345678900001'})
  const result = buildManifest(input)
  t.is(result.exploitations.length, 0)
  t.is(nameDecision(result).reason, 'SIRET_IDENTITY_CONFLICT')
})

test('les doublons de la même identité source ne créent pas de faux homonymes', t => {
  const input = fixture()
  input.epidropt.Préleveurs.push({...structuredClone(input.epidropt.Préleveurs[0]), row: 8})
  const result = buildManifest(input)
  t.is(result.declarants.length, 1)
  t.is(result.exploitations.length, 1)
  t.deepEqual(nameDecision(result).sources.map(source => source.row).sort(), [3, 8])
})

test('email et SIRET explicites priment sur une raison sociale différente', t => {
  for (const identifier of ['ferme@example.test', '12345678900001']) {
    const input = fixture()
    addDeclarant(input, {name: 'Autre ferme'})
    input.epidropt.Exploitations[0].values[2] = identifier
    input.epidropt.Exploitations[0].declarantName = 'Autre ferme'
    const result = buildManifest(input)
    t.is(result.exploitations.length, 1)
    t.is(result.exploitations[0].declarantId, stableId('epidropt:preleveur:aeag:AEAG-A'))
    t.is(nameDecision(result), undefined)
  }
})

test('un email présent mais inconnu, invalide ou partagé n’est pas contourné par le commentaire', t => {
  for (const identifier of ['inconnu@example.test', 'adresse invalide', '12345678900099']) {
    const input = fixture()
    input.epidropt.Exploitations[0].values[2] = identifier
    const result = buildManifest(input)
    t.is(result.exploitations.length, 0)
    t.is(nameDecision(result), undefined)
  }
  const shared = fixture()
  addDeclarant(shared, {name: 'Autre ferme', email: 'ferme@example.test'})
  shared.epidropt.Exploitations[0].values[2] = 'ferme@example.test'
  const result = buildManifest(shared)
  t.is(result.exploitations.length, 0)
  t.is(nameDecision(result), undefined)
})

test('le fallback garde les codes comptage et les identités au rejeu', t => {
  const input = fixture()
  input.epidropt.Exploitations[0].countingCode = '001'
  const first = buildManifest(input)
  const prior = structuredClone(first)
  prior.declarants[0].id = 'existing-declarant'
  prior.exploitations[0].declarantId = 'existing-declarant'
  prior.exploitations[0].id = 'existing-exploitation'
  input.previousManifest = prior
  input.epidropt.Préleveurs[0].row = 20
  input.epidropt.Exploitations[0].row = 30
  const result = buildManifest(input)
  t.is(result.declarants[0].id, 'existing-declarant')
  t.is(result.exploitations[0].id, 'existing-exploitation')
  t.is(result.exploitations[0].declarantId, 'existing-declarant')
  t.is(result.exploitations[0].countingCode, '001')
  t.is(result.exploitations[0].sourceId, first.exploitations[0].sourceId)
})

test('un commentaire absent ou une exploitation explicitement ignorée ne déclenche pas le fallback', t => {
  const input = fixture()
  delete input.epidropt.Exploitations[0].declarantName
  const result = buildManifest(input)
  t.is(result.exploitations.length, 0)
  t.is(nameDecision(result), undefined)

  const skipped = fixture()
  skipped.overrides = {exploitations: {[digest(skipped.epidropt.Exploitations[0].values)]: {skip: true}}}
  const ignored = buildManifest(skipped)
  t.is(ignored.exploitations.length, 0)
  t.is(nameDecision(ignored), undefined)
})
