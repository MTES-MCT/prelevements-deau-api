import createHttpError from 'http-errors'
import {Prisma} from '@prisma/client'
import {prisma} from '../../db/prisma.js'
import {randomUUID} from 'node:crypto'
import {
  getEffectiveDeclarantZoneLinks,
  getPermissionZoneIdsForUser
} from '../services/zone-permissions.js'
import {normalizePreleveurType} from '../services/preleveur-types.js'
import {
  getRootWaterUseCode,
  getWaterUse
} from '../constants/sandre-water-uses.js'
import {
  rankCollecteurPreleveurIds,
  rankDeclarantIds,
  rankSearchDocuments
} from '../services/smart-search.js'

function userWhere(includeDeleted) {
  return includeDeleted ? {} : {deletedAt: null}
}

function removeUndefinedValues(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined)
  )
}

function normalizeCivility(value) {
  if (value === undefined) {
    return undefined
  }

  if (value === null || value === '') {
    return null
  }

  return {
    'M.': 'MR',
    Mme: 'MRS',
    MR: 'MR',
    MRS: 'MRS'
  }[value] ?? value
}

function normalizeEmail(email) {
  if (email === undefined) {
    return undefined
  }

  if (email === null || email === '') {
    return null
  }

  return typeof email === 'string' ? email.toLowerCase().trim() : email
}

function splitDeclarantPayload(payload) {
  return {
    userData: removeUndefinedValues({
      email: normalizeEmail(payload.email),
      firstName: payload.firstName,
      lastName: payload.lastName
    }),
    declarantData: removeUndefinedValues({
      declarantType: payload.declarantType,
      declarantRole: payload.declarantRole,
      preleveurType: payload.preleveurType,
      quickDeclarationEnabled: payload.quickDeclarationEnabled,
      declarationNotificationsEnabled: payload.declarationNotificationsEnabled,
      jobTitle: payload.jobTitle,
      socialReason: payload.socialReason,
      civility: normalizeCivility(payload.civility),
      addressLine1: payload.addressLine1,
      addressLine2: payload.addressLine2,
      poBox: payload.poBox,
      postalCode: payload.postalCode,
      city: payload.city,
      siret: payload.siret,
      phoneNumber: payload.phoneNumber,
      sourceId: payload.sourceId
    })
  }
}

function stripReadonlyDeclarantFields(changes) {
  const data = {...changes}

  for (const key of [
    'id',
    'userId',
    'role',
    'createdAt',
    'updatedAt',
    'deletedAt',
    'lastLoginAt',
    'lastDeclarationAt',
    'user',
    'declarant',
    'pointPrelevements',
    'collecteurExploitations',
    'declarations',
    'declarationsCreated',
    'declarationTypes',
    'serviceAccountDeclarants',
    'serviceAccountTokens',
    'apiImports',
    'right',
    '_count'
  ]) {
    delete data[key]
  }

  return data
}

function normalizeDeclarant(declarant) {
  if (!declarant) {
    return null
  }

  return {
    ...declarant,
    id: declarant.userId,
    email: declarant.user?.email ?? null,
    firstName: declarant.user?.firstName ?? null,
    lastName: declarant.user?.lastName ?? null
  }
}

function getExploitationInclude() {
  return {
    connectors: {
      orderBy: {createdAt: 'asc'}
    },
    collecteurs: {
      include: {
        collecteur: {
          include: {
            user: true
          }
        }
      },
      orderBy: {createdAt: 'asc'}
    },
    documents: {
      where: {deletedAt: null},
      orderBy: {createdAt: 'desc'}
    },
    usage: true,
    pointPrelevement: {
      include: {
        zones: {
          include: {
            zone: true
          }
        }
      }
    },
    declarant: {
      include: {
        user: true
      }
    }
  }
}

function getOverviewExploitationInclude() {
  return {
    collecteurs: {
      include: {
        collecteur: {
          include: {user: true}
        }
      },
      orderBy: {createdAt: 'asc'}
    },
    usage: true,
    pointPrelevement: {
      select: {
        id: true,
        name: true
      }
    },
    declarant: {
      include: {user: true}
    }
  }
}

function getExploitationZoneWhere(exploitationZoneIds) {
  if (!Array.isArray(exploitationZoneIds)) {
    return null
  }

  return {
    pointPrelevement: {
      zones: {
        some: {
          zoneId: {in: [...new Set(exploitationZoneIds)]}
        }
      }
    }
  }
}

function getDeclarantListInclude({exploitationZoneIds} = {}) {
  const filterExploitationCounts = Array.isArray(exploitationZoneIds)
  const pointZoneWhere = {
    zones: {
      some: {
        zoneId: {in: exploitationZoneIds ?? []}
      }
    }
  }

  return {
    declarant: {
      include: {
        _count: {
          select: {
            pointPrelevements: filterExploitationCounts
              ? {where: {pointPrelevement: pointZoneWhere}}
              : true,
            collecteurExploitations: filterExploitationCounts
              ? {
                where: {
                  exploitation: {
                    pointPrelevement: pointZoneWhere
                  }
                }
              }
              : true
          }
        },
        user: true
      }
    }
  }
}

function getDeclarantCompactListSelect({exploitationZoneIds} = {}) {
  const filterExploitationCounts = Array.isArray(exploitationZoneIds)
  const pointZoneWhere = {
    zones: {
      some: {
        zoneId: {in: exploitationZoneIds ?? []}
      }
    }
  }

  return {
    id: true,
    email: true,
    firstName: true,
    lastName: true,
    declarant: {
      select: {
        civility: true,
        declarantRole: true,
        declarantType: true,
        preleveurType: true,
        socialReason: true,
        city: true,
        lastDeclarationAt: true,
        _count: {
          select: {
            pointPrelevements: filterExploitationCounts
              ? {where: {pointPrelevement: pointZoneWhere}}
              : true,
            collecteurExploitations: filterExploitationCounts
              ? {
                where: {
                  exploitation: {
                    pointPrelevement: pointZoneWhere
                  }
                }
              }
              : true
          }
        }
      }
    }
  }
}

function getDeclarantsBaseWhere({
  accessibleDeclarantUserIds,
  includeDeleted = false
} = {}) {
  return {
    role: 'DECLARANT',
    ...userWhere(includeDeleted),
    ...(Array.isArray(accessibleDeclarantUserIds)
      ? {id: {in: accessibleDeclarantUserIds}}
      : {})
  }
}

async function getInstructorDeclarantListScope(instructorId, {
  client = prisma,
  now = new Date()
} = {}) {
  const user = {id: instructorId, role: 'INSTRUCTOR'}
  const [declarantZoneIds, exploitationZoneIds] = await Promise.all([
    getPermissionZoneIdsForUser(user, 'declarant.list', {client, now}),
    getPermissionZoneIdsForUser(user, 'exploitation.list', {client, now})
  ])
  const effectiveLinks = await getEffectiveDeclarantZoneLinks({
    client,
    zoneIds: declarantZoneIds
  })

  return {
    declarantUserIds: [...new Set(effectiveLinks.map(link => link.declarantUserId))],
    declarantZoneIds,
    exploitationZoneIds
  }
}

