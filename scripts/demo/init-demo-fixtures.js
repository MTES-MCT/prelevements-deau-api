import '../../lib/config/env.js'
import {prisma} from '../../db/prisma.js'
import {ZONE_PERMISSION_CODES} from '../../lib/constants/zone-permissions.js'
import {syncDeclarantZonesFromPoint} from '../../lib/services/zone-permissions.js'
import {allowTemplateDeclarationTypeForDeclarant} from '../../lib/models/declaration-type.js'
import {legacyUsageToRootUsageCode} from '../../lib/constants/sandre-water-uses.js'
import {getPreleveurTypeFromUsages} from '../../lib/services/preleveur-types.js'

const DEMO_SERIES = [
  {prefix: 'ougc', count: 50, waterBodyTypes: ['SOUTERRAIN', 'SUPERFICIELLE'], labels: ['Forage', 'Pompage']},
  {prefix: 'gidaf', count: 20, waterBodyTypes: ['SOUTERRAIN', 'SUPERFICIELLE', 'TRANSITION'], labels: ['Forage', 'Pompage', 'Source']},
  {prefix: 'aep-1', count: 10, waterBodyTypes: ['SOUTERRAIN', 'SUPERFICIELLE'], labels: ['Forage', 'Source', 'Pompage']},
  {prefix: 'aep-2', count: 10, waterBodyTypes: ['SOUTERRAIN', 'SUPERFICIELLE'], labels: ['Forage', 'Source', 'Pompage']},
  {prefix: 'aep-3', count: 10, waterBodyTypes: ['SOUTERRAIN', 'SUPERFICIELLE'], labels: ['Forage', 'Source', 'Pompage']}
]

const COMMON_NAMES = [
  'des Acacias',
  'du Moulin',
  'de la Prairie',
  'des Vignes',
  'de la Gare',
  'du Château',
  'de Bellevue',
  'de la Vallée',
  'des Chênes',
  'de la Plaine',
  'du Lavoir',
  'de la Fontaine',
  'du Petit Bois',
  'de la Bergerie',
  'de la Garenne',
  'de Montplaisir',
  'de la Rivière',
  'du Grand Pré',
  'de la Croix Blanche',
  'des Peupliers',
  'des Tilleuls',
  'de la Ferme Neuve',
  'des Coteaux',
  'du Verger',
  'de la Source Bleue',
  'des Noyers',
  'de la Sablière',
  'de la Tour',
  'des Rosiers',
  'du Gué'
]

const DEMO_DECLARANTS = [
  {
    key: 'ougc',
    email: 'ougc@demo.fr',
    firstName: 'OUGC',
    lastName: 'Collecteur',
    socialReason: 'OUGC Demo',
    sourceId: 'demo-declarant-ougc',
    pointPrefix: 'demo-ougc-',
    type: 'COLLECTEUR',
    usage: 'IRRIGATION'
  },
  {
    key: 'gidaf',
    email: 'gidaf@demo.fr',
    firstName: 'GIDAF',
    lastName: 'Collecteur',
    socialReason: 'GIDAF Demo',
    sourceId: 'demo-declarant-gidaf',
    pointPrefix: 'demo-gidaf-',
    type: 'COLLECTEUR',
    usage: 'INDUSTRIE'
  },
  {
    key: 'aep-1',
    email: 'aep1@demo.fr',
    firstName: 'AEP',
    lastName: 'Demo 1',
    socialReason: 'AEP Demo 1',
    sourceId: 'demo-declarant-aep-1',
    pointPrefix: 'demo-aep-1-',
    type: 'PRELEVEUR_DECLARANT',
    usage: 'AEP'
  },
  {
    key: 'aep-2',
    email: 'aep2@demo.fr',
    firstName: 'AEP',
    lastName: 'Demo 2',
    socialReason: 'AEP Demo 2',
    sourceId: 'demo-declarant-aep-2',
    pointPrefix: 'demo-aep-2-',
    type: 'PRELEVEUR_DECLARANT',
    usage: 'AEP'
  },
  {
    key: 'aep-3',
    email: 'aep3@demo.fr',
    firstName: 'AEP',
    lastName: 'Demo 3',
    socialReason: 'AEP Demo 3',
    sourceId: 'demo-declarant-aep-3',
    pointPrefix: 'demo-aep-3-',
    type: 'PRELEVEUR_DECLARANT',
    usage: 'AEP'
  }
]

