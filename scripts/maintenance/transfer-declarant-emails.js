import '../../lib/config/env.js'

import {randomUUID} from 'node:crypto'
import process from 'node:process'
import {prisma} from '../../db/prisma.js'
import {
  TRANSFER_DECLARANT_EMAILS_USAGE,
  buildTransferDeclarantEmailsPlan,
  parseTransferDeclarantEmailsOptions
} from './transfer-declarant-emails-plan.js'

const TRANSACTION_OPTIONS = {
  isolationLevel: 'Serializable',
  maxWait: 10_000,
  timeout: 60_000
}

async function lockMaintenanceScope(transaction, options) {
  await transaction.$executeRawUnsafe('SET LOCAL lock_timeout = \'5s\'')
  await transaction.$executeRawUnsafe('SET LOCAL statement_timeout = \'60s\'')
  await transaction.$queryRaw`
    SELECT id
    FROM "User"
    WHERE id IN (${options.sourceId}::uuid, ${options.targetId}::uuid)
    ORDER BY id
    FOR UPDATE
  `
  await transaction.$queryRaw`
    SELECT id
    FROM "UserEmailAlias"
    WHERE "userId" IN (${options.sourceId}::uuid, ${options.targetId}::uuid)
    ORDER BY id
    FOR UPDATE
  `
}

async function getSnapshot(transaction, options) {
  const addresses = [options.primaryEmail, ...options.aliases]
  const users = await transaction.user.findMany({
    where: {id: {in: [options.sourceId, options.targetId]}},
    select: {
      id: true,
      email: true,
      role: true,
      firstName: true,
      lastName: true,
      deletedAt: true,
      declarant: {
        select: {
          userId: true,
          declarantRole: true,
          socialReason: true
        }
      },
      emailAliases: {
        select: {id: true, email: true},
        orderBy: {email: 'asc'}
      }
    },
    orderBy: {id: 'asc'}
  })
  const addressUsers = await transaction.user.findMany({
    where: {email: {in: addresses}},
    select: {id: true, email: true},
    orderBy: {id: 'asc'}
  })
  const addressAliases = await transaction.userEmailAlias.findMany({
    where: {email: {in: addresses}},
    select: {id: true, userId: true, email: true},
    orderBy: {id: 'asc'}
  })
  const sourceAuthTokens = await transaction.authToken.count({
    where: {userId: options.sourceId}
  })
  const sourceSessions = await transaction.sessionToken.count({
    where: {
      OR: [
        {userId: options.sourceId},
        {impersonatedByUserId: options.sourceId}
      ]
    }
  })
  const sourceServiceAccountTokens = await transaction.serviceAccountToken.count({
    where: {
      declarantUserId: options.sourceId,
      revokedAt: null
    }
  })
  const targetAuthTokens = await transaction.authToken.count({
    where: {userId: options.targetId}
  })
  const targetSessions = await transaction.sessionToken.count({
    where: {
      OR: [
        {userId: options.targetId},
        {impersonatedByUserId: options.targetId}
      ]
    }
  })

  return {
    users,
    addressUsers,
    addressAliases,
    credentials: {
      source: {
        authTokens: sourceAuthTokens,
        sessions: sourceSessions,
        serviceAccountTokens: sourceServiceAccountTokens
      },
      targetEmailAccess: {
        authTokens: targetAuthTokens,
        sessions: targetSessions
      }
    }
  }
}

async function transferEmails(transaction, plan, options) {
  if (plan.emailAction === 'NONE') {
    return 0
  }

  if (plan.emailAction === 'TRANSFER') {
    await transaction.user.update({
      where: {id: options.sourceId},
      data: {email: null}
    })

    const aliases = await transaction.userEmailAlias.updateMany({
      where: {
        id: {in: plan.aliasIds},
        userId: options.sourceId
      },
      data: {userId: options.targetId}
    })

    if (aliases.count !== options.aliases.length) {
      throw new Error(`Nombre d’alias transférés inattendu : ${aliases.count}/${options.aliases.length}`)
    }

    await transaction.user.update({
      where: {id: options.targetId},
      data: {email: options.primaryEmail}
    })

    return aliases.count
  }

  if (plan.emailAction === 'ASSIGN') {
    const aliases = await transaction.userEmailAlias.createMany({
      data: options.aliases.map(email => ({
        id: randomUUID(),
        userId: options.targetId,
        email
      }))
    })

    if (aliases.count !== options.aliases.length) {
      throw new Error(`Nombre d’alias recréés inattendu : ${aliases.count}/${options.aliases.length}`)
    }

    await transaction.user.update({
      where: {id: options.targetId},
      data: {email: options.primaryEmail}
    })

    return aliases.count
  }

  await transaction.user.update({
    where: {id: options.targetId},
    data: {email: null}
  })

  const aliases = await transaction.userEmailAlias.deleteMany({
    where: {
      id: {in: plan.aliasIds},
      userId: options.targetId
    }
  })

  if (aliases.count !== options.aliases.length) {
    throw new Error(`Nombre d’alias libérés inattendu : ${aliases.count}/${options.aliases.length}`)
  }

  return aliases.count
}