const DAY_IN_MS = 24 * 60 * 60 * 1000
const SEARCH_FACET_LABELS = Object.freeze({
  PRELEVEUR: 'Préleveur',
  COLLECTEUR: 'Collecteur',
  NATURAL_PERSON: 'Personne physique',
  LEGAL_PERSON: 'Personne morale',
  ICPE: 'ICPE',
  IRRIGANT: 'Irrigant',
  GESTIONNAIRE_AEP: 'Gestionnaire AEP',
  AUTRE: 'Autre',
  WITH_EMAIL: 'Avec email',
  WITHOUT_EMAIL: 'Sans email',
  WITH_COLLECTEUR: 'Avec collecteur',
  WITHOUT_COLLECTEUR: 'Sans collecteur',
  WITH_CONNECTOR: 'Avec connecteur',
  WITHOUT_CONNECTOR: 'Sans connecteur',
  NEVER: 'Aucune déclaration',
  LT_30_DAYS: 'Moins de 30 jours',
  DAYS_30_90: 'De 30 à 90 jours',
  DAYS_91_365: 'De 91 jours à un an',
  GT_365_DAYS: 'Plus d’un an',
  SUPERFICIELLE: 'Eau superficielle',
  SOUTERRAIN: 'Eau souterraine',
  TRANSITION: 'Eau de transition',
  EN_ACTIVITE: 'En activité',
  NON_RENSEIGNE: 'Non renseignée',
  ABANDONNEE: 'Abandonnée',
  TERMINEE: 'Terminée'
})

function getDeclarantSearchSelect({includeSearchDocuments = false} = {}) {
  return {
    id: true,
    email: true,
    firstName: true,
    lastName: true,
    declarant: {
      select: {
        declarantRole: true,
        declarantType: true,
        preleveurType: true,
        socialReason: true,
        lastDeclarationAt: true,
        ...(includeSearchDocuments
          ? {
            city: true,
            jobTitle: true,
            siret: true,
            phoneNumber: true,
            sourceId: true
          }
          : {})
      }
    }
  }
}

const COLLECTEUR_PRELEVEUR_SEARCH_EXPLOITATION_SELECT = Object.freeze({
  id: true,
  status: true,
  usage: {
    select: {
      code: true,
      label: true
    }
  },
  pointPrelevement: {
    select: {
      waterBodyType: true,
      zones: {
        select: {
          zone: {
            select: {
              id: true,
              code: true,
              name: true,
              type: true
            }
          }
        }
      }
    }
  },
  collecteurs: {
    where: {
      collecteur: {
        user: {deletedAt: null}
      }
    },
    select: {id: true}
  },
  connectors: {
    select: {id: true}
  },
  declarant: {
    select: {
      userId: true,
      civility: true,
      declarantRole: true,
      declarantType: true,
      preleveurType: true,
      socialReason: true,
      city: true,
      lastDeclarationAt: true,
      user: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true
        }
      }
    }
  }
})

function getSearchExploitationZonePredicate(exploitationZoneIds) {
  if (!Array.isArray(exploitationZoneIds)) {
    return Prisma.empty
  }

  return Prisma.sql`AND EXISTS (
    SELECT 1
    FROM "PointPrelevementZone" point_zone
    WHERE point_zone."pointPrelevementId" = exploitation."pointPrelevementId"
      AND point_zone."zoneId" = ANY(${exploitationZoneIds}::uuid[])
  )`
}

