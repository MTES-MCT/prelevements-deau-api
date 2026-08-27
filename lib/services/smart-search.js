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

const MIN_APPROXIMATE_TERM_LENGTH = 4
const APPROXIMATE_SCORE = 30

function normalizeText(value) {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('fr-FR')
    .replaceAll('œ', 'oe')
    .replaceAll('æ', 'ae')
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036F]/g, '')
    .replaceAll(/[^a-z\d]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

function compactText(value) {
  return normalizeText(value).replaceAll(' ', '')
}

function looksLikeTechnicalToken(value) {
  const rawValue = String(value ?? '')
  const compactValue = compactText(rawValue)

  return /[\d_@/:]/.test(rawValue)
    || /^(?:aiot|bdlisa|bnpe|bss|ptp|siret|uuid)/.test(compactValue)
    || /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(rawValue)
}

function getTechnicalTerms(value) {
  return new Set(
    String(value ?? '')
      .trim()
      .split(/\s+/)
      .filter(looksLikeTechnicalToken)
      .flatMap(token => normalizeText(token).split(' ').filter(Boolean))
  )
}

function canApproximateTerm(term, technicalTerms) {
  return /^[a-z]+$/.test(term)
    && term.length >= MIN_APPROXIMATE_TERM_LENGTH
    && !IDENTIFIER_WORDS.has(term)
    && !technicalTerms.has(term)
}

export function getAdjacentTranspositions(term) {
  const characters = [...term]
  const variants = new Set()

  for (let index = 0; index < characters.length - 1; index++) {
    if (characters[index] === characters[index + 1]) {
      continue
    }

    const transposed = [...characters]
    const leftCharacter = transposed[index]
    transposed[index] = transposed[index + 1]
    transposed[index + 1] = leftCharacter
    variants.add(transposed.join(''))
  }

  return [...variants]
}

export function parseSmartSearch(value) {
  const normalized = normalizeText(value).slice(0, 200)
  const technicalTerms = getTechnicalTerms(value)
  const terms = [...new Set(normalized.split(' ').filter(Boolean))]
    .slice(0, 12)
    .map(term => ({
      value: term,
      compact: compactText(term),
      approximate: canApproximateTerm(term, technicalTerms)
    }))

  return {
    normalized,
    compact: compactText(value).slice(0, 200),
    terms
  }
}

function isWithinOneEdit(left, right) {
  if (Math.abs(left.length - right.length) > 1) {
    return false
  }

  if (left === right) {
    return true
  }

  if (left.length === right.length) {
    let differences = 0
    let index = 0

    for (const character of left) {
      if (character !== right[index] && ++differences > 1) {
        return false
      }

      index += 1
    }

    return true
  }

  const [shorter, longer] = left.length < right.length
    ? [left, right]
    : [right, left]
  let shorterIndex = 0
  let longerIndex = 0
  let differences = 0

  while (shorterIndex < shorter.length && longerIndex < longer.length) {
    if (shorter[shorterIndex] === longer[longerIndex]) {
      shorterIndex += 1
      longerIndex += 1
      continue
    }

    differences += 1
    longerIndex += 1

    if (differences > 1) {
      return false
    }
  }

  return true
}

function approximateTermMatches(term, humanTokens) {
  if (!term.approximate) {
    return false
  }

  return humanTokens.some(token => (
    token.length >= term.value.length - 1
    && token.length <= term.value.length + 1
    && (
      isWithinOneEdit(term.value, token)
      || term.adjacentTranspositions.has(token)
    )
  ))
}

function getInMemorySearchDocument(document) {
  const identifierText = document.identifierText ?? ''
  const primaryLabel = normalizeText(document.primaryLabel)
  const humanDocument = normalizeText(document.humanText)
  const identifierDocument = normalizeText(identifierText)

  return {
    id: document.id,
    primaryLabel,
    humanDocument,
    humanTokens: humanDocument.split(' ').filter(Boolean),
    identifierDocument,
    compactIdentifierDocument: document.compactIdentifierText === undefined
      ? compactText(identifierText)
      : compactText(document.compactIdentifierText)
  }
}

function prepareInMemoryTerm(term) {
  return {
    ...term,
    adjacentTranspositions: term.approximate
      ? new Set(getAdjacentTranspositions(term.value))
      : null
  }
}

function inMemoryTermMatches(document, term) {
  return document.humanDocument.includes(term.value)
    || document.identifierDocument.includes(term.value)
    || document.compactIdentifierDocument.includes(term.compact)
    || approximateTermMatches(term, document.humanTokens)
}

function inMemoryTermScore(document, term) {
  return Math.max(
    document.primaryLabel === term.value ? 160 : 0,
    document.primaryLabel.startsWith(term.value) ? 120 : 0,
    document.humanDocument.includes(term.value) ? 80 : 0,
    document.identifierDocument.includes(term.value) ? 110 : 0,
    document.compactIdentifierDocument.includes(term.compact) ? 130 : 0,
    term.approximate ? APPROXIMATE_SCORE : 0
  )
}

function compareNormalizedText(left, right) {
  if (left === right) {
    return 0
  }

  return left < right
    ? -1
    : 1
}

export function rankSearchDocuments(documents, query) {
  const parsedSearch = parseSmartSearch(query)

  if (parsedSearch.terms.length === 0) {
    return []
  }

  const search = {
    ...parsedSearch,
    terms: parsedSearch.terms.map(prepareInMemoryTerm)
  }

  return documents
    .map(getInMemorySearchDocument)
    .filter(document => search.terms.every(term => inMemoryTermMatches(document, term)))
    .map(document => ({
      id: document.id,
      relevance: (document.primaryLabel === search.normalized ? 1000 : 0)
        + (document.primaryLabel.startsWith(search.normalized) ? 700 : 0)
        + (document.humanDocument.includes(search.normalized) ? 450 : 0)
        + (search.compact && document.compactIdentifierDocument.includes(search.compact)
          ? 800
          : 0)
        + search.terms.reduce(
          (total, term) => total + inMemoryTermScore(document, term),
          0
        ),
      primaryLabel: document.primaryLabel
    }))
    .sort((left, right) => right.relevance - left.relevance
      || compareNormalizedText(left.primaryLabel, right.primaryLabel)
      || compareNormalizedText(String(left.id), String(right.id)))
    .map(({id, relevance}) => ({id, relevance}))
}

function normalizedDocumentSql(value) {
  return Prisma.sql`regexp_replace(lower(public.unaccent(${value})), '[^a-z0-9]+', ' ', 'g')`
}

function compactDocumentSql(value) {
  return Prisma.sql`regexp_replace(lower(public.unaccent(${value})), '[^a-z0-9]+', '', 'g')`
}

function approximateTermMatchSql(term) {
  if (!term.approximate) {
    return Prisma.sql`FALSE`
  }

  const minimumLength = term.value.length - 1
  const maximumLength = term.value.length + 1
  const transpositions = getAdjacentTranspositions(term.value)
  const transpositionMatch = transpositions.length === 0
    ? Prisma.empty
    : Prisma.sql`
      OR human_token.value = ANY(${transpositions}::text[])
    `

  return Prisma.sql`EXISTS (
    SELECT 1
    FROM string_to_table(btrim(document.human_document), ' ') AS human_token(value)
    WHERE (
      CASE
        WHEN char_length(human_token.value) BETWEEN ${minimumLength} AND ${maximumLength}
          THEN public.levenshtein_less_equal(${term.value}, human_token.value, 1) <= 1
        ELSE FALSE
      END
      ${transpositionMatch}
    )
  )`
}

function termMatchesSql(term) {
  const contains = `%${term.value}%`
  const compactContains = `%${term.compact}%`
  const approximate = term.approximate
    ? Prisma.sql`OR ${approximateTermMatchSql(term)}`
    : Prisma.empty

  return Prisma.sql`(
    document.human_document LIKE ${contains}
    OR document.identifier_document LIKE ${contains}
    OR document.compact_identifier_document LIKE ${compactContains}
    ${approximate}
  )`
}

function termScoreSql(term) {
  const contains = `%${term.value}%`
  const prefix = `${term.value}%`
  const compactContains = `%${term.compact}%`
  // Le prédicat de ligne a déjà validé chaque terme. Un score constant évite
  // de rescanner les mots pour le classement et reste sous tous les scores exacts.
  const approximateScore = term.approximate
    ? Prisma.sql`${APPROXIMATE_SCORE}`
    : Prisma.sql`0`

  return Prisma.sql`GREATEST(
    CASE WHEN document.primary_label = ${term.value} THEN 160 ELSE 0 END,
    CASE WHEN document.primary_label LIKE ${prefix} THEN 120 ELSE 0 END,
    CASE WHEN document.human_document LIKE ${contains} THEN 80 ELSE 0 END,
    CASE WHEN document.identifier_document LIKE ${contains} THEN 110 ELSE 0 END,
    CASE WHEN document.compact_identifier_document LIKE ${compactContains} THEN 130 ELSE 0 END,
    ${approximateScore}
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
    document AS MATERIALIZED (
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

function declarantPrimaryContactEmailSql(declarantUserIdSql, loginEmailSql) {
  return Prisma.sql`coalesce(
  (
    SELECT contact.email::text
    FROM "DeclarantContactEmail" contact
    WHERE contact."declarantUserId" = ${declarantUserIdSql}
    ORDER BY contact."isPrimary" DESC, contact.email
    LIMIT 1
  ),
  CASE
    WHEN lower(${loginEmailSql}::text) NOT LIKE '%@import.local'
      THEN ${loginEmailSql}::text
    ELSE NULL
  END,
  ''
)`
}

function declarantContactEmailValuesSql(declarantUserIdSql, loginEmailSql) {
  return Prisma.sql`coalesce(
  (
    SELECT string_agg(contact.email::text, ' ' ORDER BY contact."isPrimary" DESC, contact.email)
    FROM "DeclarantContactEmail" contact
    WHERE contact."declarantUserId" = ${declarantUserIdSql}
  ),
  CASE
    WHEN lower(${loginEmailSql}::text) NOT LIKE '%@import.local'
      THEN ${loginEmailSql}::text
    ELSE NULL
  END,
  ''
)`
}

const DECLARANT_PRIMARY_CONTACT_EMAIL_SQL = declarantPrimaryContactEmailSql(
  Prisma.sql`declarant."userId"`,
  Prisma.sql`user_account.email`
)
const DECLARANT_CONTACT_EMAIL_VALUES_SQL = declarantContactEmailValuesSql(
  Prisma.sql`declarant."userId"`,
  Prisma.sql`user_account.email`
)

const DECLARANT_DOCUMENTS_SQL = Prisma.sql`
  SELECT
    user_account.id,
    ${normalizedDocumentSql(Prisma.sql`coalesce(
      nullif(declarant."socialReason", ''),
      nullif(concat_ws(' ', user_account."firstName", user_account."lastName"), ''),
      ${DECLARANT_PRIMARY_CONTACT_EMAIL_SQL},
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
      ${DECLARANT_CONTACT_EMAIL_VALUES_SQL},
      declarant.siret,
      declarant."phoneNumber",
      declarant."sourceId"
    )`)} AS identifier_document,
    ${compactDocumentSql(Prisma.sql`concat_ws(
      ' ',
      user_account.id::text,
      ${DECLARANT_CONTACT_EMAIL_VALUES_SQL},
      declarant.siret,
      declarant."phoneNumber",
      declarant."sourceId"
    )`)} AS compact_identifier_document
  FROM candidate_ids candidate
  JOIN "User" user_account ON user_account.id = candidate.id
  JOIN "Declarant" declarant ON declarant."userId" = user_account.id
`

const EXPLOITATION_USAGE_SUMMARIES_CTE_SQL = Prisma.sql`
  exploitation_usage_values AS MATERIALIZED (
    SELECT
      candidate_exploitation.exploitation_id,
      water_use.id,
      water_use.code,
      water_use.label,
      water_use.mnemonic
    FROM candidate_exploitation_ids candidate_exploitation
    JOIN "DeclarantPointPrelevement" exploitation
      ON exploitation.id = candidate_exploitation.exploitation_id
    JOIN "SandreWaterUse" water_use
      ON water_use.id = exploitation."usageId"

    UNION

    SELECT
      candidate_exploitation.exploitation_id,
      water_use.id,
      water_use.code,
      water_use.label,
      water_use.mnemonic
    FROM candidate_exploitation_ids candidate_exploitation
    JOIN "DeclarantPointPrelevementSecondaryUsage" secondary_usage
      ON secondary_usage."exploitationId" = candidate_exploitation.exploitation_id
    JOIN "SandreWaterUse" water_use
      ON water_use.id = secondary_usage."usageId"
  ),
  exploitation_usage_summaries AS MATERIALIZED (
    SELECT
      exploitation_usage.exploitation_id,
      string_agg(
        DISTINCT exploitation_usage.label,
        ' '
        ORDER BY exploitation_usage.label
      ) AS label,
      string_agg(
        DISTINCT concat_ws(
          ' ',
          exploitation_usage.code,
          exploitation_usage.mnemonic
        ),
        ' '
        ORDER BY concat_ws(
          ' ',
          exploitation_usage.code,
          exploitation_usage.mnemonic
        )
      ) AS mnemonic
    FROM exploitation_usage_values exploitation_usage
    GROUP BY exploitation_usage.exploitation_id
  ),
`

const COLLECTEUR_PRELEVEUR_EXPLOITATIONS_CTE_SQL = Prisma.sql`
  candidate_exploitation_ids (exploitation_id) AS MATERIALIZED (
    SELECT DISTINCT candidate_exploitation.exploitation_id
    FROM candidate_exploitations candidate_exploitation
  ),
  ${EXPLOITATION_USAGE_SUMMARIES_CTE_SQL}
  linked_exploitations AS MATERIALIZED (
    SELECT
      allowed_exploitation.declarant_id,
      string_agg(concat_ws(
        ' ',
        point.name,
        point."usageName",
        point."communeName",
        array_to_string(exploitation."pointPrelevementNameAliases", ' '),
        water_use.label,
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
        water_use.mnemonic,
        exploitation_declarant.siret,
        ${declarantContactEmailValuesSql(
          Prisma.sql`exploitation_declarant."userId"`,
          Prisma.sql`exploitation_declarant_user.email`
        )}
      ), ' ') AS identifier_values
    FROM candidate_exploitations allowed_exploitation
    JOIN "DeclarantPointPrelevement" exploitation
      ON exploitation.id = allowed_exploitation.exploitation_id
    JOIN "PointPrelevement" point ON point.id = exploitation."pointPrelevementId"
    JOIN "Declarant" exploitation_declarant
      ON exploitation_declarant."userId" = exploitation."declarantUserId"
    JOIN "User" exploitation_declarant_user
      ON exploitation_declarant_user.id = exploitation_declarant."userId"
    LEFT JOIN exploitation_usage_summaries water_use
      ON water_use.exploitation_id = exploitation.id
    GROUP BY allowed_exploitation.declarant_id
  ),
`

const COLLECTEUR_PRELEVEUR_DOCUMENTS_SQL = Prisma.sql`
  SELECT
    user_account.id,
    ${normalizedDocumentSql(Prisma.sql`coalesce(
      nullif(declarant."socialReason", ''),
      nullif(concat_ws(' ', user_account."firstName", user_account."lastName"), ''),
      ${DECLARANT_PRIMARY_CONTACT_EMAIL_SQL},
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
      ${DECLARANT_CONTACT_EMAIL_VALUES_SQL},
      declarant.siret,
      declarant."phoneNumber",
      declarant."sourceId",
      linked_exploitations.identifier_values
    )`)} AS identifier_document,
    ${compactDocumentSql(Prisma.sql`concat_ws(
      ' ',
      user_account.id::text,
      ${DECLARANT_CONTACT_EMAIL_VALUES_SQL},
      declarant.siret,
      declarant."phoneNumber",
      declarant."sourceId",
      linked_exploitations.identifier_values
    )`)} AS compact_identifier_document
  FROM candidate_ids candidate
  JOIN "User" user_account ON user_account.id = candidate.id
  JOIN "Declarant" declarant ON declarant."userId" = user_account.id
  LEFT JOIN linked_exploitations
    ON linked_exploitations.declarant_id = declarant."userId"
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
        exploitation.status::text,
        array_to_string(exploitation."pointPrelevementNameAliases", ' '),
        collecteurs.human_values
      ), ' ') AS human_values,
      string_agg(concat_ws(
        ' ',
        water_use.mnemonic,
        declarant.siret,
        ${declarantContactEmailValuesSql(
          Prisma.sql`declarant."userId"`,
          Prisma.sql`declarant_user.email`
        )},
        collecteurs.identifier_values
      ), ' ') AS identifier_values
    FROM candidate_exploitations allowed_exploitation
    JOIN "DeclarantPointPrelevement" exploitation
      ON exploitation.id = allowed_exploitation.exploitation_id
      AND exploitation."pointPrelevementId" = allowed_exploitation.point_id
    JOIN "Declarant" declarant ON declarant."userId" = exploitation."declarantUserId"
    JOIN "User" declarant_user ON declarant_user.id = declarant."userId"
    LEFT JOIN exploitation_usage_summaries water_use
      ON water_use.exploitation_id = exploitation.id
    LEFT JOIN LATERAL (
      SELECT
        string_agg(concat_ws(
          ' ',
          collector."socialReason",
          collector_user."firstName",
          collector_user."lastName"
        ), ' ') AS human_values,
        string_agg(concat_ws(
          ' ',
          collector.siret,
          ${declarantContactEmailValuesSql(
            Prisma.sql`collector."userId"`,
            Prisma.sql`collector_user.email`
          )}
        ), ' ') AS identifier_values
      FROM "DeclarantCollecteurExploitation" collector_link
      JOIN "Declarant" collector ON collector."userId" = collector_link."collecteurUserId"
      JOIN "User" collector_user ON collector_user.id = collector."userId"
      WHERE collector_link."exploitationId" = exploitation.id
        AND collector_user."deletedAt" IS NULL
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
      water_use.mnemonic,
      declarant.siret,
      ${declarantContactEmailValuesSql(
        Prisma.sql`declarant."userId"`,
        Prisma.sql`declarant_user.email`
      )},
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
      water_use.mnemonic,
      declarant.siret,
      ${declarantContactEmailValuesSql(
        Prisma.sql`declarant."userId"`,
        Prisma.sql`declarant_user.email`
      )},
      collecteurs.identifier_values
    )`)} AS compact_identifier_document
  FROM candidate_ids candidate
  JOIN "DeclarantPointPrelevement" exploitation ON exploitation.id = candidate.id
  JOIN "PointPrelevement" point ON point.id = exploitation."pointPrelevementId"
  JOIN "Declarant" declarant ON declarant."userId" = exploitation."declarantUserId"
  JOIN "User" declarant_user ON declarant_user.id = declarant."userId"
  LEFT JOIN exploitation_usage_summaries water_use
    ON water_use.exploitation_id = exploitation.id
  LEFT JOIN LATERAL (
    SELECT
      string_agg(concat_ws(
        ' ',
        collector."socialReason",
        collector_user."firstName",
        collector_user."lastName"
      ), ' ') AS human_values,
      string_agg(concat_ws(
        ' ',
        collector.siret,
        ${declarantContactEmailValuesSql(
          Prisma.sql`collector."userId"`,
          Prisma.sql`collector_user.email`
        )}
      ), ' ') AS identifier_values
    FROM "DeclarantCollecteurExploitation" collector_link
    JOIN "Declarant" collector ON collector."userId" = collector_link."collecteurUserId"
    JOIN "User" collector_user ON collector_user.id = collector."userId"
    WHERE collector_link."exploitationId" = exploitation.id
      AND collector_user."deletedAt" IS NULL
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

  const declarantIds = pairs.map(pair => pair.declarantId)
  const exploitationIds = pairs.map(pair => pair.exploitationId)
  const additionalCandidateCtes = Prisma.sql`
    candidate_exploitations (declarant_id, exploitation_id) AS MATERIALIZED (
      SELECT paired.declarant_id, paired.exploitation_id
      FROM unnest(
        ${declarantIds}::uuid[],
        ${exploitationIds}::uuid[]
      ) AS paired(declarant_id, exploitation_id)
    ),
    ${COLLECTEUR_PRELEVEUR_EXPLOITATIONS_CTE_SQL}
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
    candidate_exploitation_ids (exploitation_id) AS MATERIALIZED (
      SELECT DISTINCT candidate_exploitation.exploitation_id
      FROM candidate_exploitations candidate_exploitation
    ),
    ${EXPLOITATION_USAGE_SUMMARIES_CTE_SQL}
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

export function rankExploitationIds(candidateIds, query, options = {}) {
  const {additionalCandidateCtes = Prisma.empty, ...rankOptions} = options
  const exploitationUsageCtes = Prisma.sql`
    candidate_exploitation_ids (exploitation_id) AS MATERIALIZED (
      SELECT candidate.id
      FROM candidate_ids candidate
    ),
    ${EXPLOITATION_USAGE_SUMMARIES_CTE_SQL}
    ${additionalCandidateCtes}
  `

  return rankDocuments(EXPLOITATION_DOCUMENTS_SQL, candidateIds, query, {
    ...rankOptions,
    additionalCandidateCtes: exploitationUsageCtes
  })
}
