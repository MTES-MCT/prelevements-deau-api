import test from 'ava'

import {
  getAdjacentTranspositions,
  parseSmartSearch,
  rankCollecteurPreleveurIds,
  rankDeclarantIds,
  rankExploitationIds,
  rankPointIds,
  rankSearchDocuments,
  rankScopedPointIds
} from '../smart-search.js'

const DECLARANT_ID = '73e76b9a-0b61-43e0-a45c-99052970ab14'
const EXPLOITATION_ID = '8c67a193-1c5c-4c9f-8ed3-6e4e6040ed37'

function sqlText(query) {
  return query.strings.join('?')
}

test('parseSmartSearch normalise accents, ponctuation et termes dupliqués', t => {
  t.deepEqual(parseSmartSearch('  Élodie—BSS 001, élodie  '), {
    normalized: 'elodie bss 001 elodie',
    compact: 'elodiebss001elodie',
    terms: [
      {value: 'elodie', compact: 'elodie', approximate: true},
      {value: 'bss', compact: 'bss', approximate: false},
      {value: '001', compact: '001', approximate: false}
    ]
  })
})

test('parseSmartSearch normalise les ligatures françaises', t => {
  t.deepEqual(parseSmartSearch('Cœur et ex æquo'), {
    normalized: 'coeur et ex aequo',
    compact: 'coeuretexaequo',
    terms: [
      {value: 'coeur', compact: 'coeur', approximate: true},
      {value: 'et', compact: 'et', approximate: false},
      {value: 'ex', compact: 'ex', approximate: false},
      {value: 'aequo', compact: 'aequo', approximate: true}
    ]
  })
})

test('parseSmartSearch garde exacts les fragments d’identifiants techniques', t => {
  const search = parseSmartSearch(
    'ferme BVTECH_INTERNE agent@example.test BSS-ABC deadbeef-cafe-babe-acde-deadbeefcafe'
  )

  t.deepEqual(
    Object.fromEntries(search.terms.map(term => [term.value, term.approximate])),
    {
      ferme: true,
      bvtech: false,
      interne: false,
      agent: false,
      example: false,
      test: false,
      bss: false,
      abc: false,
      deadbeef: false,
      cafe: false,
      babe: false,
      acde: false
    }
  )
})

test('les transpositions adjacentes couvrent femre sans produire de doublons', t => {
  t.deepEqual(getAdjacentTranspositions('ferme'), [
    'efrme',
    'freme',
    'femre',
    'ferem'
  ])
  t.deepEqual(getAdjacentTranspositions('allee'), ['lalee', 'alele'])
})

test('le classement mémoire conserve les poids et le ET entre les termes SQL', t => {
  const documents = [{
    id: 'exact',
    primaryLabel: 'Ferme Beauvert',
    humanText: 'Ferme Beauvert Saint-Martin',
    identifierText: 'contact@example.test'
  }, {
    id: 'avec-preposition',
    primaryLabel: 'Ferme de Beauvert',
    humanText: 'Ferme de Beauvert Saint-Martin',
    identifierText: 'autre@example.test'
  }, {
    id: 'terme-manquant',
    primaryLabel: 'Ferme des Prés',
    humanText: 'Ferme des Prés Saint-Martin',
    identifierText: 'beau@example.test'
  }]

  t.deepEqual(rankSearchDocuments(documents, 'ferme beauvert'), [
    {id: 'exact', relevance: 2350},
    {id: 'avec-preposition', relevance: 200}
  ])
  t.deepEqual(rankSearchDocuments(documents, 'ferme de beauvert'), [
    {id: 'avec-preposition', relevance: 2430}
  ])
  t.deepEqual(rankSearchDocuments(documents, '   '), [])
})