export async function getDeclarantSearchExploitations(
  declarantUserIds,
  exploitationZoneIds,
  {client = prisma, includeSearchDocuments = false} = {}
) {
  const candidateIds = uniqueValues(declarantUserIds ?? [])
  const scopedZoneIds = uniqueValues(exploitationZoneIds ?? [])

  if (candidateIds.length === 0
    || (Array.isArray(exploitationZoneIds) && scopedZoneIds.length === 0)) {
    return []
  }

  const zonePredicate = getSearchExploitationZonePredicate(
    Array.isArray(exploitationZoneIds) ? scopedZoneIds : undefined
  )
  const exploitationSearchColumns = includeSearchDocuments
    ? Prisma.sql`,
      concat_ws(
        ' ',
        point.name,
        point."usageName",
        point."communeName",
        array_to_string(exploitation."pointPrelevementNameAliases", ' '),
        water_use.label,
        exploitation_declarant."socialReason",
        exploitation_declarant_user."firstName",
        exploitation_declarant_user."lastName"
      ) AS human_search_text,
      concat_ws(
        ' ',
        exploitation.id::text,
        point.id::text,
        point."codeBSS",
        point."codeBNPE",
        point."codeAIOT",
        point."codePTP",
        water_use.mnemonic,
        exploitation_declarant.siret,
        exploitation_declarant_user.email
      ) AS identifier_search_text
    `
    : Prisma.empty
  const exploitationSearchJoins = includeSearchDocuments
    ? Prisma.sql`
      JOIN "Declarant" exploitation_declarant
        ON exploitation_declarant."userId" = exploitation."declarantUserId"
      JOIN "User" exploitation_declarant_user
        ON exploitation_declarant_user.id = exploitation_declarant."userId"
    `
    : Prisma.empty
  const declarantSummarySearchColumns = includeSearchDocuments
    ? Prisma.sql`,
      string_agg(
        exploitation_summary.human_search_text,
        ' '
        ORDER BY exploitation_summary.id
      ) AS "humanSearchText",
      string_agg(
        exploitation_summary.identifier_search_text,
        ' '
        ORDER BY exploitation_summary.id
      ) AS "identifierSearchText"
    `
    : Prisma.empty
  const resultSearchColumns = includeSearchDocuments
    ? Prisma.sql`,
      declarant_summary."humanSearchText",
      declarant_summary."identifierSearchText"
    `
    : Prisma.empty

  return client.$queryRaw(Prisma.sql`
    WITH candidate_ids (id) AS MATERIALIZED (
      SELECT unnest(${candidateIds}::uuid[])
    ),
    candidate_exploitations (declarant_id, exploitation_id) AS MATERIALIZED (
      SELECT candidate.id, exploitation.id
      FROM candidate_ids candidate
      JOIN "DeclarantPointPrelevement" exploitation
        ON exploitation."declarantUserId" = candidate.id

      UNION

      SELECT candidate.id, collector_link."exploitationId"
      FROM candidate_ids candidate
      JOIN "DeclarantCollecteurExploitation" collector_link
        ON collector_link."collecteurUserId" = candidate.id
    ),
    unique_exploitation_ids (exploitation_id) AS MATERIALIZED (
      SELECT DISTINCT candidate_exploitation.exploitation_id
      FROM candidate_exploitations candidate_exploitation
    ),
    scoped_exploitation_ids (exploitation_id) AS MATERIALIZED (
      SELECT unique_exploitation.exploitation_id
      FROM unique_exploitation_ids unique_exploitation
      JOIN "DeclarantPointPrelevement" exploitation
        ON exploitation.id = unique_exploitation.exploitation_id
      WHERE true
        ${zonePredicate}
    ),
    active_collector_links AS MATERIALIZED (
      SELECT DISTINCT active_collector_link."exploitationId" AS exploitation_id
      FROM scoped_exploitation_ids scoped_exploitation
      JOIN "DeclarantCollecteurExploitation" active_collector_link
        ON active_collector_link."exploitationId" = scoped_exploitation.exploitation_id
      JOIN "User" active_collector_user
        ON active_collector_user.id = active_collector_link."collecteurUserId"
        AND active_collector_user."deletedAt" IS NULL
    ),
    connected_exploitations AS MATERIALIZED (
      SELECT DISTINCT connector."declarantPointPrelevementId" AS exploitation_id
      FROM scoped_exploitation_ids scoped_exploitation
      JOIN "DeclarantPointPrelevementConnector" connector
        ON connector."declarantPointPrelevementId" = scoped_exploitation.exploitation_id
    ),
    exploitation_summaries AS MATERIALIZED (
      SELECT
        exploitation.id,
        exploitation.status,
        water_use.code AS "usageCode",
        water_use.label AS "usageLabel",
        point."waterBodyType",
        active_collector.exploitation_id IS NOT NULL AS "hasCollecteur",
        connected_exploitation.exploitation_id IS NOT NULL AS "hasConnector"
        ${exploitationSearchColumns}
      FROM scoped_exploitation_ids scoped_exploitation
      JOIN "DeclarantPointPrelevement" exploitation
        ON exploitation.id = scoped_exploitation.exploitation_id
      JOIN "PointPrelevement" point
        ON point.id = exploitation."pointPrelevementId"
      LEFT JOIN "SandreWaterUse" water_use ON water_use.id = exploitation."usageId"
      ${exploitationSearchJoins}
      LEFT JOIN active_collector_links active_collector
        ON active_collector.exploitation_id = exploitation.id
      LEFT JOIN connected_exploitations connected_exploitation
        ON connected_exploitation.exploitation_id = exploitation.id
    ),
    declarant_exploitation_summaries AS MATERIALIZED (
      SELECT
        candidate_exploitation.declarant_id,
        array_agg(
          exploitation_summary.id
          ORDER BY exploitation_summary.id
        ) AS "exploitationIds",
        array_agg(
          DISTINCT exploitation_summary.status::text
          ORDER BY exploitation_summary.status::text
        ) AS statuses,
        array_agg(
          DISTINCT exploitation_summary."waterBodyType"::text
          ORDER BY exploitation_summary."waterBodyType"::text
        ) FILTER (
          WHERE exploitation_summary."waterBodyType" IS NOT NULL
        ) AS "waterBodyTypes",
        bool_or(exploitation_summary."hasCollecteur") AS "hasCollecteur",
        bool_or(exploitation_summary."hasConnector") AS "hasConnector"
        ${declarantSummarySearchColumns}
      FROM candidate_exploitations candidate_exploitation
      JOIN exploitation_summaries exploitation_summary
        ON exploitation_summary.id = candidate_exploitation.exploitation_id
      GROUP BY candidate_exploitation.declarant_id
    ),
    unique_declarant_zones AS MATERIALIZED (
      SELECT DISTINCT
        candidate_exploitation.declarant_id,
        zone.id,
        zone.code,
        zone.name,
        zone.type
      FROM candidate_exploitations candidate_exploitation
      JOIN scoped_exploitation_ids scoped_exploitation
        ON scoped_exploitation.exploitation_id
          = candidate_exploitation.exploitation_id
      JOIN "DeclarantPointPrelevement" exploitation
        ON exploitation.id = scoped_exploitation.exploitation_id
      JOIN "PointPrelevementZone" point_zone
        ON point_zone."pointPrelevementId" = exploitation."pointPrelevementId"
      JOIN "Zone" zone ON zone.id = point_zone."zoneId"
    ),
    declarant_zones AS MATERIALIZED (
      SELECT
        unique_declarant_zone.declarant_id,
        jsonb_agg(
          jsonb_build_object(
            'id', unique_declarant_zone.id,
            'code', unique_declarant_zone.code,
            'name', unique_declarant_zone.name,
            'type', unique_declarant_zone.type
          )
          ORDER BY unique_declarant_zone.name, unique_declarant_zone.id
        ) AS zones
      FROM unique_declarant_zones unique_declarant_zone
      GROUP BY unique_declarant_zone.declarant_id
    ),
    declarant_usages AS MATERIALIZED (
      SELECT
        candidate_exploitation.declarant_id,
        exploitation_summary."usageCode",
        max(exploitation_summary."usageLabel") AS "usageLabel",
        count(*) AS occurrence
      FROM candidate_exploitations candidate_exploitation
      JOIN exploitation_summaries exploitation_summary
        ON exploitation_summary.id = candidate_exploitation.exploitation_id
      WHERE exploitation_summary."usageCode" IS NOT NULL
      GROUP BY
        candidate_exploitation.declarant_id,
        exploitation_summary."usageCode"
    ),
    declarant_usage_summaries AS MATERIALIZED (
      SELECT
        declarant_usage.declarant_id,
        jsonb_agg(
          jsonb_build_object(
            'code', declarant_usage."usageCode",
            'label', declarant_usage."usageLabel",
            'occurrence', declarant_usage.occurrence
          )
          ORDER BY declarant_usage."usageCode"
        ) AS usages
      FROM declarant_usages declarant_usage
      GROUP BY declarant_usage.declarant_id
    )
    SELECT
      declarant_summary.declarant_id AS "declarantUserId",
      declarant_summary."exploitationIds",
      declarant_summary.statuses,
      coalesce(declarant_summary."waterBodyTypes", ARRAY[]::text[])
        AS "waterBodyTypes",
      coalesce(declarant_zone.zones, '[]'::jsonb) AS zones,
      coalesce(declarant_usage.usages, '[]'::jsonb) AS usages,
      declarant_summary."hasCollecteur",
      declarant_summary."hasConnector"
      ${resultSearchColumns}
    FROM declarant_exploitation_summaries declarant_summary
    LEFT JOIN declarant_zones declarant_zone
      ON declarant_zone.declarant_id = declarant_summary.declarant_id
    LEFT JOIN declarant_usage_summaries declarant_usage
      ON declarant_usage.declarant_id = declarant_summary.declarant_id
  `)
}

function attachDeclarantSearchExploitations(records, exploitationRows) {
  const byDeclarantId = new Map()

  for (const row of exploitationRows) {
    byDeclarantId.set(row.declarantUserId, {
      exploitationIds: row.exploitationIds ?? [],
      statuses: row.statuses ?? [],
      waterBodyTypes: row.waterBodyTypes ?? [],
      zones: row.zones ?? [],
      usages: row.usages ?? [],
      hasCollecteur: row.hasCollecteur === true,
      hasConnector: row.hasConnector === true,
      humanSearchText: row.humanSearchText ?? '',
      identifierSearchText: row.identifierSearchText ?? ''
    })
  }

  return records.map(record => ({
    ...record,
    declarant: {
      ...record.declarant,
      searchExploitationSummary: byDeclarantId.get(record.id) ?? {
        exploitationIds: [],
        statuses: [],
        waterBodyTypes: [],
        zones: [],
        usages: [],
        hasCollecteur: false,
        hasConnector: false,
        humanSearchText: '',
        identifierSearchText: ''
      }
    }
  }))
}

function getActivityRange(lastDeclarationAt, now) {
  if (!lastDeclarationAt) {
    return 'NEVER'
  }

  const ageInDays = Math.max(0, Math.floor((now - new Date(lastDeclarationAt)) / DAY_IN_MS))

  if (ageInDays < 30) {
    return 'LT_30_DAYS'
  }

  if (ageInDays <= 90) {
    return 'DAYS_30_90'
  }

  if (ageInDays <= 365) {
    return 'DAYS_91_365'
  }

  return 'GT_365_DAYS'
}

function declarantSearchLabel(user) {
  return user.declarant?.socialReason
    || [user.firstName, user.lastName].filter(Boolean).join(' ')
    || user.email
    || 'Déclarant sans nom'
}

function getDeclarantInMemorySearchDocument(user) {
  const declarant = user.declarant ?? {}
  const exploitationSummary = declarant.searchExploitationSummary ?? {}

  return {
    id: user.id,
    primaryLabel: declarantSearchLabel(user),
    humanText: [
      user.firstName,
      user.lastName,
      declarant.socialReason,
      declarant.city,
      declarant.jobTitle,
      exploitationSummary.humanSearchText
    ].filter(Boolean).join(' '),
    identifierText: [
      user.id,
      user.email,
      declarant.siret,
      declarant.phoneNumber,
      declarant.sourceId,
      exploitationSummary.identifierSearchText
    ].filter(Boolean).join(' ')
  }
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))]
}

