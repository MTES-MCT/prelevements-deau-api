import {createHash} from 'node:crypto'
import createHttpError from 'http-errors'
import * as Sentry from '@sentry/node'
import {prisma} from '../../db/prisma.js'
import {insertDeclarant} from '../models/declarant.js'
import {insertExploitation} from '../models/exploitation.js'
import {insertPointPrelevement} from '../models/point-prelevement.js'
import {validateCollectorPointCreation} from '../validation/collector-point-creation-validation.js'
import {isDatabaseWriteConflict} from '../util/database-write-conflict.js'
import {sendAccountCreationNotification} from './account-notifications.js'
import {exploitationAtDateWhere} from './exploitation-periods.js'
import {
  assertCollectorPointLocation,
  assertCollectorPointManagementEnabled
} from './collector-point-management.js'

const DUPLICATE_IDENTITY_MESSAGE = 'Cette identité ne peut pas être créée. Sélectionnez un préleveur déjà suivi ou contactez un administrateur pour vérifier son rattachement.'

function canonicalJson(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }

  return JSON.stringify(value)
}

function isRequestIdentityConflict(error) {
  return error?.code === 'P2002'
    && (error?.meta?.modelName === 'CollectorPointCreationRequest'
      || (Array.isArray(error?.meta?.target) && error.meta.target.includes('requestId')))
}

function databaseConstraintDetails(error) {
  const cause = error?.meta?.driverAdapterError?.cause
  return [error?.message, error?.meta?.database_error, error?.meta?.constraint,
    error?.cause?.message, cause?.constraint, cause?.originalMessage].join(' ')
}

function isPointNameConflict(error) {
  return /PointPrelevement_name_key/.test(databaseConstraintDetails(error))
    || (error?.code === 'P2002' && error?.meta?.modelName === 'PointPrelevement'
      && Array.isArray(error.meta.target) && error.meta.target.includes('name'))
}

function isIdentityConstraintConflict(error) {
  const details = databaseConstraintDetails(error)
  return /UserEmailIdentity_compatible_claims_check|User_email_not_alias|User_email_reserved|User_email_key|UserEmailAlias_email_key|UserEmailVerification_active_email_key/.test(details)
    || (error?.code === 'P2002' && ['User', 'UserEmailAlias', 'UserEmailVerification', 'UserEmailIdentity'].includes(error?.meta?.modelName)
      && Array.isArray(error.meta.target) && error.meta.target.includes('email'))
    || (error?.status === 409 && /cet email existe déjà/.test(error.message))
}

function reportNotificationError(_error, {phase}) {
  // Deliberately omit the original provider/driver message: it can contain
  // personal data, connection details or the email payload.
  Sentry.captureMessage('Échec de notification après création d’un point par un collecteur.', {
    level: 'error', tags: {component: 'collector-point-creation', phase}
  })
}