async function upsertInstructorAccount(zoneId) {
  const user = await prisma.user.upsert({
    where: {
      email: 'agent@demo.fr'
    },
    update: {
      role: 'INSTRUCTOR',
      firstName: 'Agent',
      lastName: 'Demo',
      deletedAt: null
    },
    create: {
      email: 'agent@demo.fr',
      role: 'INSTRUCTOR',
      firstName: 'Agent',
      lastName: 'Demo'
    }
  })

  await prisma.instructor.upsert({
    where: {
      userId: user.id
    },
    update: {
      sourceId: 'demo-instructor-agent'
    },
    create: {
      userId: user.id,
      sourceId: 'demo-instructor-agent'
    }
  })

  await prisma.instructorZone.upsert({
    where: {
      instructorUserId_zoneId: {
        instructorUserId: user.id,
        zoneId
      }
    },
    update: {
      isAdmin: true,
      startDate: new Date('2020-01-01'),
      endDate: null,
      permissions: {
        deleteMany: {},
        createMany: {
          data: ZONE_PERMISSION_CODES.map(permission => ({permission}))
        }
      }
    },
    create: {
      instructorUserId: user.id,
      zoneId,
      isAdmin: true,
      startDate: new Date('2020-01-01'),
      endDate: null,
      permissions: {
        createMany: {
          data: ZONE_PERMISSION_CODES.map(permission => ({permission}))
        }
      }
    }
  })

  console.log('OK instructeur agent@demo.fr')
}

async function upsertDeclarantAccount(config) {
  const declarantRole = config.type === 'COLLECTEUR' ? 'COLLECTEUR' : 'PRELEVEUR'
  const preleveurType = declarantRole === 'PRELEVEUR'
    ? getPreleveurTypeFromUsages([config.usage])
    : null
  const user = await prisma.user.upsert({
    where: {
      email: config.email
    },
    update: {
      role: 'DECLARANT',
      firstName: config.firstName,
      lastName: config.lastName,
      deletedAt: null
    },
    create: {
      email: config.email,
      role: 'DECLARANT',
      firstName: config.firstName,
      lastName: config.lastName
    }
  })

  await prisma.declarant.upsert({
    where: {
      userId: user.id
    },
    update: {
      declarantType: 'LEGAL_PERSON',
      declarantRole,
      ...(declarantRole === 'COLLECTEUR' ? {preleveurType: null} : {}),
      socialReason: config.socialReason,
      sourceId: config.sourceId
    },
    create: {
      userId: user.id,
      declarantType: 'LEGAL_PERSON',
      declarantRole,
      preleveurType,
      socialReason: config.socialReason,
      sourceId: config.sourceId
    }
  })

  await allowTemplateDeclarationTypeForDeclarant(user.id)

  return user
}

async function resolveUsageId(usage) {
  const code = legacyUsageToRootUsageCode(usage)

  if (!code) {
    return null
  }

  const waterUse = await prisma.sandreWaterUse.findUnique({
    where: {code},
    select: {id: true}
  })

  return waterUse?.id ?? null
}

async function syncDeclarantPointPrelevements({declarantUserId, pointPrefix, usage, sourceKey}) {
  const usageId = await resolveUsageId(usage)
  const points = await prisma.pointPrelevement.findMany({
    where: {
      sourceId: {
        startsWith: pointPrefix
      }
    },
    select: {
      id: true,
      sourceId: true,
      name: true
    },
    orderBy: {
      sourceId: 'asc'
    }
  })

  await prisma.declarantPointPrelevement.deleteMany({
    where: {
      declarantUserId,
      sourceId: {
        startsWith: `demo-dpp-${sourceKey}-`
      }
    }
  })

  for (const point of points) {
    const exploitation = await prisma.declarantPointPrelevement.upsert({
      where: {
        declarantUserId_pointPrelevementId: {
          declarantUserId,
          pointPrelevementId: point.id
        }
      },
      update: {
        status: 'EN_ACTIVITE',
        usageId,
        startDate: null,
        endDate: null,
        abandonReason: null,
        comment: null,
        sourceId: `demo-dpp-${sourceKey}-${point.id}`
      },
      create: {
        declarantUserId,
        pointPrelevementId: point.id,
        status: 'EN_ACTIVITE',
        usageId,
        sourceId: `demo-dpp-${sourceKey}-${point.id}`
      }
    })
    await prisma.declarantPointPrelevementSecondaryUsage.deleteMany({
      where: {exploitationId: exploitation.id}
    })
    await syncDeclarantZonesFromPoint({
      declarantUserIds: [declarantUserId],
      pointPrelevementId: point.id,
      source: 'EXPLOITATION'
    })
  }

  console.log(`OK ${sourceKey}: ${points.length} PP liées`)
}