function normalizeSearchRecord(user, zoneLinks, now) {
  const declarant = user.declarant ?? {}
  const exploitationSummary = declarant.searchExploitationSummary
  const exploitations = [
    ...(declarant.pointPrelevements ?? []),
    ...(declarant.collecteurExploitations ?? [])
      .map(link => link.exploitation)
      .filter(Boolean)
  ]
  const exploitationZones = exploitationSummary
    ? exploitationSummary.zones
    : exploitations.flatMap(exploitation =>
      (exploitation.pointPrelevement?.zones ?? []).map(link => link.zone))
  const zones = uniqueValues([
    ...(zoneLinks ?? []).map(link => link.zone),
    ...exploitationZones
  ].filter(Boolean).map(zone => zone.id))
  const zoneDetails = new Map()
  const usageDetails = new Map()
  const usageCounts = new Map()

  for (const link of zoneLinks ?? []) {
    if (link.zone) {
      zoneDetails.set(link.zone.id, link.zone)
    }
  }

  for (const zone of exploitationZones) {
    if (zone) {
      zoneDetails.set(zone.id, zone)
    }
  }

  const usages = exploitationSummary
    ? exploitationSummary.usages
    : exploitations
      .map(exploitation => ({...exploitation.usage, occurrence: 1}))
      .filter(usage => usage.code)

  for (const usage of usages) {
    if (usage.code) {
      const code = getRootWaterUseCode(usage.code)

      if (code) {
        usageDetails.set(code, getWaterUse(code) ?? usage)
        usageCounts.set(
          code,
          (usageCounts.get(code) ?? 0) + Number(usage.occurrence ?? 1)
        )
      }
    }
  }

  return {
    id: user.id,
    label: declarantSearchLabel(user),
    role: declarant.declarantRole ?? 'PRELEVEUR',
    declarantType: declarant.declarantType ?? null,
    preleveurType: declarant.preleveurType ?? null,
    emailStatus: user.email ? 'WITH_EMAIL' : 'WITHOUT_EMAIL',
    activityRange: getActivityRange(declarant.lastDeclarationAt, now),
    lastDeclarationAt: declarant.lastDeclarationAt ?? null,
    collecteurStatus: (exploitationSummary
      ? exploitationSummary.hasCollecteur
      : exploitations.some(exploitation => exploitation.collecteurs?.length > 0))
      ? 'WITH_COLLECTEUR'
      : 'WITHOUT_COLLECTEUR',
    connectorStatus: (exploitationSummary
      ? exploitationSummary.hasConnector
      : exploitations.some(exploitation => exploitation.connectors?.length > 0))
      ? 'WITH_CONNECTOR'
      : 'WITHOUT_CONNECTOR',
    zoneIds: zones,
    zoneDetails,
    usageCodes: [...usageDetails.keys()].sort((left, right) =>
      Number(['0', '1'].includes(left)) - Number(['0', '1'].includes(right))
      || (usageCounts.get(right) ?? 0) - (usageCounts.get(left) ?? 0)
      || (usageDetails.get(left)?.label ?? left)
        .localeCompare(usageDetails.get(right)?.label ?? right, 'fr')),
    usageDetails,
    waterBodyTypes: exploitationSummary
      ? exploitationSummary.waterBodyTypes
      : uniqueValues(
        exploitations.map(exploitation => exploitation.pointPrelevement?.waterBodyType)
      ),
    exploitationStatuses: exploitationSummary
      ? exploitationSummary.statuses
      : uniqueValues(exploitations.map(exploitation => exploitation.status))
  }
}

function hasSelectedValue(actualValues, selectedValues) {
  return selectedValues.length === 0
    || actualValues.some(value => selectedValues.includes(value))
}

function matchesDeclarantFilters(record, filters) {
  return (!filters.role || record.role === filters.role)
    && (!filters.declarantType || record.declarantType === filters.declarantType)
    && (!filters.preleveurType || record.preleveurType === filters.preleveurType)
    && (!filters.emailStatus || record.emailStatus === filters.emailStatus)
    && (!filters.collecteurStatus || record.collecteurStatus === filters.collecteurStatus)
    && (!filters.connectorStatus || record.connectorStatus === filters.connectorStatus)
    && (!filters.activityRange || record.activityRange === filters.activityRange)
    && hasSelectedValue(record.zoneIds, filters.zoneIds)
    && hasSelectedValue(record.usageCodes, filters.usageCodes)
    && hasSelectedValue(record.waterBodyTypes, filters.waterBodyTypes)
    && hasSelectedValue(record.exploitationStatuses, filters.exploitationStatuses)
}

function createFacet(records, getValues, getDetails = value => ({
  value,
  label: SEARCH_FACET_LABELS[value] ?? value
})) {
  const counts = new Map()
  const details = new Map()

  for (const record of records) {
    for (const value of uniqueValues(getValues(record))) {
      counts.set(value, (counts.get(value) ?? 0) + 1)
      details.set(value, getDetails(value, record))
    }
  }

  return [...counts.entries()]
    .map(([value, count]) => ({...details.get(value), value, count}))
    .sort((left, right) => left.label.localeCompare(right.label, 'fr'))
}

function createDeclarantFacets(records, {includeExploitationRelations = true} = {}) {
  const facets = {
    roles: createFacet(records, record => [record.role]),
    declarantTypes: createFacet(records, record => [record.declarantType]),
    preleveurTypes: createFacet(records, record => [record.preleveurType]),
    emailStatuses: createFacet(records, record => [record.emailStatus]),
    collecteurStatuses: createFacet(records, record => [record.collecteurStatus]),
    connectorStatuses: createFacet(records, record => [record.connectorStatus]),
    activityRanges: createFacet(records, record => [record.activityRange]),
    zoneIds: createFacet(records, record => record.zoneIds, (value, record) => {
      const zone = record.zoneDetails.get(value)
      return {
        value,
        label: zone?.name ?? value,
        code: zone?.code ?? null,
        type: zone?.type ?? null
      }
    }),
    usageCodes: createFacet(records, record => record.usageCodes, (value, record) => ({
      value,
      label: record.usageDetails.get(value)?.label ?? value
    })),
    waterBodyTypes: createFacet(records, record => record.waterBodyTypes),
    exploitationStatuses: createFacet(records, record => record.exploitationStatuses)
  }

  if (!includeExploitationRelations) {
    delete facets.collecteurStatuses
    delete facets.connectorStatuses
    delete facets.usageCodes
    delete facets.waterBodyTypes
    delete facets.exploitationStatuses
  }

  return facets
}

function compareNullableDates(left, right, order) {
  const leftTime = left ? new Date(left).getTime() : null
  const rightTime = right ? new Date(right).getTime() : null

  if (leftTime === null) {
    return rightTime === null ? 0 : 1
  }

  if (rightTime === null) {
    return -1
  }

  return order === 'ASC' ? leftTime - rightTime : rightTime - leftTime
}

function sortSearchRecords(records, {order, sort}) {
  const collator = new Intl.Collator('fr', {numeric: true, sensitivity: 'base'})

  return [...records].sort((left, right) => {
    if (sort === 'LAST_DECLARATION') {
      const dateOrder = compareNullableDates(
        left.lastDeclarationAt,
        right.lastDeclarationAt,
        order
      )
      if (dateOrder !== 0) {
        return dateOrder
      }
    }

    return collator.compare(left.label, right.label) || left.id.localeCompare(right.id)
  })
}

