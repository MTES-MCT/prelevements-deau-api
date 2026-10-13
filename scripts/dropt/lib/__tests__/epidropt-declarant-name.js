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

test('un email présent mais inconnu ou invalide n’est pas contourné par le commentaire', t => {
  for (const identifier of ['inconnu@example.test', 'adresse invalide', '12345678900099']) {
    const input = fixture()
    input.epidropt.Exploitations[0].values[2] = identifier
    const result = buildManifest(input)
    t.is(result.exploitations.length, 0)
    t.is(nameDecision(result), undefined)
  }
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

function sharedEmailFixture() {
  const input = fixture()
  addDeclarant(input, {name: 'Autre ferme', email: 'ferme@example.test'})
  input.epidropt.Exploitations[0].values[2] = 'ferme@example.test'
  return input
}

function sharedEmailDecision(manifest) {
  return manifest.reconciliation.find(item => item.method === 'EMAIL_INTERSECTION_EXACT_SOURCE_NAME')
}

test('un email partagé est départagé par le nom complet exact de la source sans fusion ni accès de connexion', t => {
  const input = sharedEmailFixture()
  input.epidropt.Exploitations[0].declarantName = ' FERME  des\u00a0PRES '
  const before = structuredClone(input)
  const result = buildManifest(input)
  t.is(result.declarants.length, 2)
  t.is(result.exploitations.length, 1)
  t.is(result.exploitations[0].declarantId, stableId('epidropt:preleveur:aeag:AEAG-A'))
  t.true(result.declarants.every(owner => owner.user.email === null))
  t.true(result.declarants.every(owner => owner.emails.includes('ferme@example.test')))
  t.like(sharedEmailDecision(result), {status: 'ACCEPTED', reason: null, candidateKey: 'epidropt:preleveur:aeag:AEAG-A',
    candidateId: result.exploitations[0].declarantId, sources: [{sheet: 'Préleveurs', row: 3}]})
  t.deepEqual(input, before)
})

test('email partagé : les noms partiels, inconnus et hors des candidats email restent bloqués', t => {
  for (const name of ['Prés', 'Ferme des Prés et Fils', 'Ferme des Pres.', 'Ferme introuvable', 'Ferme tierce']) {
    const input = sharedEmailFixture()
    addDeclarant(input, {name: 'Ferme tierce', agencyId: 'AEAG-C', siret: '12345678900003'})
    input.epidropt.Exploitations[0].declarantName = name
    const result = buildManifest(input)
    t.is(result.exploitations.length, 0, `Nom : ${name}`)
    t.is(sharedEmailDecision(result).reason, name === 'Ferme tierce' ? 'NAME_OUTSIDE_EMAIL_CANDIDATES' : 'NAME_NOT_FOUND')
    t.true(result.issues.some(issue => issue.code === 'EXPLOITATION_UNRESOLVED' && issue.reason === 'PRELEVEUR'))
  }
})

test('email partagé : les homonymes ignorés ou privés d’identité ne rendent pas le nom unique', t => {
  for (const variant of ['same-name', 'missing-identity', 'skipped']) {
    const input = sharedEmailFixture()
    addDeclarant(input, {agencyId: variant === 'missing-identity' ? null : 'AEAG-C',
      siret: variant === 'missing-identity' ? null : '12345678900003'})
    if (variant === 'skipped') input.overrides = {declarants: {'AEAG-C': {skip: true}}}
    const result = buildManifest(input)
    t.is(result.exploitations.length, 0, `Variante : ${variant}`)
    t.is(sharedEmailDecision(result).reason, 'NAME_AMBIGUOUS')
  }
})

test('email partagé : une identité rejetée ou ignorée ne cède pas son exploitation au candidat restant', t => {
  for (const variant of ['skipped', 'conflicting-name', 'conflicting-siret']) {
    const input = sharedEmailFixture()
    if (variant === 'skipped') input.overrides = {declarants: {'AEAG-A': {skip: true}}}
    else addDeclarant(input, {agencyId: 'AEAG-A', name: variant === 'conflicting-name' ? 'Autre identité' : 'Ferme des Prés'})
    const result = buildManifest(input)
    t.is(result.exploitations.length, 0, `Variante : ${variant}`)
    t.is(sharedEmailDecision(result).reason, 'NAME_IDENTITY_UNRESOLVED')
  }
})

test('email partagé : SIRET source partagé même avec une ligne ignorée et UUID source contradictoires restent bloqués', t => {
  for (const variant of ['same-siret', 'skipped-siret', 'invalid-siret', 'same-uuid', 'same-agency']) {
    const input = sharedEmailFixture()
    if (variant === 'same-uuid') input.overrides = {declarants: {'AEAG-B': {id: stableId('epidropt:preleveur:aeag:AEAG-A')}}}
    else if (variant === 'same-agency') {
      addDeclarant(input, {name: 'Ferme tierce', agencyId: 'AEAG-A', siret: '12345678900003'})
      input.overrides = {declarants: {'AEAG-A': {skip: true}}}
    } else if (variant === 'invalid-siret') input.epidropt.Préleveurs[0].values[3] = 'SIRET-INCOHERENT'
    else {
      addDeclarant(input, {name: 'Ferme tierce', agencyId: 'AEAG-C', siret: '12345678900001'})
      if (variant === 'skipped-siret') input.overrides = {declarants: {'AEAG-C': {skip: true}}}
    }
    const result = buildManifest(input)
    t.is(result.exploitations.length, 0, `Variante : ${variant}`)
    t.is(sharedEmailDecision(result).reason, variant === 'same-uuid' ? 'IDENTITY_LEDGER_CONFLICT'
      : variant === 'same-agency' ? 'NAME_IDENTITY_UNRESOLVED' : 'SIRET_IDENTITY_CONFLICT')
  }
})

test('email partagé : une contradiction du commentaire ne retombe jamais sur le nom du contrat Rives', t => {
  const input = sharedEmailFixture()
  const pointName = '240000001CACG_90001'
  input.epidropt['Points prélèvement'][0].values[1] = pointName
  input.epidropt.Exploitations[0].values[1] = pointName
  input.epidropt.Exploitations[0].declarantName = 'Nom contradictoire'
  input.rives = {Contrat: [{row: 2, values: ['C-A', 'CLIENT-A', 'Ferme des Prés', 10000, 5]}],
    Compteur: [{row: 2, values: ['SYNTHETIC-METER']}], Lieu: [{row: 2, values: ['L-A', pointName, 'Lieu A', 0.4, 44.6]}],
    Affectation: [{row: 2, values: ['C-A', 'L-A', pointName, 'SYNTHETIC-METER', 100]}]}
  input.snapshot = {tables: {declarants: [{userId: stableId('epidropt:preleveur:aeag:AEAG-A'), siret: '12345678900001'}]}}
  const blocked = buildManifest(input)
  t.is(blocked.exploitations.length, 0)
  t.is(sharedEmailDecision(blocked).reason, 'NAME_NOT_FOUND')
  t.false(blocked.reconciliation.some(item => item.method === 'EMAIL_INTERSECTION_EXACT_CONTRACT_NAME'))
  delete input.epidropt.Exploitations[0].declarantName
  const unchangedFallback = buildManifest(input)
  t.is(unchangedFallback.exploitations.length, 1, 'sans commentaire le repli Rives existant reste inchangé')
  t.true(unchangedFallback.reconciliation.some(item => item.method === 'EMAIL_INTERSECTION_EXACT_CONTRACT_NAME' && item.status === 'ACCEPTED'))
})

test('email partagé : contradictions SIRET, référence, source et suppression dans le snapshot bloquent le rapprochement', t => {
  for (const variant of ['current-siret', 'other-siret', 'deleted-siret', 'other-reference', 'source', 'deleted-owner']) {
    const input = sharedEmailFixture()
    const candidate = buildManifest(input).declarants.find(owner => owner.key === 'epidropt:preleveur:aeag:AEAG-A')
    const current = {userId: candidate.id, sourceId: candidate.sourceId, siret: candidate.data.siret}
    input.snapshot = {tables: {declarants: [current], externalReferences: []}}
    if (variant === 'current-siret') current.siret = '12345678900099'
    if (['other-siret', 'deleted-siret'].includes(variant)) input.snapshot.tables.declarants.push({userId: 'another-id',
      siret: current.siret, ...(variant === 'deleted-siret' ? {deletedAt: '2026-01-01T00:00:00.000Z'} : {})})
    if (variant === 'other-reference') input.snapshot.tables.externalReferences.push({scope: 'epidropt', kind: 'DECLARANT',
      provider: 'epidropt', externalId: 'AEAG-OTHER', declarantUserId: candidate.id})
    if (variant === 'source') current.sourceId = 'unrelated-source'
    if (variant === 'deleted-owner') current.deletedAt = '2026-01-01T00:00:00.000Z'
    const result = buildManifest(input)
    t.is(result.exploitations.length, 0, `Variante : ${variant}`)
    t.is(sharedEmailDecision(result).status, 'REVIEW')
  }
})

test('email partagé : le rejeu garde les anciennes identités, deux comptages et ajoute seulement les quatre liens manquants', t => {
  const input = sharedEmailFixture()
  const sourcePoint = input.epidropt['Points prélèvement'][0].values
  input.epidropt['Points prélèvement'] = Array.from({length: 5}, (_, index) => ({row: 3 + index,
    values: Object.assign([...sourcePoint], {1: `POINT-${index}`})}))
  const sourceExploitation = input.epidropt.Exploitations[0]
  input.epidropt.Exploitations = ['001', '002'].map((countingCode, index) => ({...structuredClone(sourceExploitation), row: 3 + index,
    countingCode, values: Object.assign([...sourceExploitation.values], {1: 'POINT-0'})}))
  const previous = buildManifest(input)
  const owner = previous.declarants.find(record => record.key === 'epidropt:preleveur:aeag:AEAG-A')
  owner.id = 'existing-owner'
  owner.sourceId = 'existing-owner-source'
  for (const [index, record] of previous.exploitations.entries()) {
    record.id = `existing-exploitation-${index}`
    record.declarantId = owner.id
    record.sourceId = `existing-exploitation-source-${index}`
  }
  input.previousManifest = previous
  input.snapshot = {tables: {declarants: [{userId: owner.id, sourceId: owner.sourceId, siret: owner.data.siret}],
    externalReferences: [{scope: 'epidropt', kind: 'DECLARANT', provider: 'epidropt', externalId: 'AEAG-A', declarantUserId: owner.id}]}}
  for (let index = 1; index < 5; index++) input.epidropt.Exploitations.push({...structuredClone(sourceExploitation), row: 4 + index,
    values: Object.assign([...sourceExploitation.values], {1: `POINT-${index}`})})
  const result = buildManifest(input)
  t.is(result.exploitations.length, 6)
  t.is(new Set(result.exploitations.map(record => record.pointId)).size, 5)
  t.true(result.exploitations.every(record => record.declarantId === owner.id))
  t.deepEqual(result.exploitations.filter(record => record.countingCode).map(record => [record.id, record.sourceId, record.countingCode]).sort(),
    previous.exploitations.map(record => [record.id, record.sourceId, record.countingCode]).sort())
  t.is(sharedEmailDecision(result).candidateId, owner.id)
  input.previousManifest = result
  const replay = buildManifest(input)
  t.deepEqual(replay.exploitations.map(record => [record.id, record.sourceId]).sort(), result.exploitations.map(record => [record.id, record.sourceId]).sort())
  t.is(replay.declarants.find(record => record.id === owner.id).user.email, null)
})