test('le classement mémoire normalise accents et ligatures sans modifier ses entrées', t => {
  const documents = [{
    id: 'ligatures',
    primaryLabel: 'Ferme du Cœur',
    humanText: 'Ferme du Cœur ex æquo à Évry',
    identifierText: ''
  }]
  const before = structuredClone(documents)

  t.deepEqual(rankSearchDocuments(documents, 'COEUR ÆQUO evry'), [
    {id: 'ligatures', relevance: 240}
  ])
  t.deepEqual(documents, before)
})

test('le classement mémoire tolère une seule édition humaine et les transpositions', t => {
  const documents = [{
    id: 'beauvert',
    primaryLabel: 'Ferme de Beauvert',
    humanText: 'Ferme de Beauvert',
    identifierText: ''
  }]

  for (const query of ['ferne beauvert', 'fermee beauvert']) {
    t.deepEqual(rankSearchDocuments(documents, query), [
      {id: 'beauvert', relevance: 110}
    ])
  }

  t.deepEqual(rankSearchDocuments(documents, 'ferm beauvert'), [
    {id: 'beauvert', relevance: 200}
  ])
  t.deepEqual(rankSearchDocuments(documents, 'femre beavert'), [
    {id: 'beauvert', relevance: 60}
  ])
  t.deepEqual(rankSearchDocuments(documents, 'fxxme beauvert'), [])
  t.deepEqual(rankSearchDocuments(documents, 'fmr beauvert'), [])
})

test('le classement mémoire ne rend jamais approximatifs les identifiants', t => {
  const documents = [{
    id: 'email',
    primaryLabel: 'Contact',
    humanText: 'Contact technique',
    identifierText: 'agent@example.test'
  }, {
    id: 'siret',
    primaryLabel: 'Société',
    humanText: 'Société Beauvert',
    identifierText: '123 456 789 01234'
  }, {
    id: 'bss',
    primaryLabel: 'Forage',
    humanText: 'Forage Beauvert',
    identifierText: 'BSS-00123'
  }, {
    id: 'uuid',
    primaryLabel: 'Point',
    humanText: 'Point Beauvert',
    identifierText: '73e76b9a-0b61-43e0-a45c-99052970ab14'
  }, {
    id: 'telephone',
    primaryLabel: 'Téléphone',
    humanText: 'Contact téléphonique',
    identifierText: '+33 6 12 34 56 78'
  }]

  t.deepEqual(rankSearchDocuments(documents, 'agent@example.test').map(({id}) => id), ['email'])
  t.deepEqual(rankSearchDocuments(documents, '12345678901234').map(({id}) => id), ['siret'])
  t.deepEqual(rankSearchDocuments(documents, 'BSS 00123').map(({id}) => id), ['bss'])
  t.deepEqual(
    rankSearchDocuments(documents, '73e76b9a-0b61-43e0-a45c-99052970ab14')
      .map(({id}) => id),
    ['uuid']
  )
  t.deepEqual(rankSearchDocuments(documents, '+33 6 12 34 56 78').map(({id}) => id), [
    'telephone'
  ])

  for (const query of [
    'agnet@example.test',
    '12345678901235',
    'BSS-00124',
    '73e76b9a-0b61-43e0-a45c-99052970ab15',
    '+33 6 12 34 56 79'
  ]) {
    t.deepEqual(rankSearchDocuments(documents, query), [])
  }
})

test('le document compact optionnel garde les identifiants ponctués recherchables', t => {
  t.deepEqual(rankSearchDocuments([{
    id: 'bss',
    primaryLabel: 'Forage',
    humanText: 'Forage',
    identifierText: '',
    compactIdentifierText: 'BSS00123'
  }], 'BSS-00123'), [{id: 'bss', relevance: 1060}])
})