async function filterAndRankSearchRecords(
  records,
  filters,
  {client, rank = rankDeclarantIds}
) {
  const filtered = records.filter(record => matchesDeclarantFilters(record, filters))

  if (!filters.query) {
    return sortSearchRecords(filtered, {
      ...filters,
      sort: filters.sort === 'LAST_DECLARATION' ? filters.sort : 'NAME'
    })
  }

  const ranked = await rank(
    filtered.map(record => record.id),
    filters.query,
    {client}
  )
  const relevanceById = new Map(ranked.map(item => [item.id, Number(item.relevance)]))
  const matched = filtered.filter(record => relevanceById.has(record.id))

  if (filters.sort !== 'RELEVANCE') {
    return sortSearchRecords(matched, filters)
  }

  return matched.sort((left, right) =>
    relevanceById.get(right.id) - relevanceById.get(left.id)
    || left.label.localeCompare(right.label, 'fr', {sensitivity: 'base'})
    || left.id.localeCompare(right.id))
}

async function getZoneLinksForSearchRecords(records, allowedZoneIds, {client}) {
  if (records.length === 0) {
    return new Map()
  }

  const links = await getEffectiveDeclarantZoneLinks({
    client,
    declarantUserIds: records.map(record => record.id),
    ...(Array.isArray(allowedZoneIds) ? {zoneIds: allowedZoneIds} : {})
  })
  const zoneIds = uniqueValues(links.map(link => link.zoneId))
  const zones = zoneIds.length === 0
    ? []
    : await client.zone.findMany({
      where: {id: {in: zoneIds}},
      select: {id: true, code: true, name: true, type: true}
    })
  const zoneById = new Map(zones.map(zone => [zone.id, zone]))
  const byDeclarantId = new Map()

  for (const link of links) {
    const current = byDeclarantId.get(link.declarantUserId) ?? []
    current.push({...link, zone: zoneById.get(link.zoneId)})
    byDeclarantId.set(link.declarantUserId, current)
  }

  return byDeclarantId
}

function createSearchCounts(records) {
  return {
    total: records.length,
    preleveurs: records.filter(record => record.role === 'PRELEVEUR').length,
    collecteurs: records.filter(record => record.role === 'COLLECTEUR').length,
    withoutEmail: records.filter(record => record.emailStatus === 'WITHOUT_EMAIL').length
  }
}

async function buildSearchResult({
  baseRecords,
  filters,
  hydrate,
  zoneLinksByDeclarantId,
  client,
  now,
  rank,
  includeExploitationRelations = true
}) {
  const records = baseRecords.map(user => normalizeSearchRecord(
    user,
    zoneLinksByDeclarantId.get(user.id) ?? [],
    now
  ))
  const orderedRecords = await filterAndRankSearchRecords(records, filters, {
    client,
    rank
  })
  const total = orderedRecords.length
  const pageRecords = orderedRecords.slice(
    (filters.page - 1) * filters.pageSize,
    filters.page * filters.pageSize
  )
  const items = await hydrate(pageRecords.map(record => record.id))
  const itemById = new Map(items.map(item => [item.id ?? item.userId, item]))

  const decorateItem = record => {
    const item = itemById.get(record.id)

    if (!item) {
      return null
    }

    const usages = record.usageCodes.map(code => ({
      code,
      label: record.usageDetails.get(code)?.label ?? code
    }))

    return usages.length > 0
      ? {...item, searchSummary: {usages}}
      : item
  }

  return {
    items: pageRecords.map(decorateItem).filter(Boolean),
    total,
    page: filters.page,
    pageSize: filters.pageSize,
    totalPages: Math.max(1, Math.ceil(total / filters.pageSize)),
    counts: createSearchCounts(records),
    facets: createDeclarantFacets(records, {includeExploitationRelations})
  }
}

function normalizeDeclarantSearchFilters(filters = {}, {
  includeExploitationRelations = true
} = {}) {
  const normalizedFilters = {
    page: filters.page ?? 1,
    pageSize: filters.pageSize ?? 25,
    query: filters.query ?? '',
    role: filters.role ?? null,
    declarantType: filters.declarantType ?? null,
    preleveurType: filters.preleveurType ?? null,
    emailStatus: filters.emailStatus ?? null,
    collecteurStatus: filters.collecteurStatus ?? null,
    connectorStatus: filters.connectorStatus ?? null,
    activityRange: filters.activityRange ?? null,
    sort: filters.sort ?? 'RELEVANCE',
    order: filters.order ?? 'DESC',
    zoneIds: filters.zoneIds ?? [],
    usageCodes: filters.usageCodes ?? [],
    waterBodyTypes: filters.waterBodyTypes ?? [],
    exploitationStatuses: filters.exploitationStatuses ?? [],
    format: filters.format === 'compact' ? 'compact' : 'legacy'
  }

  if (!includeExploitationRelations) {
    normalizedFilters.collecteurStatus = null
    normalizedFilters.connectorStatus = null
    normalizedFilters.usageCodes = []
    normalizedFilters.waterBodyTypes = []
    normalizedFilters.exploitationStatuses = []
  }

  return normalizedFilters
}

function getDeclarantSearchScopesById(records) {
  return new Map(records.map(item => [
    item.id,
    {
      declarantId: item.id,
      exploitationIds: uniqueValues(
        item.declarant?.searchExploitationSummary?.exploitationIds
        ?? [
          ...(item.declarant?.pointPrelevements ?? []).map(exploitation => exploitation.id),
          ...(item.declarant?.collecteurExploitations ?? [])
            .map(link => link.exploitation?.id)
        ]
      )
    }
  ]))
}

export async function getDeclarant(declarantUserId, includeDeleted = false) {
  return prisma.user.findFirst({
    where: {
      id: declarantUserId,
      role: 'DECLARANT',
      ...userWhere(includeDeleted)
    },
    include: {declarant: true}
  })
}

export async function getDeclarants(includeDeleted = false) {
  return prisma.user.findMany({
    where: getDeclarantsBaseWhere({includeDeleted}),
    include: getDeclarantListInclude(),
    orderBy: {createdAt: 'asc'}
  })
}

export async function getDeclarantsByInstructor(
  instructorId,
  includeDeleted = false,
  now = new Date(),
  {client = prisma} = {}
) {
  const scope = await getInstructorDeclarantListScope(instructorId, {client, now})

  return client.user.findMany({
    where: getDeclarantsBaseWhere({
      accessibleDeclarantUserIds: scope.declarantUserIds,
      includeDeleted
    }),
    include: getDeclarantListInclude({
      exploitationZoneIds: scope.exploitationZoneIds
    }),
    orderBy: {createdAt: 'asc'}
  })
}