async function revokeCredentials(transaction, plan, options) {
  if (plan.credentialsAction === 'NONE') {
    return {
      authTokens: 0,
      sessions: 0,
      serviceAccountTokens: 0
    }
  }

  const credentialUserId = plan.credentialsOwner === 'TARGET'
    ? options.targetId
    : options.sourceId
  const revokedAt = new Date()
  const authTokens = await transaction.authToken.deleteMany({
    where: {userId: credentialUserId}
  })
  const sessions = await transaction.sessionToken.deleteMany({
    where: {
      OR: [
        {userId: credentialUserId},
        {impersonatedByUserId: credentialUserId}
      ]
    }
  })
  const serviceAccountTokens = plan.credentialsOwner === 'SOURCE'
    ? await transaction.serviceAccountToken.updateMany({
      where: {
        declarantUserId: options.sourceId,
        revokedAt: null
      },
      data: {revokedAt}
    })
    : {count: 0}

  return {
    authTokens: authTokens.count,
    sessions: sessions.count,
    serviceAccountTokens: serviceAccountTokens.count
  }
}

async function execute(options) {
  return prisma.$transaction(async transaction => {
    await lockMaintenanceScope(transaction, options)

    const before = await getSnapshot(transaction, options)
    const plan = buildTransferDeclarantEmailsPlan(before, options)

    if (!options.apply || plan.noOp) {
      return {before, after: before, plan, changedAliases: 0, revokedCredentials: null}
    }

    const changedAliases = await transferEmails(transaction, plan, options)
    const revokedCredentials = await revokeCredentials(transaction, plan, options)
    const after = await getSnapshot(transaction, options)
    const postcondition = buildTransferDeclarantEmailsPlan(after, options)

    if (!postcondition.noOp) {
      throw new Error('La postcondition attendue n’est pas satisfaite ; transaction annulée.')
    }

    return {before, after, plan, changedAliases, revokedCredentials}
  }, TRANSACTION_OPTIONS)
}

function getUser(snapshot, id) {
  return snapshot.users.find(user => user.id === id)
}

function getUserLabel(user) {
  return user.declarant?.socialReason
    || [user.firstName, user.lastName].filter(Boolean).join(' ')
    || user.id
}

function printSummary(result, options) {
  const source = getUser(result.before, options.sourceId)
  const target = getUser(result.before, options.targetId)
  const direction = options.rollback ? 'ROLLBACK' : 'TRANSFERT'
  const execution = options.apply ? 'APPLICATION' : 'SIMULATION'

  console.log(`\n=== ${direction} DES EMAILS D’UN DÉCLARANT — ${execution} ===`)
  console.log(`Source supprimée : ${getUserLabel(source)} (${source.id})`)
  console.log(`Cible active      : ${getUserLabel(target)} (${target.id})`)
  console.log(`Email principal   : ${options.primaryEmail}`)
  console.log(`Alias (${options.aliases.length})       : ${options.aliases.join(', ')}`)
  const detectedStateLabels = {
    SOURCE: 'adresses sur la source',
    TARGET: 'adresses sur la cible',
    RELEASED: 'adresses libérées par le nettoyage'
  }
  console.log(`État détecté      : ${detectedStateLabels[result.plan.detectedState]}`)
  console.log('Credentials source: '
    + `${result.before.credentials.source.authTokens} magic link(s), `
    + `${result.before.credentials.source.sessions} session(s), `
    + `${result.before.credentials.source.serviceAccountTokens} token(s) de compte de service actif(s)`)

  if (options.rollback) {
    console.log('Accès email cible : '
      + `${result.before.credentials.targetEmailAccess.authTokens} magic link(s), `
      + `${result.before.credentials.targetEmailAccess.sessions} session(s)`)
  }

  if (result.plan.noOp) {
    console.log('\nAucune action nécessaire : l’état demandé est déjà atteint.')
    return
  }

  if (!options.apply) {
    const action = options.rollback
      ? 'Les adresses seraient libérées et les accès email de la cible invalidés.'
      : 'Les adresses seraient transférées et les credentials source révoqués.'
    console.log(`\n${action}`)
    console.log('Simulation uniquement : aucune donnée modifiée. Ajouter --apply pour exécuter.')
    return
  }

  console.log(`\nAlias ${options.rollback ? 'libérés' : 'transférés'} : ${result.changedAliases}`)

  if (options.rollback) {
    console.log('Rollback appliqué. Les adresses ont été libérées et les accès email de la cible invalidés ; aucun accès n’a été restauré sur la source supprimée.')
    return
  }

  console.log('Credentials révoqués : '
    + `${result.revokedCredentials.authTokens} magic link(s), `
    + `${result.revokedCredentials.sessions} session(s), `
    + `${result.revokedCredentials.serviceAccountTokens} token(s) de compte de service`)
  console.log('Transfert appliqué et postconditions vérifiées.')
}

async function main() {
  const options = parseTransferDeclarantEmailsOptions(process.argv.slice(2))

  if (options.help) {
    console.log(TRANSFER_DECLARANT_EMAILS_USAGE)
    return
  }

  if (options.rollback && options.apply) {
    console.warn('Attention : rollback explicite demandé avec --rollback --apply.')
  }

  const result = await execute(options)
  printSummary(result, options)
}

try {
  await main()
} catch (error) {
  console.error(`\nErreur : ${error.message}`)
  console.error(`\n${TRANSFER_DECLARANT_EMAILS_USAGE}`)
  process.exitCode = 1
} finally {
  await prisma.$disconnect()
}