async function lockIdentity(client, identity) {
  await client.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 0))::text`
}

async function assertNewIdentityAvailable(client, preleveur, now) {
  const email = preleveur.email?.trim().toLowerCase()
  const siret = preleveur.siret?.trim()
  // Deterministic lock order avoids competing collector creations with the
  // same email/SIRET. Email identity triggers also protect every other writer.
  if (email) await lockIdentity(client, `collector-preleveur-email:${email}`)
  if (siret) await lockIdentity(client, `collector-preleveur-siret:${siret}`)

  if (email) {
    const [primary, alias, reservation, contact] = await Promise.all([
      client.user.findFirst({where: {email}, select: {id: true}}),
      client.userEmailAlias.findUnique({where: {email}, select: {id: true}}),
      client.userEmailVerification.findFirst({
        where: {email, status: {in: ['PENDING', 'SEND_FAILED']}, expiresAt: {gt: now}},
        select: {id: true}
      }),
      client.declarantContactEmail.findFirst({where: {email}, select: {id: true}})
    ])
    if (primary || alias || reservation || contact) throw createHttpError(409, DUPLICATE_IDENTITY_MESSAGE)
  }

  if (siret) {
    const duplicates = await client.$queryRaw`
      SELECT "userId" FROM "Declarant"
      WHERE regexp_replace(COALESCE(siret, ''), '\\s', '', 'g') = ${siret}
      LIMIT 1
    `
    if (duplicates.length > 0) throw createHttpError(409, DUPLICATE_IDENTITY_MESSAGE)
  }
}

async function assertFollowedPreleveur(client, collecteurUserId, preleveurId, now) {
  const preleveur = await client.declarant.findFirst({
    where: {
      userId: preleveurId,
      declarantRole: 'PRELEVEUR',
      user: {deletedAt: null, role: 'DECLARANT'},
      pointPrelevements: {some: {
        ...exploitationAtDateWhere(now),
        pointPrelevement: {deletedAt: null},
        collecteurs: {some: {collecteurUserId}}
      }}
    },
    select: {userId: true}
  })
  if (!preleveur) {
    throw createHttpError(403, 'Ce préleveur ne fait pas partie des préleveurs que vous suivez actuellement.')
  }
}

async function assertReplayAccessible(client, collecteurUserId, result, now) {
  const exploitation = await client.declarantPointPrelevement.findFirst({
    where: {
      id: result.exploitationId,
      ...exploitationAtDateWhere(now),
      declarant: {user: {deletedAt: null}},
      pointPrelevement: {id: result.point.id, deletedAt: null},
      collecteurs: {some: {collecteurUserId}}
    },
    select: {id: true}
  })
  if (!exploitation) throw createHttpError(403, 'Vous ne suivez plus ce point. Contactez un administrateur.')
}

function assertCurrentExploitation(exploitation, now) {
  if (!['EN_ACTIVITE', 'NON_RENSEIGNE'].includes(exploitation.status)
    || (exploitation.startDate && exploitation.startDate > now)
    || (exploitation.endDate && exploitation.endDate < now)) {
    throw createHttpError(400, 'L’exploitation créée doit être actuellement en activité : indiquez une période qui comprend aujourd’hui.')
  }
}

export async function getCollectorPointCreationPreleveurs(user, {client = prisma, now = new Date()} = {}) {
  await assertCollectorPointManagementEnabled(user, {client})
  const declarants = await client.declarant.findMany({
    where: {
      declarantRole: 'PRELEVEUR',
      user: {deletedAt: null, role: 'DECLARANT'},
      pointPrelevements: {some: {
        ...exploitationAtDateWhere(now),
        pointPrelevement: {deletedAt: null},
        collecteurs: {some: {collecteurUserId: user.id}}
      }}
    },
    select: {userId: true, socialReason: true, city: true, user: {select: {firstName: true, lastName: true}}},
    orderBy: {userId: 'asc'}
  })
  return declarants.map(({userId, user: identity, ...declarant}) => ({id: userId, ...identity, ...declarant}))
}

async function completeCreation(committed, value, {user, client, onCreated, notifyAccountCreation, onNotificationError}) {
  if (committed.replayed) return
  await onCreated({point: committed.point, preleveur: committed.preleveur, exploitation: committed.exploitation})
  if (!value.notifyAccountCreation) return
  try {
    await notifyAccountCreation(committed.preleveur.user ?? committed.preleveur, {role: 'DECLARANT'})
    committed.notificationStatus = 'sent'
  } catch (error) {
    committed.notificationStatus = 'failed'
    onNotificationError(error, {phase: 'send'})
  }

  try {
    await client.collectorPointCreationRequest.update({
      where: {collecteurUserId_requestId: {collecteurUserId: user.id, requestId: value.requestId}},
      data: {notificationStatus: committed.notificationStatus}
    })
  } catch (error) {
    committed.notificationStatus = 'pending'
    onNotificationError(error, {phase: 'status'})
  }
}

/** One transaction creates the whole graph. Notification deliberately runs
 * after commit; replaying a committed request never sends another email. */
export async function createCollectorPoint(payload, {
  user,
  client = prisma,
  now = new Date(),
  checkManagement = assertCollectorPointManagementEnabled,
  checkLocation = assertCollectorPointLocation,
  createPoint = insertPointPrelevement,
  createPreleveur = insertDeclarant,
  createExploitation = insertExploitation,
  notifyAccountCreation = sendAccountCreationNotification,
  onCreated = () => {},
  onNotificationError = reportNotificationError
} = {}) {
  const value = validateCollectorPointCreation(payload)
  const payloadHash = createHash('sha256').update(canonicalJson(value)).digest('hex')
  let committed
  // A transaction retry is safe: no mail or audit side effect occurs before
  // commit, and the idempotency record is committed with the created graph.
  /* eslint-disable no-await-in-loop */
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      committed = await client.$transaction(async tx => {
        const management = await checkManagement(user, {client: tx, lock: true})
        const key = {collecteurUserId: user.id, requestId: value.requestId}
        const existing = await tx.collectorPointCreationRequest.findUnique({
          where: {collecteurUserId_requestId: key}
        })
        if (existing) {
          if (existing.payloadHash !== payloadHash) {
            throw createHttpError(409, 'Cette demande a déjà été enregistrée avec un contenu différent. Rechargez le formulaire.')
          }

          await assertReplayAccessible(tx, user.id, existing.result, now)
          return {result: existing.result, notificationStatus: existing.notificationStatus, replayed: true}
        }

        assertCurrentExploitation(value.exploitation, now)
        await checkLocation(management, value.point.coordinates, value.point.waterBodyType, {client: tx})
        let preleveurId = value.preleveurId
        let preleveur = null
        if (preleveurId) {
          await assertFollowedPreleveur(tx, user.id, preleveurId, now)
        } else {
          await assertNewIdentityAvailable(tx, value.preleveur, now)
          preleveur = await createPreleveur(value.preleveur, {client: tx, createdByUserId: user.id})
          preleveurId = preleveur.userId ?? preleveur.id
        }

        const point = await createPoint(value.point, {client: tx})
        const exploitation = await createExploitation({
          ...value.exploitation,
          pointPrelevementId: point.id,
          declarantUserId: preleveurId,
          collecteurUserIds: [user.id]
        }, {client: tx})
        const result = JSON.parse(JSON.stringify({point, preleveurId, exploitationId: exploitation.id}))
        const notificationStatus = value.notifyAccountCreation ? 'pending' : 'not_requested'
        await tx.collectorPointCreationRequest.create({data: {...key, payloadHash, result, notificationStatus}})
        return {result, point, preleveur, exploitation, notificationStatus, replayed: false}
      }, {isolationLevel: 'Serializable', maxWait: 5000, timeout: 20000})
      break
    } catch (error) {
      if (isDatabaseWriteConflict(error) || isRequestIdentityConflict(error)) {
        if (attempt < 2) continue
        throw createHttpError(409, 'Des modifications simultanées ont eu lieu. Réessayez cette même demande.')
      }

      if (isPointNameConflict(error)) {
        throw createHttpError(409, 'Ce nom de point n’est pas disponible. Choisissez un autre nom.')
      }

      if (isIdentityConstraintConflict(error)) {
        throw createHttpError(409, DUPLICATE_IDENTITY_MESSAGE)
      }

      throw error
    }
  }
  /* eslint-enable no-await-in-loop */

  await completeCreation(committed, value, {user, client, onCreated, notifyAccountCreation, onNotificationError})

  return {...committed.result, notification: {status: committed.notificationStatus}, replayed: committed.replayed}
}