export async function searchDeclarants(user, searchFilters = {}, {
  client = prisma,
  now = new Date()
} = {}) {
  const instructorScope = user?.role === 'INSTRUCTOR'
    ? await getInstructorDeclarantListScope(user.id, {client, now})
    : null
  const includeExploitationRelations = !instructorScope
    || instructorScope.exploitationZoneIds.length > 0
  const filters = normalizeDeclarantSearchFilters(searchFilters, {
    includeExploitationRelations
  })
  const baseWhere = getDeclarantsBaseWhere({
    accessibleDeclarantUserIds: instructorScope?.declarantUserIds
  })
  const baseRecords = await client.user.findMany({
    where: baseWhere,
    select: getDeclarantSearchSelect({
      includeSearchDocuments: Boolean(filters.query)
    })
  })
  const candidateIds = baseRecords.map(record => record.id)
  const [exploitationRows, zoneLinksByDeclarantId] = await Promise.all([
    getDeclarantSearchExploitations(
      candidateIds,
      instructorScope?.exploitationZoneIds,
      {
        client,
        includeSearchDocuments: Boolean(filters.query)
      }
    ),
    getZoneLinksForSearchRecords(
      baseRecords,
      instructorScope?.declarantZoneIds,
      {client}
    )
  ])
  const searchRecords = attachDeclarantSearchExploitations(baseRecords, exploitationRows)
  const searchDocumentsById = new Map(searchRecords.map(record => [
    record.id,
    getDeclarantInMemorySearchDocument(record)
  ]))
  const hydrate = ids => {
    if (ids.length === 0) {
      return []
    }

    const where = {AND: [baseWhere, {id: {in: ids}}]}

    return filters.format === 'compact'
      ? client.user.findMany({
        where,
        select: getDeclarantCompactListSelect({
          exploitationZoneIds: instructorScope?.exploitationZoneIds
        })
      })
      : client.user.findMany({
        where,
        include: getDeclarantListInclude({
          exploitationZoneIds: instructorScope?.exploitationZoneIds
        })
      })
  }

  return buildSearchResult({
    baseRecords: searchRecords,
    filters,
    zoneLinksByDeclarantId,
    client,
    now,
    includeExploitationRelations,
    rank: (rankedCandidateIds, query) => rankSearchDocuments(
      rankedCandidateIds
        .map(id => searchDocumentsById.get(id))
        .filter(Boolean),
      query
    ),
    hydrate
  })
}

export async function searchCollecteurPreleveurs(
  collecteurUserId,
  searchFilters = {},
  {client = prisma, now = new Date()} = {}
) {
  const baseRecords = await getCollecteurPreleveurSearchRecords(
    collecteurUserId,
    {client}
  )
  const filters = {
    ...normalizeDeclarantSearchFilters(searchFilters),
    role: 'PRELEVEUR'
  }
  const byId = new Map(baseRecords.map(item => [item.id, item]))
  const scopesByDeclarantId = getDeclarantSearchScopesById(baseRecords)
  async function hydrate(ids) {
    if (filters.format === 'compact') {
      return ids.map(id => byId.get(id)).filter(Boolean)
    }

    return getCollecteurPreleveurs(collecteurUserId, {
      client,
      preleveurUserIds: ids
    })
  }

  return buildSearchResult({
    baseRecords,
    filters,
    zoneLinksByDeclarantId: new Map(),
    client,
    now,
    rank: (candidateIds, query, options) => rankCollecteurPreleveurIds(
      candidateIds.map(id => scopesByDeclarantId.get(id)).filter(Boolean),
      query,
      options
    ),
    hydrate
  })
}

export async function getDeclarantDetail(req, res) {
  const declarant = await getDeclarantById(req.declarant.id)

  res.send(declarant)
}

async function withPointDeclarationStats(declarant, declarantId, {client = prisma} = {}) {
  const pointPrelevementIds = declarant.pointPrelevements
    .map(exploitation => exploitation.pointPrelevementId)
    .filter(Boolean)

  if (pointPrelevementIds.length === 0) {
    return normalizeDeclarant(declarant)
  }

  const chunks = await client.chunk.findMany({
    where: {
      pointPrelevementId: {
        in: pointPrelevementIds
      },
      source: {
        declaration: {
          declarantUserId: declarantId
        }
      }
    },
    select: {
      pointPrelevementId: true,
      minDate: true,
      maxDate: true,
      source: {
        select: {
          declaration: {
            select: {
              createdAt: true
            }
          }
        }
      }
    },
    orderBy: [
      {pointPrelevementId: 'asc'}
    ]
  })

  const statsByPointId = new Map()

  for (const chunk of chunks) {
    const {pointPrelevementId} = chunk

    if (!pointPrelevementId) {
      continue
    }

    const declarationCreatedAt = chunk.source.declaration.createdAt

    const current = statsByPointId.get(pointPrelevementId)

    if (!current) {
      statsByPointId.set(pointPrelevementId, {
        lastDeclarationAt: declarationCreatedAt,
        minDeclaredDate: chunk.minDate,
        maxDeclaredDate: chunk.maxDate
      })

      continue
    }

    if (declarationCreatedAt && (!current.lastDeclarationAt || declarationCreatedAt > current.lastDeclarationAt)) {
      current.lastDeclarationAt = declarationCreatedAt
    }

    if (chunk.minDate && (!current.minDeclaredDate || chunk.minDate < current.minDeclaredDate)) {
      current.minDeclaredDate = chunk.minDate
    }

    if (chunk.maxDate && (!current.maxDeclaredDate || chunk.maxDate > current.maxDeclaredDate)) {
      current.maxDeclaredDate = chunk.maxDate
    }
  }

  return normalizeDeclarant({
    ...declarant,
    pointPrelevements: declarant.pointPrelevements.map(exploitation => {
      const stats = statsByPointId.get(exploitation.pointPrelevementId)

      return {
        ...exploitation,
        lastDeclarationAt: stats?.lastDeclarationAt ?? null,
        minDeclaredDate: stats?.minDeclaredDate ?? null,
        maxDeclaredDate: stats?.maxDeclaredDate ?? null
      }
    })
  })
}

export async function getDeclarantById(declarantId, {
  client = prisma,
  exploitationZoneIds
} = {}) {
  const exploitationWhere = getExploitationZoneWhere(exploitationZoneIds)
  const declarant = await client.declarant.findUnique({
    where: {
      userId: declarantId
    },
    include: {
      user: true,
      pointPrelevements: {
        ...(exploitationWhere ? {where: exploitationWhere} : {}),
        include: getExploitationInclude(),
        orderBy: [
          {createdAt: 'asc'}
        ]
      },
      collecteurExploitations: {
        ...(exploitationWhere
          ? {where: {exploitation: exploitationWhere}}
          : {}),
        include: {
          exploitation: {
            include: getExploitationInclude()
          }
        },
        orderBy: [
          {createdAt: 'asc'}
        ]
      },
      zones: {
        include: {
          zone: {
            select: {
              id: true,
              type: true,
              code: true,
              name: true
            }
          }
        },
        orderBy: {createdAt: 'asc'}
      }
    }
  })

  return declarant
    ? withPointDeclarationStats(declarant, declarantId, {client})
    : null
}

export async function getDeclarantOverviewById(declarantId, {
  client = prisma,
  exploitationZoneIds
} = {}) {
  const overviewExploitationInclude = getOverviewExploitationInclude()
  const exploitationWhere = getExploitationZoneWhere(exploitationZoneIds)
  const declarant = await client.declarant.findUnique({
    where: {userId: declarantId},
    include: {
      user: true,
      pointPrelevements: {
        ...(exploitationWhere ? {where: exploitationWhere} : {}),
        include: overviewExploitationInclude,
        orderBy: {createdAt: 'asc'}
      },
      collecteurExploitations: {
        ...(exploitationWhere
          ? {where: {exploitation: exploitationWhere}}
          : {}),
        include: {
          exploitation: {
            include: overviewExploitationInclude
          }
        },
        orderBy: {createdAt: 'asc'}
      }
    }
  })

  return declarant
    ? withPointDeclarationStats(declarant, declarantId, {client})
    : null
}

export async function getDeclarantsByIds(declarantUserIds, includeDeleted = false) {
  if (!Array.isArray(declarantUserIds) || declarantUserIds.length === 0) {
    return []
  }

  return prisma.user.findMany({
    where: {
      id: {in: declarantUserIds},
      role: 'DECLARANT',
      ...userWhere(includeDeleted)
    },
    include: {declarant: true}
  })
}

