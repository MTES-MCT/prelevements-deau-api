import test from 'ava'

import {
  parseSmartSearch,
  rankCollecteurPreleveurIds,
  rankDeclarantIds,
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
      {value: 'elodie', compact: 'elodie', fuzzyThreshold: 0.5},
      {value: 'bss', compact: 'bss', fuzzyThreshold: null},
      {value: '001', compact: '001', fuzzyThreshold: null}
    ]
  })
})

test('le fuzzy est réservé aux textes humains suffisamment longs', async t => {
  const queries = []
  const client = {
    async $queryRaw(query) {
      queries.push(query)
      return []
    }
  }

  await rankDeclarantIds([DECLARANT_ID], 'captge', {client})
  await rankPointIds([DECLARANT_ID], 'BSS00123', {client})
  await rankPointIds([DECLARANT_ID], 'BVTECH_INTERNE', {
    client,
    includeSensitiveIdentifiers: true
  })

  t.regex(sqlText(queries[0]), /strict_word_similarity/)
  t.notRegex(sqlText(queries[1]), /strict_word_similarity/)
  t.regex(sqlText(queries[1]), /compact_identifier_document/)
  t.regex(sqlText(queries[1]), /ORDER BY relevance DESC, document\.primary_label ASC/)
  t.notRegex(sqlText(queries[1]), /point\.identifiers::text|point\."codeAIOT"/)
  t.regex(sqlText(queries[2]), /point\.identifiers::text/)
  t.regex(sqlText(queries[2]), /point\."codeAIOT"/)
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
  t.regex(text, /exploitation\.id = allowed_exploitation\.exploitation_id/)
  t.notRegex(text, /exploitation\."declarantUserId" = allowed_exploitation\.declarant_id/)
  t.regex(text, /pointPrelevementNameAliases/)
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
  t.notRegex(text, /point\.identifiers::text|point\."codeAIOT"/)
  t.true(capturedQuery.values.includes(EXPLOITATION_ID))
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
