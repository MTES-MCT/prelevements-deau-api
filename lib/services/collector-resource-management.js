/* eslint-disable no-await-in-loop -- Related records are locked and audited in stable order within a bounded transaction. */
import {createHash} from 'node:crypto'
import Joi from 'joi'
import createHttpError from 'http-errors'
import * as Sentry from '@sentry/node'
import {prisma} from '../../db/prisma.js'
import {insertDeclarant} from '../models/declarant.js'
import {insertExploitation, updateExploitationById} from '../models/exploitation.js'
import {decoratePointWithCoords} from '../models/point-prelevement.js'
import {replaceDeclarantContactEmails} from '../models/declarant-contact-email.js'
import {isDatabaseWriteConflict} from '../util/database-write-conflict.js'
import {
  COLLECTOR_CONTACT_FIELDS, COLLECTOR_EXPLOITATION_FIELDS,
  validateCollectorExploitationCreation, validateCollectorExploitationUpdate, validateCollectorContactDetails
} from '../validation/collector-resource-management-validation.js'
import {assertCollectorPointManagementEnabled, assertCollectorPointLocation} from './collector-point-management.js'
import {assertFollowedPreleveur, assertNewIdentityAvailable} from './collector-point-creation.js'
import {getCollectorExploitationMeters, saveCollectorExploitationMeters} from './collector-point-meters.js'
import {prepareCollectorCampaignParticipation, appendCollectorCampaignResponse} from './collector-campaign-participation.js'
import {exploitationAtDateWhere, OPERATIONAL_EXPLOITATION_STATUSES} from './exploitation-periods.js'
import {serializeExploitationUsageFields} from './exploitation-usages.js'
import {campaignDate, isCampaignOpen} from './collection-campaigns.js'
import {sendAccountCreationNotification} from './account-notifications.js'
import {collectorDate, collectorDay} from './collector-calendar.js'
import {campaignMeterReadings} from './campaign-readings.js'

const transactionOptions = {isolationLevel: 'Serializable', maxWait: 5000, timeout: 20000}
const activePreleveur = {declarantRole: 'PRELEVEUR', user: {role: 'DECLARANT', deletedAt: null}}
const contactSelect = Object.fromEntries(COLLECTOR_CONTACT_FIELDS.map(field => [field, true]))
const exploitationSelect = {
  id: true, declarantUserId: true, pointPrelevementId: true, updatedAt: true,
  usageId: true, status: true, startDate: true, endDate: true, countingCode: true, abandonReason: true,
  usage: true, secondaryUsageLinks: {include: {usage: true}, orderBy: {usageId: 'asc'}},
  pointPrelevement: {select: {id: true, name: true, usageName: true, deletedAt: true}},
  declarant: {select: {userId: true, socialReason: true, user: {select: {firstName: true, lastName: true}}}}
}

function canonical(value) {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

export function collectorResourceVersion(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value ?? null))).digest('hex')
}

function validateId(id) {
  if (Joi.string().uuid().required().validate(id).error) throw createHttpError(400, 'Identifiant invalide.')
}

function conflict(code, message, additions = {}) {
  const error = createHttpError(409, message)
  error.data = {code, ...additions}
  return error
}

function translateConflict(error) {
  if (isDatabaseWriteConflict(error)) throw conflict('COLLECTOR_RESOURCE_CHANGED', 'Les droits ou les données ont changé. Rechargez la fiche avant de réessayer.')
  throw error
}

function assertVersion(actual, expected) {
  if (actual !== expected) throw conflict('COLLECTOR_RESOURCE_CHANGED', 'Cette fiche a été modifiée depuis son ouverture. Rechargez-la avant de réessayer.')
}

export function isCurrentCollectorExploitation(exploitation, now = new Date()) {
  const today = collectorDate(now)
  return OPERATIONAL_EXPLOITATION_STATUSES.includes(exploitation.status)
    && (!exploitation.startDate || campaignDate(exploitation.startDate) <= today)
    && (!exploitation.endDate || campaignDate(exploitation.endDate) >= today)
}

async function readExploitation(client, user, exploitationId) {
  const record = await client.declarantPointPrelevement.findFirst({where: {
    id: exploitationId, declarant: activePreleveur, pointPrelevement: {deletedAt: null},
    collecteurs: {some: {collecteurUserId: user.id}}
  }, select: exploitationSelect})
  if (!record) throw createHttpError(404, 'Exploitation introuvable dans votre périmètre.')
  return record
}