export async function getDeclarantByEmail(email, includeDeleted = false) {
  const candidate = normalizeEmail(email)

  if (!candidate) {
    return null
  }

  return prisma.user.findFirst({
    where: {
      email: candidate,
      role: 'DECLARANT',
      ...userWhere(includeDeleted)
    },
    include: {declarant: true}
  })
}

function assertEmailForCollecteur({userData, declarantData, existing}) {
  const nextRole = declarantData.declarantRole ?? existing?.declarant?.declarantRole ?? 'PRELEVEUR'
  const nextEmail = Object.hasOwn(userData, 'email')
    ? userData.email
    : existing?.email

  if (nextRole === 'COLLECTEUR' && !nextEmail) {
    throw createHttpError(400, 'Un collecteur doit avoir une adresse email pour pouvoir se connecter.')
  }
}

export async function insertDeclarant(declarantPayload, {
  zoneIds = [],
  createdByUserId = null
} = {}) {
  if (!declarantPayload || typeof declarantPayload !== 'object') {
    throw createHttpError(400, 'Le déclarant doit être un objet.')
  }

  const {userData, declarantData} = splitDeclarantPayload(declarantPayload)
  declarantData.declarantRole ??= 'PRELEVEUR'
  declarantData.preleveurType = normalizePreleveurType(declarantData)

  if (zoneIds.length > 0) {
    declarantData.zones = {
      create: [...new Set(zoneIds)].map(zoneId => ({
        zoneId,
        source: 'CREATION',
        createdByUserId
      }))
    }
  }

  assertEmailForCollecteur({userData, declarantData})

  try {
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: userData.email ?? null,
        firstName: userData.firstName ?? null,
        lastName: userData.lastName ?? null,
        role: 'DECLARANT',
        declarant: {
          create: declarantData
        }
      },
      include: {declarant: true}
    })

    return getDeclarantById(user.id)
  } catch (error) {
    if (error?.code === 'P2002') {
      throw createHttpError(409, 'Un utilisateur avec cet email existe déjà.')
    }

    throw error
  }
}

export async function updateDeclarantById(declarantUserId, changes, {client = prisma} = {}) {
  if (!changes || typeof changes !== 'object') {
    throw createHttpError(400, 'Les modifications doivent être un objet.')
  }

  const safeChanges = stripReadonlyDeclarantFields(changes)
  const {userData, declarantData} = splitDeclarantPayload(safeChanges)

  if (Object.keys(userData).length === 0 && Object.keys(declarantData).length === 0) {
    throw createHttpError(400, 'Aucun champ valide trouvé.')
  }

  try {
    await client.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`
        SELECT id
        FROM "User"
        WHERE id = ${declarantUserId}::uuid
        FOR UPDATE
      `)

      const existingUser = await tx.user.findFirst({
        where: {
          id: declarantUserId,
          role: 'DECLARANT',
          deletedAt: null
        },
        include: {declarant: true}
      })

      if (!existingUser) {
        throw createHttpError(404, 'Ce déclarant est introuvable.')
      }

      assertEmailForCollecteur({userData, declarantData, existing: existingUser})

      const nextDeclarant = {
        ...existingUser.declarant,
        ...declarantData
      }
      declarantData.preleveurType = normalizePreleveurType(nextDeclarant)

      if (declarantData.declarantRole === 'COLLECTEUR'
        && existingUser.declarant?.declarantRole !== 'COLLECTEUR') {
        const exploitationCount = await tx.declarantPointPrelevement.count({
          where: {declarantUserId}
        })

        if (exploitationCount > 0) {
          throw createHttpError(400, 'Impossible de transformer ce déclarant en collecteur : il est déjà rattaché à une ou plusieurs exploitations comme préleveur.')
        }
      }

      if (declarantData.declarantRole === 'PRELEVEUR'
        && existingUser.declarant?.declarantRole === 'COLLECTEUR') {
        const collecteurLinkCount = await tx.declarantCollecteurExploitation.count({
          where: {collecteurUserId: declarantUserId}
        })

        if (collecteurLinkCount > 0) {
          throw createHttpError(400, 'Impossible de transformer ce collecteur en préleveur : il est encore rattaché à une ou plusieurs exploitations.')
        }
      }

      await tx.user.update({
        where: {
          id: declarantUserId,
          role: 'DECLARANT',
          deletedAt: null
        },
        data: {
          ...userData,
          ...(Object.keys(declarantData).length > 0
            ? {declarant: {update: declarantData}}
            : {})
        }
      })
    }, {isolationLevel: Prisma.TransactionIsolationLevel.Serializable})

    return getDeclarantById(declarantUserId, {client})
  } catch (error) {
    if (error?.code === 'P2025') {
      throw createHttpError(404, 'Ce déclarant est introuvable.')
    }

    if (error?.code === 'P2002') {
      throw createHttpError(409, 'Email déjà utilisé.')
    }

    if (error?.code === 'P2034'
      || error?.code === '40001'
      || error?.meta?.code === '40001'
      || error?.cause?.code === '40001') {
      throw createHttpError(409, 'Ce déclarant a été modifié simultanément. Rechargez-le puis réessayez.')
    }

    throw error
  }
}

function groupCollecteurPreleveurs(links) {
  const byPreleveurId = new Map()

  for (const link of links) {
    const preleveur = link.exploitation?.declarant
    const user = preleveur?.user

    if (!preleveur || !user) {
      continue
    }

    const id = preleveur.userId
    const current = byPreleveurId.get(id) ?? {
      ...user,
      id,
      declarant: {
        ...preleveur,
        user,
        _count: {
          pointPrelevements: 0,
          collecteurExploitations: 0
        },
        collecteurExploitations: []
      }
    }

    current.declarant._count.pointPrelevements += 1
    current.declarant.collecteurExploitations.push({
      id: link.id,
      createdAt: link.createdAt,
      updatedAt: link.updatedAt,
      exploitation: link.exploitation
    })

    byPreleveurId.set(id, current)
  }

  return [...byPreleveurId.values()].sort((a, b) => {
    const labelA = (a.declarant.socialReason || `${a.firstName ?? ''} ${a.lastName ?? ''}`).trim().toLowerCase()
    const labelB = (b.declarant.socialReason || `${b.firstName ?? ''} ${b.lastName ?? ''}`).trim().toLowerCase()
    return labelA.localeCompare(labelB, 'fr')
  })
}

export async function getCollecteurPreleveurSearchRecords(
  collecteurUserId,
  {client = prisma} = {}
) {
  const links = await client.declarantCollecteurExploitation.findMany({
    where: {
      collecteurUserId,
      exploitation: {
        declarant: {
          declarantRole: 'PRELEVEUR',
          user: {deletedAt: null}
        }
      }
    },
    select: {
      id: true,
      createdAt: true,
      updatedAt: true,
      exploitation: {
        select: COLLECTEUR_PRELEVEUR_SEARCH_EXPLOITATION_SELECT
      }
    },
    orderBy: {createdAt: 'asc'}
  })

  return groupCollecteurPreleveurs(links)
}