function pickRandom(array) {
  return array[Math.floor(Math.random() * array.length)]
}

function shuffle(array) {
  const copy = [...array]

  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]]
  }

  return copy
}

function slugify(value) {
  return value
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036F]/g, '')
    .toLowerCase()
    .replaceAll(/[^a-z\d]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
}

function buildName(globalIndex, config) {
  const label = pickRandom(config.labels)
  const commonName = COMMON_NAMES[globalIndex % COMMON_NAMES.length]
  return `${label} ${commonName} ${globalIndex + 1}`
}

function buildSourceId(prefix, index, name) {
  return `demo-${prefix}-${String(index + 1).padStart(3, '0')}-${slugify(name)}`
}

async function generateRandomPoints(zoneId, count) {
  return prisma.$queryRaw`
    SELECT ST_AsEWKT((dumped).geom) AS ewkt
    FROM (
      SELECT ST_Dump(ST_GeneratePoints(z.coordinates, ${count})) AS dumped
      FROM "Zone" z
      WHERE z.id = ${zoneId}
    ) q
  `
}

async function upsertPointPrelevement({name, sourceId, waterBodyType, ewkt}) {
  const rows = await prisma.$queryRaw`
    INSERT INTO "PointPrelevement" (
      id,
      name,
      "sourceId",
      "waterBodyType",
      "flowType",
      coordinates,
      "createdAt",
      "updatedAt"
    )
    VALUES (
      gen_random_uuid(),
      ${name},
      ${sourceId},
      ${waterBodyType}::"WaterBodyType",
      'PRELEVEMENT'::"PointFlowType",
      ST_GeomFromEWKT(${ewkt}),
      now(),
      now()
    )
    ON CONFLICT ("sourceId")
    DO UPDATE SET
      name = EXCLUDED.name,
      "waterBodyType" = EXCLUDED."waterBodyType",
      "flowType" = EXCLUDED."flowType",
      coordinates = EXCLUDED.coordinates,
      "updatedAt" = now()
    RETURNING id
  `

  return rows[0].id
}

async function ensurePointPrelevementZone(pointPrelevementId, zoneId) {
  await prisma.$executeRaw`
    INSERT INTO "PointPrelevementZone" (
      id,
      "pointPrelevementId",
      "zoneId",
      "createdAt"
    )
    VALUES (
      gen_random_uuid(),
      ${pointPrelevementId},
      ${zoneId},
      now()
    )
    ON CONFLICT ("pointPrelevementId", "zoneId")
    DO NOTHING
  `
}

async function main() {
  const zone = await prisma.zone.findFirstOrThrow({
    where: {
      code: 'sage-SAGE04025',
      type: 'SAGE'
    }
  })

  await prisma.pointPrelevement.deleteMany({
    where: {
      sourceId: {
        startsWith: 'demo-'
      }
    }
  })

  const totalCount = DEMO_SERIES.reduce((sum, item) => sum + item.count, 0)
  const generatedPoints = await generateRandomPoints(zone.id, totalCount)
  const pointsPool = shuffle(generatedPoints)

  let cursor = 0

  for (const config of DEMO_SERIES) {
    for (let i = 0; i < config.count; i += 1) {
      const point = pointsPool[cursor]
      const globalIndex = cursor
      cursor += 1

      const name = buildName(globalIndex, config)
      const sourceId = buildSourceId(config.prefix, i, name)
      const waterBodyType = pickRandom(config.waterBodyTypes)

      const pointPrelevementId = await upsertPointPrelevement({
        name,
        sourceId,
        waterBodyType,
        ewkt: point.ewkt
      })

      await ensurePointPrelevementZone(pointPrelevementId, zone.id)

      console.log(`OK ${sourceId}`)
    }
  }

  await prisma.declarantPointPrelevement.deleteMany({
    where: {
      sourceId: {
        startsWith: 'demo-dpp-'
      }
    }
  })

  for (const config of DEMO_DECLARANTS) {
    const user = await upsertDeclarantAccount(config)

    await syncDeclarantPointPrelevements({
      declarantUserId: user.id,
      pointPrefix: config.pointPrefix,
      usage: config.usage,
      sourceKey: config.key
    })

    console.log(`OK compte ${config.email}`)
  }

  await upsertInstructorAccount(zone.id)
}

main()
  .catch(error => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