async function exploitationForm(client, user, exploitationId, now) {
  const record = await readExploitation(client, user, exploitationId)
  const meters = await getCollectorExploitationMeters(client, exploitationId)
  const canEdit = isCurrentCollectorExploitation(record, now)
  return {exploitation: {...serializeExploitationUsageFields(record),
    secondaryUsageIds: record.secondaryUsageLinks.map(link => link.usageId)}, meters,
  version: collectorResourceVersion({record, meters}),
  capabilities: {canEdit, canAddMeter: canEdit, editableFields: canEdit ? [...COLLECTOR_EXPLOITATION_FIELDS] : []}}
}

export async function getCollectorExploitationForm(exploitationId, {user, client = prisma, now = new Date()} = {}) {
  validateId(exploitationId)
  await assertCollectorPointManagementEnabled(user, {client})
  return exploitationForm(client, user, exploitationId, now)
}

async function lockExploitationAndCampaigns(tx, user, exploitationId) {
  await readExploitation(tx, user, exploitationId)
  const campaigns = await tx.collectionCampaign.findMany({where: {responses: {some: {exploitationId}}}, select: {id: true}, orderBy: {id: 'asc'}})
  for (const campaign of campaigns) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('collection-campaign'), hashtext(${campaign.id}))`
    await tx.$queryRaw`SELECT id FROM "CollectionCampaign" WHERE id = ${campaign.id}::uuid FOR UPDATE`
  }
  await tx.$queryRaw`
    SELECT e.id FROM "DeclarantPointPrelevement" e
    JOIN "DeclarantCollecteurExploitation" link ON link."exploitationId" = e.id
    WHERE e.id = ${exploitationId}::uuid AND link."collecteurUserId" = ${user.id}::uuid FOR UPDATE OF e FOR SHARE OF link
  `
}

export function pendingCollectorCampaignResponses(responses, now = new Date()) {
  return responses.filter(row => isCampaignOpen(row.campaign, now)
    && (!row.firstSubmittedAt || (row.draftData !== null && row.draftData !== undefined
      && collectorResourceVersion(row.draftData) !== collectorResourceVersion(row.submittedData))))
    .map(row => ({campaignId: row.campaignId, responseId: row.id, campaignName: row.campaign.name,
      href: `/campagnes/${row.campaignId}/reponses/${row.id}`}))
}

async function assertCanClose(tx, existing, next, user, now) {
  if (isCurrentCollectorExploitation(next, now)) return
  const responses = await tx.collectionResponse.findMany({where: {exploitationId: existing.id},
    select: {id: true, campaignId: true, firstSubmittedAt: true, draftData: true, submittedData: true,
      campaign: {select: {id: true, name: true, status: true, opensOn: true, closesOn: true, closedAt: true, collecteurUserId: true}}}})
  const pending = pendingCollectorCampaignResponses(responses, now)
  const ownCampaignIds = new Set(responses.filter(row => row.campaign.collecteurUserId === user.id).map(row => row.campaignId))
  if (pending.length) throw conflict('COLLECTOR_EXPLOITATION_PENDING_CAMPAIGNS',
    'Terminez et transmettez les formulaires encore attendus dans les campagnes ouvertes avant de clôturer cette exploitation.',
    {pendingCampaignResponses: pending.filter(row => ownCampaignIds.has(row.campaignId)),
      otherPendingCampaigns: pending.some(row => !ownCampaignIds.has(row.campaignId))})
}

async function assertHistoryWithinPeriod(tx, existing, next) {
  const reducesStart = next.startDate && (!existing.startDate || next.startDate > existing.startDate)
  const reducesEnd = next.endDate && (!existing.endDate || next.endDate < existing.endDate)
  if (!reducesStart && !reducesEnd) return
  // These required DATE columns contain inclusive calendar bounds, including
  // for published METER data. Comparing timestamps would change that contract.
  const outside = [...(reducesStart ? [{minDate: {lt: next.startDate}}] : []), ...(reducesEnd ? [{maxDate: {gt: next.endDate}}] : [])]
  const history = await tx.chunk.findFirst({where: {
    AND: [{OR: [{exploitationId: existing.id}, {exploitationId: null, preleveurUserId: existing.declarantUserId, pointPrelevementId: existing.pointPrelevementId}]},
      {OR: outside}]
  }, select: {id: true}})
  // A submitted questionnaire may precede publication of its chunks. Keep its
  // dated observations inside the period even while publication is pending.
  const responses = history ? [] : await tx.collectionResponse.findMany({where: {exploitationId: existing.id, firstSubmittedAt: {not: null}},
    select: {submittedData: true, campaign: {select: {type: true}}}})
  const excludedResponse = responses.some(response => {
    if (response.campaign.type !== 'DROPT_INDEX_NEEDS_2026_2027') return true
    return (response.submittedData?.meters ?? []).some(meter => campaignMeterReadings({offSeason: {}, season: {}, ...meter})
      .some(row => row.value !== null && row.value !== undefined && row.value !== ''
        && ((reducesStart && row.date < campaignDate(next.startDate)) || (reducesEnd && row.date > campaignDate(next.endDate)))))
  })
  if (history || excludedResponse) throw conflict('COLLECTOR_EXPLOITATION_HISTORY_PERIOD',
    'Cette période exclurait des données déjà déclarées. Un administrateur doit vérifier l’historique avant de la modifier.')
}

export async function updateCollectorExploitationForm(exploitationId, payload, {
  user, client = prisma, now = new Date(), onUpdated = () => {}, updateExploitation = updateExploitationById,
  saveMeters = saveCollectorExploitationMeters
} = {}) {
  validateId(exploitationId)
  const value = validateCollectorExploitationUpdate(payload)
  let committed
  try {
    committed = await client.$transaction(async tx => {
      await assertCollectorPointManagementEnabled(user, {client: tx, lock: true})
      await lockExploitationAndCampaigns(tx, user, exploitationId)
      const before = await exploitationForm(tx, user, exploitationId, now)
      if (!before.capabilities.canEdit) throw createHttpError(403, 'Cette exploitation n’est plus en activité. Sa correction est réservée à un administrateur.')
      assertVersion(before.version, value.version)
      const existing = before.exploitation
      const next = {...existing, ...value.changes}
      if (next.startDate && next.endDate && next.startDate > next.endDate) throw createHttpError(400, 'La date de début doit précéder la date de fin.')
      await assertCanClose(tx, existing, next, user, now)
      await assertHistoryWithinPeriod(tx, existing, next)
      const changes = {...value.changes}
      if (next.status !== 'ABANDONNEE') changes.abandonReason = null
      const updated = await updateExploitation(exploitationId, changes, {client: tx,
        expectedUsageId: existing.usageId, expectedSecondaryUsageIds: existing.secondaryUsageIds,
        expectedCountingCode: existing.countingCode})
      const mutations = []
      if (value.meters?.length) {
        const result = await saveMeters(tx, {exploitation: updated, meters: value.meters, actorId: user.id})
        mutations.push(...result.mutations)
      }
      const form = await exploitationForm(tx, user, exploitationId, now)
      // Compare the same projection on both sides. The model's expanded result
      // also contains delegations/connectors that this form cannot modify.
      mutations.unshift({operation: 'UPDATE', entityType: 'EXPLOITATION', entityId: exploitationId,
        before: existing, after: form.exploitation})
      return {form, mutations}
    }, transactionOptions)
  } catch (error) { translateConflict(error) }
  await onUpdated(committed.mutations)
  return committed.form
}

async function contactForm(client, user, preleveurId, now) {
  await assertFollowedPreleveur(client, user.id, preleveurId, now)
  const record = await client.declarant.findFirst({where: {userId: preleveurId, ...activePreleveur}, select: {
    userId: true, user: {select: {updatedAt: true}}, ...contactSelect,
    contactEmails: {select: {id: true, email: true, isPrimary: true, sourceId: true, updatedAt: true}, orderBy: {id: 'asc'}}
  }})
  if (!record) throw createHttpError(404, 'Préleveur introuvable dans votre périmètre.')
  const details = {...Object.fromEntries(COLLECTOR_CONTACT_FIELDS.map(field => [field, record[field]])),
    contactEmails: record.contactEmails.map(({email, isPrimary}) => ({email, isPrimary}))}
  return {record, form: {preleveurId, details, version: collectorResourceVersion(record),
    capabilities: {canEdit: true, sharedProfile: true, editableFields: [...COLLECTOR_CONTACT_FIELDS, 'contactEmails']}}}
}

export async function getCollectorPreleveurContactDetails(preleveurId, {user, client = prisma, now = new Date()} = {}) {
  validateId(preleveurId)
  await assertCollectorPointManagementEnabled(user, {client})
  return (await contactForm(client, user, preleveurId, now)).form
}

export async function updateCollectorPreleveurContactDetails(preleveurId, payload, {
  user, client = prisma, now = new Date(), onUpdated = () => {}, replaceContacts = replaceDeclarantContactEmails
} = {}) {
  validateId(preleveurId)
  const value = validateCollectorContactDetails(payload)
  let committed
  try {
    committed = await client.$transaction(async tx => {
      await assertCollectorPointManagementEnabled(user, {client: tx, lock: true})
      await assertFollowedPreleveur(tx, user.id, preleveurId, now)
      await tx.$queryRaw`SELECT d."userId" FROM "Declarant" d JOIN "User" u ON u.id = d."userId" WHERE d."userId" = ${preleveurId}::uuid FOR UPDATE OF d, u`
      const before = await contactForm(tx, user, preleveurId, now)
      assertVersion(before.form.version, value.version)
      const {contactEmails, ...details} = value.details
      // Touching the owner version also protects an empty/unchanged contact list
      // from a concurrent self-profile update; email identities are never edited.
      if (Object.keys(details).length) await tx.declarant.update({where: {userId: preleveurId}, data: details})
      await tx.user.update({where: {id: preleveurId}, data: {
        updatedAt: new Date(Math.max(now.getTime(), new Date(before.record.user.updatedAt).getTime() + 1))}})
      if (contactEmails) await replaceContacts(preleveurId, contactEmails, {client: tx})
      const after = await contactForm(tx, user, preleveurId, now)
      const mutations = [{operation: 'UPDATE', entityType: 'DECLARANT', entityId: preleveurId,
        before: before.form.details, after: after.form.details}]
      const oldContacts = new Map(before.record.contactEmails.map(row => [row.id, row]))
      const newContacts = new Map(after.record.contactEmails.map(row => [row.id, row]))
      for (const id of new Set([...oldContacts.keys(), ...newContacts.keys()])) {
        const b = oldContacts.get(id)
        const a = newContacts.get(id)
        if (collectorResourceVersion(b ?? null) !== collectorResourceVersion(a ?? null)) mutations.push({
          operation: !b ? 'CREATE' : !a ? 'DELETE' : 'UPDATE', entityType: 'DECLARANT_CONTACT_EMAIL', entityId: id,
          before: b ? {...b, declarantUserId: preleveurId} : null, after: a ? {...a, declarantUserId: preleveurId} : null,
          scopes: [{resourceType: 'DECLARANT', resourceId: preleveurId}]
        })
      }
      return {form: after.form, mutations}
    }, transactionOptions)
  } catch (error) { translateConflict(error) }
  await onUpdated(committed.mutations)
  return committed.form
}

async function followedPoint(tx, user, pointId, management, now, {lock = false} = {}) {
  if (lock) await tx.$queryRaw`SELECT id FROM "PointPrelevement" WHERE id = ${pointId}::uuid AND "deletedAt" IS NULL FOR SHARE`
  const point = await tx.pointPrelevement.findFirst({where: {id: pointId, deletedAt: null},
    select: {id: true, name: true, usageName: true, waterBodyType: true, updatedAt: true}})
  if (!point) throw createHttpError(404, 'Point introuvable.')
  const delegation = await tx.declarantPointPrelevement.findFirst({where: {pointPrelevementId: pointId,
    declarant: activePreleveur, ...exploitationAtDateWhere(collectorDay(now)),
    collecteurs: {some: {collecteurUserId: user.id}}}, select: {id: true}})
  if (!delegation) throw createHttpError(403, 'Vous ne suivez pas d’exploitation active sur ce point.')
  if (lock) await tx.$queryRaw`
    SELECT e.id FROM "DeclarantPointPrelevement" e
    JOIN "DeclarantCollecteurExploitation" link ON link."exploitationId" = e.id
    WHERE e.id = ${delegation.id}::uuid AND link."collecteurUserId" = ${user.id}::uuid FOR SHARE OF e, link
  `
  const decorated = await decoratePointWithCoords(point, {client: tx})
  await assertCollectorPointLocation(management, decorated.coordinates, point.waterBodyType, {client: tx})
  return decorated
}

function requestCollision(error) {
  return error?.code === 'P2002' && error?.meta?.modelName === 'CollectorPointCreationRequest'
}

async function finishCreation(committed, value, {client, user, onCreated, notify}) {
  if (committed.replayed) return
  await onCreated({preleveur: committed.preleveur, exploitation: committed.exploitation, mutations: committed.mutations})
  if (!value.notifyAccountCreation) return
  try {
    await notify(committed.preleveur.user ?? committed.preleveur, {role: 'DECLARANT'})
    committed.notificationStatus = 'sent'
  } catch {
    committed.notificationStatus = 'failed'
    Sentry.captureMessage('Échec de notification après création d’une exploitation par un collecteur.', {level: 'error', tags: {component: 'collector-resource-management'}})
  }
  try {
    await client.collectorPointCreationRequest.update({where: {collecteurUserId_requestId: {collecteurUserId: user.id, requestId: value.requestId}},
      data: {notificationStatus: committed.notificationStatus}})
  } catch { committed.notificationStatus = 'pending' }
}

export async function createCollectorExploitation(pointId, payload, {
  user, client = prisma, now = new Date(), onCreated = () => {}, createPreleveur = insertDeclarant,
  createExploitation = insertExploitation, saveMeters = saveCollectorExploitationMeters, notify = sendAccountCreationNotification,
  checkManagement = assertCollectorPointManagementEnabled, checkPoint = followedPoint,
  prepareParticipation = prepareCollectorCampaignParticipation, appendParticipation = appendCollectorCampaignResponse
} = {}) {
  validateId(pointId)
  const value = validateCollectorExploitationCreation(payload)
  const payloadHash = collectorResourceVersion({operation: 'CREATE_EXPLOITATION', pointId, value})
  let committed
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      committed = await client.$transaction(async tx => {
        const management = await checkManagement(user, {client: tx, lock: true})
        const key = {collecteurUserId: user.id, requestId: value.requestId}
        const previous = await tx.collectorPointCreationRequest.findUnique({where: {collecteurUserId_requestId: key}})
        if (previous) {
          if (previous.payloadHash !== payloadHash || previous.result.operation !== 'CREATE_EXPLOITATION') throw createHttpError(409, 'Cette demande a déjà été enregistrée avec un contenu différent.')
          const record = await readExploitation(tx, user, previous.result.exploitationId)
          if (record.pointPrelevementId !== pointId || !isCurrentCollectorExploitation(record, now)) throw createHttpError(403, 'Vous ne suivez plus cette exploitation active.')
          return {result: previous.result, notificationStatus: previous.notificationStatus, replayed: true}
        }
        if (value.campaignId) await prepareParticipation(tx, {user, campaignId: value.campaignId, now})
        const point = await checkPoint(tx, user, pointId, management, now, {lock: true})
        if (!isCurrentCollectorExploitation(value.exploitation, now)) throw createHttpError(400, 'L’exploitation créée doit être actuellement en activité.')
        let preleveurId = value.preleveurId
        let preleveur = null
        if (preleveurId) await assertFollowedPreleveur(tx, user.id, preleveurId, now)
        else {
          await assertNewIdentityAvailable(tx, value.preleveur, now)
          preleveur = await createPreleveur(value.preleveur, {client: tx, createdByUserId: user.id})
          preleveurId = preleveur.userId ?? preleveur.id
        }
        const {meters, ...exploitationData} = value.exploitation
        if (exploitationData.status !== 'ABANDONNEE') exploitationData.abandonReason = null
        const exploitation = await createExploitation({...exploitationData, pointPrelevementId: pointId,
          declarantUserId: preleveurId, collecteurUserIds: [user.id]}, {client: tx})
        const {mutations = []} = meters?.length ? await saveMeters(tx, {exploitation, meters, actorId: user.id}) : {}
        const participation = value.campaignId ? await appendParticipation(tx, {user, campaignId: value.campaignId, exploitationId: exploitation.id, now}) : null
        if (participation?.mutation) mutations.push(participation.mutation)
        const result = JSON.parse(JSON.stringify({operation: 'CREATE_EXPLOITATION', point, preleveurId, exploitationId: exploitation.id,
          ...(participation ? {campaignParticipation: participation.campaignParticipation} : {})}))
        const notificationStatus = value.notifyAccountCreation ? 'pending' : 'not_requested'
        await tx.collectorPointCreationRequest.create({data: {...key, payloadHash, result, notificationStatus}})
        return {result, preleveur, exploitation, mutations, notificationStatus, replayed: false}
      }, transactionOptions)
      break
    } catch (error) {
      if ((isDatabaseWriteConflict(error) || requestCollision(error)) && attempt < 2) continue
      translateConflict(error)
    }
  }
  await finishCreation(committed, value, {client, user, onCreated, notify})
  const {operation: _operation, ...result} = committed.result
  return {...result, notification: {status: committed.notificationStatus}, replayed: committed.replayed}
}
