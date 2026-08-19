import prismaPkg from '@prisma/client'

import {prisma} from '../../db/prisma.js'

const {Prisma} = prismaPkg

const IDENTIFIER_WORDS = new Set([
  'aiot',
  'bdlisa',
  'bnpe',
  'bss',
  'ptp',
  'siret',
  'uuid'
])

function normalizeText(value) {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('fr-FR')
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036F]/g, '')
    .replaceAll(/[^a-z\d]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

function compactText(value) {
  return normalizeText(value).replaceAll(' ', '')
}

function getFuzzyThreshold(term) {
  if (!/^[a-z]+$/.test(term) || term.length < 5 || IDENTIFIER_WORDS.has(term)) {
    return null
  }

  if (term.length <= 5) {
    return 0.6
  }

  if (term.length <= 7) {
    return 0.5
  }

  return 0.45
}

export function parseSmartSearch(value) {
  const normalized = normalizeText(value).slice(0, 200)
  const terms = [...new Set(normalized.split(' ').filter(Boolean))]
    .slice(0, 12)
    .map(term => ({
      value: term,
      compact: compactText(term),
      fuzzyThreshold: getFuzzyThreshold(term)
    }))

  return {
    normalized,
    compact: compactText(value).slice(0, 200),
    terms
  }
}

function normalizedDocumentSql(value) {
  return Prisma.sql`regexp_replace(lower(public.unaccent(${value})), '[^a-z0-9]+', ' ', 'g')`
}

function compactDocumentSql(value) {
  return Prisma.sql`regexp_replace(lower(public.unaccent(${value})), '[^a-z0-9]+', '', 'g')`
}

function termMatchesSql(term) {
  const contains = `%${term.value}%`
  const compactContains = `%${term.compact}%`
  const fuzzy = term.fuzzyThreshold === null
    ? Prisma.empty
    : Prisma.sql`
      OR strict_word_similarity(${term.value}, document.human_document) >= ${term.fuzzyThreshold}
    `

  return Prisma.sql`(
    document.human_document LIKE ${contains}
    OR document.identifier_document LIKE ${contains}
    OR document.compact_identifier_document LIKE ${compactContains}
    ${fuzzy}
  )`
}

function termScoreSql(term) {
  const contains = `%${term.value}%`
  const prefix = `${term.value}%`
  const compactContains = `%${term.compact}%`
  const fuzzyScore = term.fuzzyThreshold === null
    ? Prisma.sql`0`
    : Prisma.sql`
      CASE
        WHEN strict_word_similarity(${term.value}, document.human_document) >= ${term.fuzzyThreshold}
          THEN strict_word_similarity(${term.value}, document.human_document) * 45
        ELSE 0
      END
    `

  return Prisma.sql`GREATEST(
    CASE WHEN document.primary_label = ${term.value} THEN 160 ELSE 0 END,
    CASE WHEN document.primary_label LIKE ${prefix} THEN 120 ELSE 0 END,
    CASE WHEN document.human_document LIKE ${contains} THEN 80 ELSE 0 END,
    CASE WHEN document.identifier_document LIKE ${contains} THEN 110 ELSE 0 END,
    CASE WHEN document.compact_identifier_document LIKE ${compactContains} THEN 130 ELSE 0 END,
    ${fuzzyScore}
  )`
}

function relevanceSql(search) {
  const phraseContains = `%${search.normalized}%`
  const phrasePrefix = `${search.normalized}%`
  const compactContains = `%${search.compact}%`
  const termScores = search.terms.length === 0
    ? Prisma.sql`0`
    : Prisma.join(search.terms.map(termScoreSql), ' + ')

  return Prisma.sql`(
    CASE WHEN document.primary_label = ${search.normalized} THEN 1000 ELSE 0 END
    + CASE WHEN document.primary_label LIKE ${phrasePrefix} THEN 700 ELSE 0 END
    + CASE WHEN document.human_document LIKE ${phraseContains} THEN 450 ELSE 0 END
    + CASE
        WHEN ${search.compact} <> ''
          AND document.compact_identifier_document LIKE ${compactContains}
          THEN 800
        ELSE 0
      END
    + ${termScores}
  )`
}

function rankedDocumentsSql(
  documentsSql,
  candidateIds,
  query,
  {additionalCandidateCtes = Prisma.empty} = {}
) {
  const search = parseSmartSearch(query)

  if (candidateIds.length === 0 || search.terms.length === 0) {
    return null
  }

  const predicates = Prisma.join(search.terms.map(termMatchesSql), ' AND ')

  return Prisma.sql`
    WITH candidate_ids AS (
      SELECT unnest(${candidateIds}::uuid[]) AS id
    ),
    ${additionalCandidateCtes}
    document AS (
      ${documentsSql}
    )
    SELECT
      document.id,
      ${relevanceSql(search)}::double precision AS relevance
    FROM document
    WHERE ${predicates}
    ORDER BY relevance DESC, document.primary_label ASC, document.id ASC
  `
}

async function rankDocuments(
  documentsSql,
  candidateIds,
  query,
  {additionalCandidateCtes = Prisma.empty, client = prisma} = {}
) {
  const uniqueIds = [...new Set((candidateIds ?? []).filter(Boolean))]
  const sql = rankedDocumentsSql(documentsSql, uniqueIds, query, {
    additionalCandidateCtes
  })

  if (!sql) {
    return []
  }

  return client.$queryRaw(sql)
}

const DECLARANT_DOCUMENTS_SQL = Prisma.sql`
  SELECT
    user_account.id,
    ${normalizedDocumentSql(Prisma.sql`coalesce(
      nullif(declarant."socialReason", ''),
      nullif(concat_ws(' ', user_account."firstName", user_account."lastName"), ''),
      user_account.email,
      ''
    )`)} AS primary_label,
    ${normalizedDocumentSql(Prisma.sql`concat_ws(
      ' ',
      user_account."firstName",
      user_account."lastName",
      declarant."socialReason",
      declarant.city,
      declarant."jobTitle"
    )`)} AS human_document,
    ${normalizedDocumentSql(Prisma.sql`concat_ws(
      ' ',
      user_account.id::text,
      user_account.email,
      declarant.siret,
      declarant."phoneNumber",
      declarant."sourceId"
    )`)} AS identifier_document,
    ${compactDocumentSql(Prisma.sql`concat_ws(
      ' ',
      user_account.id::text,
      user_account.email,
      declarant.siret,
      declarant."phoneNumber",
      declarant."sourceId"
    )`)} AS compact_identifier_document
  FROM candidate_ids candidate
  JOIN "User" user_account ON user_account.id = candidate.id
  JOIN "Declarant" declarant ON declarant."userId" = user_account.id
`

const COLLECTEUR_PRELEVEUR_DOCUMENTS_SQL = Prisma.sql`
  SELECT
    user_account.id,
    ${normalizedDocumentSql(Prisma.sql`coalesce(
      nullif(declarant."socialReason", ''),
      nullif(concat_ws(' ', user_account."firstName", user_account."lastName"), ''),
      user_account.email,
      ''
    )`)} AS primary_label,
    ${normalizedDocumentSql(Prisma.sql`concat_ws(
      ' ',
      user_account."firstName",
      user_account."lastName",
      declarant."socialReason",
      declarant.city,
      declarant."jobTitle",
      linked_exploitations.human_values
    )`)} AS human_document,
    ${normalizedDocumentSql(Prisma.sql`concat_ws(
      ' ',
      user_account.id::text,
      user_account.email,
      declarant.siret,
      declarant."phoneNumber",
      declarant."sourceId",
      linked_exploitations.identifier_values
    )`)} AS identifier_document,
    ${compactDocumentSql(Prisma.sql`concat_ws(
      ' ',
      user_account.id::text,
      user_account.email,
      declarant.siret,
      declarant."phoneNumber",
      declarant."sourceId",
      linked_exploitations.identifier_values
    )`)} AS compact_identifier_document
  FROM candidate_ids candidate
  JOIN "User" user_account ON user_account.id = candidate.id
  JOIN "Declarant" declarant ON declarant."userId" = user_account.id
  LEFT JOIN LATERAL (
    SELECT
      string_agg(concat_ws(
        ' ',
        point.name,
        point."usageName",
        point."communeName",
        array_to_string(exploitation."pointPrelevementNameAliases", ' '),
        water_use.label,
        water_use.mnemonic,
        exploitation_declarant."socialReason",
        exploitation_declarant_user."firstName",
        exploitation_declarant_user."lastName"
      ), ' ') AS human_values,
      string_agg(concat_ws(
        ' ',
        exploitation.id::text,
        point.id::text,
        point."codeBSS",
        point."codeBNPE",
        point."codeAIOT",
        point."codePTP",
        exploitation_declarant.siret,
        exploitation_declarant_user.email
      ), ' ') AS identifier_values
    FROM candidate_exploitations allowed_exploitation
    JOIN "DeclarantPointPrelevement" exploitation
      ON exploitation.id = allowed_exploitation.exploitation_id
    JOIN "PointPrelevement" point ON point.id = exploitation."pointPrelevementId"
    JOIN "Declarant" exploitation_declarant
      ON exploitation_declarant."userId" = exploitation."declarantUserId"
    JOIN "User" exploitation_declarant_user
      ON exploitation_declarant_user.id = exploitation_declarant."userId"
    LEFT JOIN "SandreWaterUse" water_use ON water_use.id = exploitation."usageId"
    WHERE allowed_exploitation.declarant_id = declarant."userId"
  ) linked_exploitations ON true
`

const POINT_DOCUMENTS_SQL = Prisma.sql`
  SELECT
    point.id,
    ${normalizedDocumentSql(Prisma.sql`coalesce(nullif(point."usageName", ''), point.name, '')`)} AS primary_label,
    ${normalizedDocumentSql(Prisma.sql`concat_ws(
      ' ',
      point.name,
      point."usageName",
      point."otherNames",
      point."communeName",
      point."streamName",
      point."resourceName",
      point."aquiferName"
    )`)} AS human_document,
    ${normalizedDocumentSql(Prisma.sql`concat_ws(
      ' ',
      point.id::text,
      point."codeBSS",
      point."codeBNPE"
    )`)} AS identifier_document,
    ${compactDocumentSql(Prisma.sql`concat_ws(
      ' ',
      point.id::text,
      point."codeBSS",
      point."codeBNPE"
    )`)} AS compact_identifier_document
  FROM candidate_ids candidate
  JOIN "PointPrelevement" point ON point.id = candidate.id
`

const SCOPED_POINT_DOCUMENTS_SQL = Prisma.sql`
  SELECT
    point.id,
    ${normalizedDocumentSql(Prisma.sql`coalesce(nullif(point."usageName", ''), point.name, '')`)} AS primary_label,
    ${normalizedDocumentSql(Prisma.sql`concat_ws(
      ' ',
      point.name,
      point."usageName",
      point."otherNames",
      point."communeName",
      point."streamName",
      point."resourceName",
      point."aquiferName",
      scoped_exploitations.human_values
    )`)} AS human_document,
    ${normalizedDocumentSql(Prisma.sql`concat_ws(
      ' ',
      point.id::text,
      point."codeBSS",
      point."codeBNPE",
      scoped_exploitations.identifier_values
    )`)} AS identifier_document,
    ${compactDocumentSql(Prisma.sql`concat_ws(
      ' ',
      point.id::text,
      point."codeBSS",
      point."codeBNPE",
      scoped_exploitations.identifier_values
    )`)} AS compact_identifier_document
  FROM candidate_ids candidate
  JOIN "PointPrelevement" point ON point.id = candidate.id
  LEFT JOIN LATERAL (
    SELECT
      string_agg(concat_ws(
        ' ',
        declarant."socialReason",
        declarant_user."firstName",
        declarant_user."lastName",
        water_use.label,
        water_use.mnemonic,
        exploitation.status::text,
        array_to_string(exploitation."pointPrelevementNameAliases", ' '),
        collecteurs.human_values
      ), ' ') AS human_values,
      string_agg(concat_ws(
        ' ',
        declarant.siret,
        declarant_user.email,
        collecteurs.identifier_values
      ), ' ') AS identifier_values
    FROM candidate_exploitations allowed_exploitation
    JOIN "DeclarantPointPrelevement" exploitation
      ON exploitation.id = allowed_exploitation.exploitation_id
      AND exploitation."pointPrelevementId" = allowed_exploitation.point_id
    JOIN "Declarant" declarant ON declarant."userId" = exploitation."declarantUserId"
    JOIN "User" declarant_user ON declarant_user.id = declarant."userId"
    LEFT JOIN "SandreWaterUse" water_use ON water_use.id = exploitation."usageId"
    LEFT JOIN LATERAL (
      SELECT
        string_agg(concat_ws(
          ' ',
          collector."socialReason",
          collector_user."firstName",
          collector_user."lastName"
        ), ' ') AS human_values,
        string_agg(concat_ws(' ', collector.siret, collector_user.email), ' ') AS identifier_values
      FROM "DeclarantCollecteurExploitation" collector_link
      JOIN "Declarant" collector ON collector."userId" = collector_link."collecteurUserId"
      JOIN "User" collector_user ON collector_user.id = collector."userId"
      WHERE collector_link."exploitationId" = exploitation.id
    ) collecteurs ON true
    WHERE allowed_exploitation.point_id = point.id
  ) scoped_exploitations ON true
`

const POINT_SENSITIVE_IDENTIFIERS_SQL = Prisma.sql`concat_ws(
  ' ',
  point."sourceId",
  point."codeAIOT",
  point."codePTP",
  point."codeBDLISA",
  point."codeBDCarthage",
  point."codeBDTopage",
  point."codeSISPEA",
  point."codeINSEE",
  point."codeEUMasseDEau",
  point."codeMESO",
  point."codeMEContinentalesBV",
  point."codeSISEAUX",
  point."codeROE",
  point.identifiers::text
)`

function withSensitivePointIdentifiers(documentsSql) {
  return Prisma.sql`
    SELECT
      base.id,
      base.primary_label,
      base.human_document,
      concat_ws(
        ' ',
        base.identifier_document,
        ${normalizedDocumentSql(POINT_SENSITIVE_IDENTIFIERS_SQL)}
      ) AS identifier_document,
      concat(
        base.compact_identifier_document,
        ${compactDocumentSql(POINT_SENSITIVE_IDENTIFIERS_SQL)}
      ) AS compact_identifier_document
    FROM (${documentsSql}) base
    JOIN "PointPrelevement" point ON point.id = base.id
  `
}

const DETAILED_POINT_DOCUMENTS_SQL = withSensitivePointIdentifiers(
  POINT_DOCUMENTS_SQL
)
const DETAILED_SCOPED_POINT_DOCUMENTS_SQL = withSensitivePointIdentifiers(
  SCOPED_POINT_DOCUMENTS_SQL
)

const EXPLOITATION_DOCUMENTS_SQL = Prisma.sql`
  SELECT
    exploitation.id,
    ${normalizedDocumentSql(Prisma.sql`concat_ws(
      ' ',
      point.name,
      coalesce(
        nullif(declarant."socialReason", ''),
        concat_ws(' ', declarant_user."firstName", declarant_user."lastName")
      )
    )`)} AS primary_label,
    ${normalizedDocumentSql(Prisma.sql`concat_ws(
      ' ',
      point.name,
      point."usageName",
      point."communeName",
      declarant."socialReason",
      declarant_user."firstName",
      declarant_user."lastName",
      water_use.label,
      water_use.mnemonic,
      exploitation.status::text,
      exploitation.comment,
      collecteurs.human_values
    )`)} AS human_document,
    ${normalizedDocumentSql(Prisma.sql`concat_ws(
      ' ',
      exploitation.id::text,
      point.id::text,
      point."codeBSS",
      point."codeBNPE",
      point."codeAIOT",
      point."codePTP",
      declarant.siret,
      declarant_user.email,
      collecteurs.identifier_values
    )`)} AS identifier_document,
    ${compactDocumentSql(Prisma.sql`concat_ws(
      ' ',
      exploitation.id::text,
      point.id::text,
      point."codeBSS",
      point."codeBNPE",
      point."codeAIOT",
      point."codePTP",
      declarant.siret,
      declarant_user.email,
      collecteurs.identifier_values
    )`)} AS compact_identifier_document
  FROM candidate_ids candidate
  JOIN "DeclarantPointPrelevement" exploitation ON exploitation.id = candidate.id
  JOIN "PointPrelevement" point ON point.id = exploitation."pointPrelevementId"
  JOIN "Declarant" declarant ON declarant."userId" = exploitation."declarantUserId"
  JOIN "User" declarant_user ON declarant_user.id = declarant."userId"
  LEFT JOIN "SandreWaterUse" water_use ON water_use.id = exploitation."usageId"
  LEFT JOIN LATERAL (
    SELECT
      string_agg(concat_ws(
        ' ',
        collector."socialReason",
        collector_user."firstName",
        collector_user."lastName"
      ), ' ') AS human_values,
      string_agg(concat_ws(' ', collector.siret, collector_user.email), ' ') AS identifier_values
    FROM "DeclarantCollecteurExploitation" collector_link
    JOIN "Declarant" collector ON collector."userId" = collector_link."collecteurUserId"
    JOIN "User" collector_user ON collector_user.id = collector."userId"
    WHERE collector_link."exploitationId" = exploitation.id
  ) collecteurs ON true
`

export function rankDeclarantIds(candidateIds, query, options) {
  return rankDocuments(DECLARANT_DOCUMENTS_SQL, candidateIds, query, options)
}

export function rankScopedDeclarantIds(candidateScopes, query, options = {}) {
  const uniquePairs = new Map()

  for (const scope of candidateScopes ?? []) {
    for (const exploitationId of scope.exploitationIds ?? []) {
      uniquePairs.set(
        `${scope.declarantId}:${exploitationId}`,
        {declarantId: scope.declarantId, exploitationId}
      )
    }
  }

  const pairs = [...uniquePairs.values()]
  const candidateIds = [...new Set(
    (candidateScopes ?? []).map(scope => scope.declarantId).filter(Boolean)
  )]

  if (candidateIds.length === 0) {
    return []
  }

  if (pairs.length === 0) {
    return rankDocuments(DECLARANT_DOCUMENTS_SQL, candidateIds, query, options)
  }

  const additionalCandidateCtes = Prisma.sql`
    candidate_exploitations (declarant_id, exploitation_id) AS (
      VALUES ${Prisma.join(pairs.map(pair => Prisma.sql`(
        ${pair.declarantId}::uuid,
        ${pair.exploitationId}::uuid
      )`))}
    ),
  `

  return rankDocuments(
    COLLECTEUR_PRELEVEUR_DOCUMENTS_SQL,
    candidateIds,
    query,
    {...options, additionalCandidateCtes}
  )
}

export function rankCollecteurPreleveurIds(candidateScopes, query, options) {
  return rankScopedDeclarantIds(candidateScopes, query, options)
}

export function rankPointIds(candidateIds, query, options = {}) {
  const {includeSensitiveIdentifiers = false, ...rankOptions} = options
  const documentsSql = includeSensitiveIdentifiers
    ? DETAILED_POINT_DOCUMENTS_SQL
    : POINT_DOCUMENTS_SQL

  return rankDocuments(documentsSql, candidateIds, query, rankOptions)
}

export function rankScopedPointIds(candidateScopes, query, options = {}) {
  const {includeSensitiveIdentifiers = false, ...rankOptions} = options
  const uniquePairs = new Map()

  for (const scope of candidateScopes ?? []) {
    for (const exploitationId of scope.exploitationIds ?? []) {
      uniquePairs.set(
        `${scope.pointId}:${exploitationId}`,
        {pointId: scope.pointId, exploitationId}
      )
    }
  }

  const pairs = [...uniquePairs.values()]
  const candidateIds = [...new Set(
    (candidateScopes ?? []).map(scope => scope.pointId).filter(Boolean)
  )]

  if (candidateIds.length === 0) {
    return []
  }

  if (pairs.length === 0) {
    return rankPointIds(candidateIds, query, {
      ...rankOptions,
      includeSensitiveIdentifiers
    })
  }

  const additionalCandidateCtes = Prisma.sql`
    candidate_exploitations (point_id, exploitation_id) AS (
      VALUES ${Prisma.join(pairs.map(pair => Prisma.sql`(
        ${pair.pointId}::uuid,
        ${pair.exploitationId}::uuid
      )`))}
    ),
  `

  return rankDocuments(
    includeSensitiveIdentifiers
      ? DETAILED_SCOPED_POINT_DOCUMENTS_SQL
      : SCOPED_POINT_DOCUMENTS_SQL,
    candidateIds,
    query,
    {...rankOptions, additionalCandidateCtes}
  )
}

export function rankExploitationIds(candidateIds, query, options) {
  return rankDocuments(EXPLOITATION_DOCUMENTS_SQL, candidateIds, query, options)
}
