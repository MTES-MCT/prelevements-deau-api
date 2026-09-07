import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'

import {
  assertConnectedDemoAdminDatabase,
  validateDemoAdminDatabaseUrl
} from './database-target.js'

const DEMO_ENVIRONMENT = 'demo'
const DEMO_INSTRUCTOR_EMAIL = 'agent@demo.fr'
const DEMO_INSTRUCTOR_SOURCE_ID = 'demo-instructor-agent'
const DEMO_SERVICE_ACCOUNT_SOURCE_ID = 'demo-orchestration-service'
const DEMO_ZONE_CODE = 'sage-SAGE04025'
const RESET_CONFIRMATION = 'RESET_DEMO'
const EXPECTED_DEMO_DATABASE_NAME = 'prelevements_demo'
const EXPECTED_DEMO_APPLICATION_USER = 'prelevements_demo_app'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDirectory, '../..')

function printUsage() {
  console.log(`Usage:
  APP_ENV=demo npm run bootstrap:demo

Reset manuel, réservé à la base demo :
  APP_ENV=demo DEMO_ALLOW_RESET=${RESET_CONFIRMATION} \\
    DEMO_DATABASE_URL_SHA256=<sha256 de DATABASE_URL> \\
    npm run bootstrap:demo -- --reset --confirm-reset=${RESET_CONFIRMATION}

Variables requises dans les deux modes :
  DATABASE_URL
  DEMO_DATABASE_NAME
  DEMO_DATABASE_APP_USER
  DEMO_SERVICE_ACCOUNT_CLIENT_ID
  DEMO_SERVICE_ACCOUNT_CLIENT_SECRET`)
}

function parseOptions(arguments_) {
  const options = {
    help: false,
    reset: false,
    resetConfirmation: null
  }

  for (const argument of arguments_) {
    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }

    if (argument === '--reset') {
      options.reset = true
      continue
    }

    if (argument.startsWith('--confirm-reset=')) {
      options.resetConfirmation = argument.slice('--confirm-reset='.length)
      continue
    }

    throw new Error(`Argument inconnu : ${argument}`)
  }

  return options
}

function getRequiredEnvironmentVariable(name) {
  const value = process.env[name]?.trim()

  if (!value) {
    throw new Error(`${name} est requis.`)
  }

  return value
}

function validateEnvironmentGuard() {
  if (process.env.APP_ENV !== DEMO_ENVIRONMENT) {
    throw new Error('Refus : APP_ENV doit être exactement "demo".')
  }
}

function validateServiceAccountCredential(clientId, clientSecret) {
  if (!clientId.startsWith('sa_')) {
    throw new Error('DEMO_SERVICE_ACCOUNT_CLIENT_ID doit utiliser le préfixe sa_.')
  }

  if (clientSecret.length < 32) {
    throw new Error('DEMO_SERVICE_ACCOUNT_CLIENT_SECRET doit contenir au moins 32 caractères.')
  }
}

function quoteDatabaseIdentifier(value, variableName) {
  if (!/^[a-z][a-z\d_]{0,62}$/.test(value)) {
    throw new Error(`${variableName} doit être un identifiant PostgreSQL minuscule sûr.`)
  }

  return `"${value}"`
}

function validateResetGuards(options, databaseUrl) {
  if (!options.reset) {
    return
  }

  if (options.resetConfirmation !== RESET_CONFIRMATION) {
    throw new Error(`Refus du reset : ajouter --confirm-reset=${RESET_CONFIRMATION}.`)
  }

  if (process.env.DEMO_ALLOW_RESET !== RESET_CONFIRMATION) {
    throw new Error(`Refus du reset : DEMO_ALLOW_RESET doit valoir ${RESET_CONFIRMATION}.`)
  }

  const expectedDatabaseHash = getRequiredEnvironmentVariable('DEMO_DATABASE_URL_SHA256').toLowerCase()
  if (!/^[\da-f]{64}$/.test(expectedDatabaseHash)) {
    throw new Error('DEMO_DATABASE_URL_SHA256 doit être une empreinte SHA-256 hexadécimale.')
  }

  const actualDatabaseHash = createHash('sha256').update(databaseUrl).digest('hex')
  if (actualDatabaseHash !== expectedDatabaseHash) {
    throw new Error('Refus du reset : l’empreinte de DATABASE_URL ne correspond pas à la base demo autorisée.')
  }
}

