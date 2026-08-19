import test from 'ava'

import {
  getAdjacentTranspositions,
  parseSmartSearch,
  rankCollecteurPreleveurIds,
  rankDeclarantIds,
  rankExploitationIds,
  rankPointIds,
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
  t.regex(text, /pointPrelevementNameAliases/)
  t.is((text.match(/water_use\.mnemonic/g) ?? []).length, 1)
  t.regex(
    text,
    /point\."codePTP",\s+water_use\.mnemonic,\s+exploitation_declarant\.siret/
  )
  t.notRegex(text, /water_use\.label,\s+water_use\.mnemonic/)
  t.true(capturedQuery.values.includes(DECLARANT_ID))
  t.true(capturedQuery.values.includes(EXPLOITATION_ID))
  t.is(capturedQuery.values.filter(value => value === EXPLOITATION_ID).length, 1)
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
  t.is((text.match(/water_use\.mnemonic/g) ?? []).length, 1)
  t.regex(text, /water_use\.mnemonic,\s+declarant\.siret/)
  t.notRegex(text, /water_use\.label,\s+water_use\.mnemonic/)
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
  t.is((text.match(/water_use\.mnemonic/g) ?? []).length, 2)
  t.is((text.match(
    /point\."codePTP",\s+water_use\.mnemonic,\s+declarant\.siret/g
  ) ?? []).length, 2)
  t.notRegex(text, /water_use\.label,\s+water_use\.mnemonic/)
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