test('le classement mémoire tranche les égalités de façon déterministe', t => {
  const documents = [{
    id: 'z',
    primaryLabel: 'Bêta',
    humanText: 'Terme commun',
    identifierText: ''
  }, {
    id: 'b',
    primaryLabel: 'Alpha',
    humanText: 'Terme commun',
    identifierText: ''
  }, {
    id: 'a',
    primaryLabel: 'Alpha',
    humanText: 'Terme commun',
    identifierText: ''
  }]

  t.deepEqual(rankSearchDocuments(documents, 'commun'), [
    {id: 'a', relevance: 530},
    {id: 'b', relevance: 530},
    {id: 'z', relevance: 530}
  ])
})

test('une édition est garantie uniquement sur les mots humains', async t => {
  const queries = []
  const client = {
    async $queryRaw(query) {
      queries.push(query)
      return []
    }
  }

  await rankDeclarantIds([DECLARANT_ID], 'ferne', {client})
  await rankDeclarantIds([DECLARANT_ID], 'ferm', {client})
  await rankDeclarantIds([DECLARANT_ID], 'fermee', {client})
  await rankDeclarantIds([DECLARANT_ID], 'femre', {client})
  await rankDeclarantIds([DECLARANT_ID], 'ferne beauvert', {client})
  await rankDeclarantIds([DECLARANT_ID], 'fxxme', {client})
  await rankPointIds([DECLARANT_ID], 'BSS00123', {client})
  await rankDeclarantIds([DECLARANT_ID], 'siret 12345678901234', {client})
  await rankDeclarantIds([DECLARANT_ID], 'fer', {client})
  await rankPointIds([DECLARANT_ID], 'BVTECH_INTERNE', {
    client,
    includeSensitiveIdentifiers: true
  })

  for (const query of queries.slice(0, 6)) {
    const text = sqlText(query)
    t.regex(text, /document AS MATERIALIZED/)
    t.regex(text, /string_to_table\(btrim\(document\.human_document\)/)
    t.regex(text, /char_length\(human_token\.value\) BETWEEN \? AND \?/)
    t.regex(text, /public\.levenshtein_less_equal\(\?, human_token\.value, 1\) <= 1/)
    t.notRegex(text, /strict_word_similarity/)
    t.true(query.values.includes(30))
  }

  const transpositionArrays = queries[3].values.filter(Array.isArray)
  t.true(transpositionArrays.some(values => values.includes('ferme')))
  const doubleTypoTranspositions = queries[5].values.filter(Array.isArray)
  t.false(doubleTypoTranspositions.some(values => values.includes('ferme')))
  t.true((sqlText(queries[4]).match(/levenshtein_less_equal/g) ?? []).length >= 2)

  for (const query of queries.slice(6, 9)) {
    t.notRegex(sqlText(query), /levenshtein_less_equal|string_to_table/)
  }

  t.regex(sqlText(queries[6]), /compact_identifier_document/)
  t.regex(sqlText(queries[6]), /ORDER BY relevance DESC, document\.primary_label ASC/)
  t.notRegex(sqlText(queries[6]), /point\.identifiers::text|point\."codeAIOT"/)
  t.regex(sqlText(queries[9]), /point\.identifiers::text/)
  t.regex(sqlText(queries[9]), /point\."codeAIOT"/)
  t.notRegex(sqlText(queries[9]), /levenshtein_less_equal|string_to_table/)
})

test('la recherche collecteur ne joint que les exploitations explicitement autorisées', async t => {
  let capturedQuery
  const client = {
    async $queryRaw(query) {
      capturedQuery = query
      return [{id: DECLARANT_ID, relevance: 800}]
    }
  }

  const result = await rankCollecteurPreleveurIds([{
    declarantId: DECLARANT_ID,
    exploitationIds: [EXPLOITATION_ID, EXPLOITATION_ID]
  }], 'captage BSS-001', {client})
  const text = sqlText(capturedQuery)

  t.deepEqual(result, [{id: DECLARANT_ID, relevance: 800}])
  t.regex(text, /candidate_exploitations \(declarant_id, exploitation_id\)/)
  t.regex(text, /FROM unnest\(/)
  t.notRegex(text, /\bVALUES\b/)
  t.regex(text, /linked_exploitations AS MATERIALIZED/)
  t.regex(text, /GROUP BY allowed_exploitation\.declarant_id/)
  t.regex(
    text,
    /LEFT JOIN linked_exploitations\s+ON linked_exploitations\.declarant_id = declarant\."userId"/
  )
  t.regex(text, /exploitation\.id = allowed_exploitation\.exploitation_id/)
  t.notRegex(text, /exploitation\."declarantUserId" = allowed_exploitation\.declarant_id/)
  t.notRegex(text, /WHERE allowed_exploitation\.declarant_id = declarant\."userId"/)
  t.notRegex(text, /LEFT JOIN LATERAL/)
  t.regex(text, /DeclarantPointPrelevementSecondaryUsage/)
  t.regex(text, /count|exploitation_usage_summaries/)
  t.regex(text, /pointPrelevementNameAliases/)
  t.is((text.match(/water_use\.mnemonic/g) ?? []).length, 3)
  t.regex(
    text,
    /point\."codePTP",\s+water_use\.mnemonic,\s+exploitation_declarant\.siret/
  )
  const arrayParameters = capturedQuery.values.filter(Array.isArray)
  t.true(arrayParameters.some(values => values.includes(DECLARANT_ID)))
  t.true(arrayParameters.some(values => values.includes(EXPLOITATION_ID)))
  t.is(arrayParameters.flat().filter(value => value === EXPLOITATION_ID).length, 1)
})

test('la recherche relationnelle d’un point borne aussi les exploitations jointes', async t => {
  let capturedQuery
  const client = {
    async $queryRaw(query) {
      capturedQuery = query
      return []
    }
  }

  await rankScopedPointIds([{
    pointId: DECLARANT_ID,
    exploitationIds: [EXPLOITATION_ID]
  }], 'irrigant captage', {client})

  const text = sqlText(capturedQuery)
  t.regex(text, /candidate_exploitations \(point_id, exploitation_id\)/)
  t.regex(text, /exploitation\."pointPrelevementId" = allowed_exploitation\.point_id/)
  t.regex(text, /collector_link\."exploitationId" = exploitation\.id/)
  t.regex(text, /collector_user\."deletedAt" IS NULL/)
  t.regex(text, /DeclarantPointPrelevementSecondaryUsage/)
  t.is((text.match(/water_use\.mnemonic/g) ?? []).length, 3)
  t.regex(text, /water_use\.mnemonic,\s+declarant\.siret/)
  t.notRegex(text, /point\.identifiers::text|point\."codeAIOT"/)
  t.true(capturedQuery.values.includes(EXPLOITATION_ID))
})

test('les documents d’exploitation n’indexent pas les collecteurs supprimés', async t => {
  let capturedQuery
  const client = {
    async $queryRaw(query) {
      capturedQuery = query
      return []
    }
  }

  await rankExploitationIds([EXPLOITATION_ID], 'collecteur historique', {client})

  const text = sqlText(capturedQuery)
  t.regex(text, /collector_link\."exploitationId" = exploitation\.id/)
  t.regex(text, /collector_user\."deletedAt" IS NULL/)
  t.regex(text, /DeclarantPointPrelevementSecondaryUsage/)
  t.is((text.match(/water_use\.mnemonic/g) ?? []).length, 4)
  t.is((text.match(
    /point\."codePTP",\s+water_use\.mnemonic,\s+declarant\.siret/g
  ) ?? []).length, 2)
})

test('aucune requête SQL ne part sans candidat autorisé', async t => {
  const client = {
    async $queryRaw() {
      t.fail('Une recherche sans candidat doit échouer fermée avant SQL.')
    }
  }

  t.deepEqual(await rankDeclarantIds([], 'captage', {client}), [])
  t.deepEqual(await rankCollecteurPreleveurIds([], 'captage', {client}), [])
})