async function assertNoBusinessData(prisma) {
  const [declarationCount, declarantCount, pointCount] = await Promise.all([
    prisma.declaration.count(),
    prisma.declarant.count(),
    prisma.pointPrelevement.count()
  ])

  if (declarationCount !== 0 || declarantCount !== 0 || pointCount !== 0) {
    throw new Error(
      `La base demo doit être vide : ${declarationCount} déclaration(s), `
      + `${declarantCount} déclarant(s), ${pointCount} point(s). `
      + 'Utiliser le reset manuel explicitement gardé si cet effacement est intentionnel.'
    )
  }
}

async function resetBusinessData(prisma) {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "Declaration",
      "PointPrelevement",
      "ServiceAccount",
      "User"
    RESTART IDENTITY CASCADE
  `)

  console.log('Reset manuel demo terminé.')
}

async function grantApplicationRole(prisma, {databaseName, applicationUser}) {
  const quotedDatabaseName = quoteDatabaseIdentifier(databaseName, 'DEMO_DATABASE_NAME')
  const quotedApplicationUser = quoteDatabaseIdentifier(
    applicationUser,
    'DEMO_DATABASE_APP_USER'
  )
  const [currentDatabase] = await prisma.$queryRaw`SELECT current_database() AS name`

  if (currentDatabase?.name !== databaseName) {
    throw new Error(
      `Refus : DATABASE_URL cible ${currentDatabase?.name ?? 'une base inconnue'} au lieu de ${databaseName}.`
    )
  }

  await prisma.$executeRawUnsafe(
    `GRANT CONNECT ON DATABASE ${quotedDatabaseName} TO ${quotedApplicationUser}`
  )
  await prisma.$executeRawUnsafe(
    `GRANT USAGE ON SCHEMA public TO ${quotedApplicationUser}`
  )
  await prisma.$executeRawUnsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${quotedApplicationUser}`
  )
  await prisma.$executeRawUnsafe(
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${quotedApplicationUser}`
  )
  await prisma.$executeRawUnsafe(
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${quotedApplicationUser}`
  )
  await prisma.$executeRawUnsafe(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quotedApplicationUser}`
  )
  await prisma.$executeRawUnsafe(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${quotedApplicationUser}`
  )
  await prisma.$executeRawUnsafe(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${quotedApplicationUser}`
  )
}

function importZones() {
  const childEnvironment = {...process.env}
  delete childEnvironment.DEMO_SERVICE_ACCOUNT_CLIENT_SECRET

  const result = spawnSync(process.execPath, ['scripts/import-zones.js'], {
    cwd: projectRoot,
    env: childEnvironment,
    stdio: 'inherit'
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(`L’import des zones a échoué avec le statut ${result.status}.`)
  }
}

async function validateReferences(prisma) {
  const [waterUseCount, zone] = await Promise.all([
    prisma.sandreWaterUse.count(),
    prisma.zone.findUnique({
      where: {
        type_code: {
          type: 'SAGE',
          code: DEMO_ZONE_CODE
        }
      },
      select: {id: true}
    })
  ])

  if (waterUseCount === 0) {
    throw new Error('Le référentiel des usages SANDRE est absent ; vérifier les migrations.')
  }

  if (!zone) {
    throw new Error(`La zone ${DEMO_ZONE_CODE} est absente après l’import.`)
  }

  return zone
}

async function upsertInstructor(prisma, zoneId, zonePermissionCodes) {
  const user = await prisma.user.upsert({
    where: {email: DEMO_INSTRUCTOR_EMAIL},
    create: {
      email: DEMO_INSTRUCTOR_EMAIL,
      role: 'INSTRUCTOR',
      firstName: 'Agent',
      lastName: 'Demo',
      instructor: {
        create: {sourceId: DEMO_INSTRUCTOR_SOURCE_ID}
      }
    },
    update: {
      role: 'INSTRUCTOR',
      firstName: 'Agent',
      lastName: 'Demo',
      deletedAt: null,
      instructor: {
        upsert: {
          create: {sourceId: DEMO_INSTRUCTOR_SOURCE_ID},
          update: {sourceId: DEMO_INSTRUCTOR_SOURCE_ID}
        }
      }
    },
    select: {id: true}
  })

  await prisma.instructorZone.upsert({
    where: {
      instructorUserId_zoneId: {
        instructorUserId: user.id,
        zoneId
      }
    },
    create: {
      instructorUserId: user.id,
      zoneId,
      isAdmin: true,
      startDate: new Date('2020-01-01T00:00:00.000Z'),
      permissions: {
        createMany: {
          data: zonePermissionCodes.map(permission => ({permission}))
        }
      }
    },
    update: {
      isAdmin: true,
      startDate: new Date('2020-01-01T00:00:00.000Z'),
      endDate: null,
      permissions: {
        deleteMany: {},
        createMany: {
          data: zonePermissionCodes.map(permission => ({permission}))
        }
      }
    }
  })
}

async function upsertServiceAccount(prisma, {clientId, clientSecret, hashSecret, verifySecret}) {
  const serviceAccount = await prisma.serviceAccount.upsert({
    where: {sourceId: DEMO_SERVICE_ACCOUNT_SOURCE_ID},
    create: {
      sourceId: DEMO_SERVICE_ACCOUNT_SOURCE_ID,
      name: 'Orchestration Demo',
      description: 'Compte de service injecté pour l’orchestrateur demo',
      isActive: true
    },
    update: {
      name: 'Orchestration Demo',
      description: 'Compte de service injecté pour l’orchestrateur demo',
      isActive: true,
      deletedAt: null
    },
    select: {id: true}
  })

  const existingCredential = await prisma.serviceAccountCredential.findUnique({
    where: {keyId: clientId}
  })

  if (existingCredential && existingCredential.serviceAccountId !== serviceAccount.id) {
    throw new Error('Le client ID injecté appartient déjà à un autre compte de service.')
  }

  if (!existingCredential) {
    await prisma.serviceAccountCredential.create({
      data: {
        serviceAccountId: serviceAccount.id,
        keyId: clientId,
        secretHash: hashSecret(clientSecret),
        name: 'demo-injected'
      }
    })
  } else if (
    existingCredential.revokedAt
    || existingCredential.expiresAt
    || !verifySecret(clientSecret, existingCredential.secretHash)
  ) {
    await prisma.serviceAccountCredential.update({
      where: {id: existingCredential.id},
      data: {
        secretHash: hashSecret(clientSecret),
        name: 'demo-injected',
        expiresAt: null,
        revokedAt: null
      }
    })
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  if (options.help) {
    printUsage()
    return
  }

  validateEnvironmentGuard()
  await import('../../lib/config/env.js')

  const databaseUrl = getRequiredEnvironmentVariable('DATABASE_URL')
  const databaseName = getRequiredEnvironmentVariable('DEMO_DATABASE_NAME')
  const applicationUser = getRequiredEnvironmentVariable('DEMO_DATABASE_APP_USER')
  const clientId = getRequiredEnvironmentVariable('DEMO_SERVICE_ACCOUNT_CLIENT_ID')
  const clientSecret = getRequiredEnvironmentVariable('DEMO_SERVICE_ACCOUNT_CLIENT_SECRET')

  validateDemoAdminDatabaseUrl(databaseUrl)
  validateServiceAccountCredential(clientId, clientSecret)
  validateResetGuards(options, databaseUrl)

  if (databaseName !== EXPECTED_DEMO_DATABASE_NAME) {
    throw new Error(`Refus : DEMO_DATABASE_NAME doit valoir ${EXPECTED_DEMO_DATABASE_NAME}.`)
  }

  if (applicationUser !== EXPECTED_DEMO_APPLICATION_USER) {
    throw new Error(`Refus : DEMO_DATABASE_APP_USER doit valoir ${EXPECTED_DEMO_APPLICATION_USER}.`)
  }

  const [{prisma}, {ZONE_PERMISSION_CODES}, {hashSecret, verifySecret}] = await Promise.all([
    import('../../db/prisma.js'),
    import('../../lib/constants/zone-permissions.js'),
    import('../../lib/util/secrets.js')
  ])

  try {
    await assertConnectedDemoAdminDatabase(prisma)

    if (options.reset) {
      await resetBusinessData(prisma)
    }

    await assertNoBusinessData(prisma)
    await grantApplicationRole(prisma, {databaseName, applicationUser})
    importZones()

    const zone = await validateReferences(prisma)
    await prisma.$transaction(async transaction => {
      await upsertInstructor(transaction, zone.id, ZONE_PERMISSION_CODES)
      await upsertServiceAccount(transaction, {
        clientId,
        clientSecret,
        hashSecret,
        verifySecret
      })
    })
    await assertNoBusinessData(prisma)

    console.log(`Compte instructeur ${DEMO_INSTRUCTOR_EMAIL} configuré sur ${DEMO_ZONE_CODE}.`)
    console.log('Compte de service demo configuré ; secret non affiché.')
    console.log('Bootstrap demo terminé : 0 déclarant, 0 point, 0 déclaration.')
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(error => {
  console.error(error?.message ?? error)
  process.exit(1)
})