export async function getCollecteurPreleveurs(collecteurUserId, {
  client = prisma,
  preleveurUserIds
} = {}) {
  const scopedPreleveurUserIds = Array.isArray(preleveurUserIds)
    ? uniqueValues(preleveurUserIds)
    : null

  if (scopedPreleveurUserIds?.length === 0) {
    return []
  }

  const links = await client.declarantCollecteurExploitation.findMany({
    where: {
      collecteurUserId,
      exploitation: {
        declarant: {
          declarantRole: 'PRELEVEUR',
          ...(scopedPreleveurUserIds
            ? {userId: {in: scopedPreleveurUserIds}}
            : {}),
          user: {deletedAt: null}
        }
      }
    },
    include: {
      exploitation: {
        include: {
          declarant: {
            include: {
              user: true
            }
          },
          usage: true,
          pointPrelevement: {
            include: {
              zones: {
                include: {zone: true}
              }
            }
          },
          collecteurs: {
            where: {
              collecteur: {
                user: {deletedAt: null}
              }
            },
            select: {id: true}
          },
          connectors: {
            select: {id: true}
          }
        }
      }
    },
    orderBy: {createdAt: 'asc'}
  })

  return groupCollecteurPreleveurs(links)
}

function uniqueDeclarantUserIds(declarantUserIds = []) {
  return [...new Set(declarantUserIds.filter(Boolean))]
}

export function getSourceActivityDeclarantUserIds(source = {}) {
  return uniqueDeclarantUserIds([
    source.declaration?.declarantUserId,
    source.declaration?.createdByDeclarantUserId,
    ...(source.chunks ?? []).flatMap(chunk => [
      chunk.preleveurUserId,
      chunk.submittedByDeclarantUserId,
      chunk.collecteurUserId
    ])
  ])
}

function getDeclarantActivityScopeSql(declarantUserIds = []) {
  const userIds = uniqueDeclarantUserIds(declarantUserIds)
  return userIds.length > 0
    ? Prisma.sql`WHERE d."userId" IN (${Prisma.join(userIds.map(userId => Prisma.sql`${userId}::uuid`))})`
    : Prisma.empty
}

function getDeclarantActivityRowsSql(declarantUserIds = []) {
  const scope = getDeclarantActivityScopeSql(declarantUserIds)

  return Prisma.sql`
    SELECT
      d."userId",
      d."lastDeclarationAt" AS "currentLastDeclarationAt",
      (
        SELECT MAX(
          CASE
            WHEN s.type = 'DECLARATION'::"SourceType" THEN declaration."createdAt"
            ELSE s."createdAt"
          END
        )
        FROM "Source" s
        LEFT JOIN "Declaration" declaration
          ON declaration.id = s."declarationId"
        WHERE s.type IN ('DECLARATION'::"SourceType", 'API'::"SourceType")
          AND s.status = 'COMPLETED'::"SourceStatus"
          AND EXISTS (
            SELECT 1
            FROM "Chunk" chunk
            WHERE chunk."sourceId" = s.id
              AND chunk."instructionStatus" <> 'REJECTED'::"ChunkInstructionStatus"
              AND (
                declaration."declarantUserId" = d."userId"
                OR declaration."createdByDeclarantUserId" = d."userId"
                OR chunk."preleveurUserId" = d."userId"
                OR chunk."submittedByDeclarantUserId" = d."userId"
                OR chunk."collecteurUserId" = d."userId"
              )
          )
      ) AS "lastDeclarationAt"
    FROM "Declarant" d
    ${scope}
  `
}

export function buildDeclarantActivityRefreshQuery(declarantUserIds = []) {
  const activityRows = getDeclarantActivityRowsSql(declarantUserIds)

  return Prisma.sql`
    WITH declarant_activity AS MATERIALIZED (${activityRows})
    UPDATE "Declarant" declarant
    SET "lastDeclarationAt" = activity."lastDeclarationAt"
    FROM declarant_activity activity
    WHERE declarant."userId" = activity."userId"
      AND declarant."lastDeclarationAt" IS DISTINCT FROM activity."lastDeclarationAt"
    RETURNING declarant."userId", declarant."lastDeclarationAt"
  `
}

export function buildDeclarantActivityPreviewQuery(declarantUserIds = []) {
  const activityRows = getDeclarantActivityRowsSql(declarantUserIds)

  return Prisma.sql`
    WITH declarant_activity AS MATERIALIZED (${activityRows})
    SELECT
      activity."userId",
      activity."currentLastDeclarationAt",
      activity."lastDeclarationAt"
    FROM declarant_activity activity
    WHERE activity."currentLastDeclarationAt" IS DISTINCT FROM activity."lastDeclarationAt"
    ORDER BY activity."userId"
  `
}

export async function previewDeclarantsLastDeclarationAt(declarantUserIds = [], {
  client = prisma
} = {}) {
  return client.$queryRaw(buildDeclarantActivityPreviewQuery(declarantUserIds))
}

export async function refreshDeclarantsLastDeclarationAt(declarantUserIds = [], {
  client = prisma
} = {}) {
  const userIds = uniqueDeclarantUserIds(declarantUserIds)

  if (userIds.length === 0) {
    return []
  }

  return client.$queryRaw(buildDeclarantActivityRefreshQuery(userIds))
}

export async function refreshAllDeclarantsLastDeclarationAt({
  client = prisma
} = {}) {
  return client.$queryRaw(buildDeclarantActivityRefreshQuery())
}

export async function getDeclarantUserIdsForSourceActivity(sourceId, {
  client = prisma
} = {}) {
  const source = await client.source.findUnique({
    where: {id: sourceId},
    select: {
      declaration: {
        select: {
          declarantUserId: true,
          createdByDeclarantUserId: true
        }
      },
      chunks: {
        select: {
          preleveurUserId: true,
          submittedByDeclarantUserId: true,
          collecteurUserId: true
        }
      }
    }
  })

  if (!source) {
    return []
  }

  return getSourceActivityDeclarantUserIds(source)
}

export async function refreshSourceDeclarantsLastDeclarationAt(sourceId, {
  client = prisma
} = {}) {
  if (typeof client.source?.findUnique !== 'function' || typeof client.$queryRaw !== 'function') {
    return []
  }

  const declarantUserIds = await getDeclarantUserIdsForSourceActivity(sourceId, {client})
  return refreshDeclarantsLastDeclarationAt(declarantUserIds, {client})
}

export async function updateLastDeclarationAt(declarantUserId, {
  client = prisma
} = {}) {
  const user = await client.user.findFirst({
    where: {
      id: declarantUserId,
      role: 'DECLARANT',
      deletedAt: null
    },
    select: {id: true}
  })

  if (!user) {
    throw createHttpError(404, 'Ce déclarant est introuvable.')
  }

  await refreshDeclarantsLastDeclarationAt([declarantUserId], {client})

  return client.declarant.findUnique({
    where: {
      userId: declarantUserId
    },
    include: {
      user: true
    }
  })
}

export async function deleteDeclarantById(declarantUserId, {
  client = prisma,
  now = new Date()
} = {}) {
  return client.$transaction(async tx => {
    const [user] = await tx.$queryRaw`
      SELECT "id"
      FROM "User"
      WHERE "id" = ${declarantUserId}::uuid
        AND "role" = 'DECLARANT'::"UserRole"
        AND "deletedAt" IS NULL
      FOR UPDATE
    `

    if (!user) {
      throw createHttpError(404, 'Ce déclarant est introuvable.')
    }

    await tx.userEmailAlias.deleteMany({
      where: {userId: declarantUserId}
    })
    await tx.authToken.deleteMany({
      where: {userId: declarantUserId}
    })
    await tx.sessionToken.deleteMany({
      where: {
        OR: [
          {userId: declarantUserId},
          {impersonatedByUserId: declarantUserId}
        ]
      }
    })
    await tx.serviceAccountToken.updateMany({
      where: {
        declarantUserId,
        revokedAt: null
      },
      data: {revokedAt: now}
    })

    return tx.user.update({
      where: {id: declarantUserId},
      data: {
        email: null,
        deletedAt: now
      }
    })
  })
}
