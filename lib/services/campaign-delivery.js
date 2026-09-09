import process from 'node:process'
import createHttpError from 'http-errors'
import {prisma} from '../../db/prisma.js'
import createStorageClient from '../util/s3.js'
import {sendEmail} from '../util/email.js'
import {getPrimaryDeclarantContactEmail} from './declarant-contact-emails.js'
import {getCampaignAccess, listCampaignResponses} from './campaigns.js'
import {buildCampaignWorkbook} from './campaign-export-workbook.js'

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const LEASE_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 3
const exportSelect = {id: true, campaignId: true, createdByUserId: true, status: true, error: true, createdAt: true, completedAt: true}

export function campaignLocalDate(date, timezone = 'Europe/Paris') {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(date)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

export function incompleteCampaignRecipients(targets, responses) {
  return [...new Set(targets.map(target => target.preleveurUserId))].filter(id =>
    ['INDEX', 'NEEDS'].some(kind => !responses.some(response => response.preleveurUserId === id && response.kind === kind && response.latestSubmissionId)))
}

// Called inside the same transaction as campaign opening or submission.
// Workers consume this durable outbox after commit, never during submission.
export async function enqueueCampaignNotifications(client, {campaign, submission, kind, preleveurUserIds, now = new Date()}) {
  const suffix = kind === 'RECEIPT' ? submission?.id : (kind === 'REMINDER' ? campaignLocalDate(now, campaign.timezone) : 'opening')
  if (!suffix || !['OPENING', 'REMINDER', 'RECEIPT'].includes(kind)) {
    throw new Error('Notification de campagne invalide.')
  }

  const data = [...new Set(preleveurUserIds)].map(preleveurUserId => ({
    campaignId: campaign.id,
    ...(submission ? {submissionId: submission.id} : {}),
    preleveurUserId,
    kind,
    dedupeKey: `${campaign.id}:${kind}:${preleveurUserId}:${suffix}`
  }))
  if (data.length === 0) {
    return {count: 0}
  }

  return client.campaignNotification.createMany({data, skipDuplicates: true})
}

export async function remindCampaign(user, campaignId, {client = prisma, now = new Date()} = {}) {
  const {campaign, permissions, targets} = await getCampaignAccess(user, campaignId, {client})
  if (!permissions.canRemind) {
    throw createHttpError(403, 'Vous ne pouvez pas relancer cette campagne.')
  }

  if (campaign.status !== 'OPEN' || (campaign.closesAt && now >= new Date(campaign.closesAt))) {
    throw createHttpError(409, 'La campagne n’est pas ouverte aux réponses.')
  }

  const responses = await client.campaignResponse.findMany({where: {campaignId}, select: {preleveurUserId: true, kind: true, latestSubmissionId: true}})
  const {count} = await enqueueCampaignNotifications(client, {campaign, kind: 'REMINDER', preleveurUserIds: incompleteCampaignRecipients(targets, responses), now})
  return {queuedCount: count}
}

export async function listCampaignNotifications(user, campaignId, {client = prisma} = {}) {
  const {permissions, targets} = await getCampaignAccess(user, campaignId, {client})
  if (!permissions.canRemind) {
    throw createHttpError(403, 'Vous ne pouvez pas consulter les envois de cette campagne.')
  }

  return client.campaignNotification.findMany({
    where: {campaignId, preleveurUserId: {in: [...new Set(targets.map(target => target.preleveurUserId))]}},
    select: {id: true, kind: true, status: true, preleveurUserId: true, submissionId: true, attempts: true, error: true, createdAt: true, sentAt: true},
    orderBy: {createdAt: 'desc'}, take: 100
  })
}

export async function scheduleCampaignReminders({client = prisma, now = new Date()} = {}) {
  const campaigns = await client.campaign.findMany({
    where: {status: 'OPEN', closesAt: {gt: now}},
    include: {targets: {select: {preleveurUserId: true}}, responses: {select: {preleveurUserId: true, kind: true, latestSubmissionId: true}}}
  })
  let queuedCount = 0
  for (const campaign of campaigns) {
    const hour = new Intl.DateTimeFormat('en-GB', {timeZone: campaign.timezone, hour: '2-digit', hourCycle: 'h23'}).format(now)
    if (hour !== '09' || (campaign.opensAt && now < new Date(campaign.opensAt))) {
      continue
    }

    const remainingDays = (Date.parse(campaignLocalDate(campaign.closesAt, campaign.timezone)) - Date.parse(campaignLocalDate(now, campaign.timezone))) / 86_400_000
    if (!campaign.reminderDays.includes(remainingDays)) {
      continue
    }

    // Keep outbox batches bounded when several campaigns share a deadline.
    // eslint-disable-next-line no-await-in-loop
    const {count} = await enqueueCampaignNotifications(client, {
      campaign, kind: 'REMINDER', now,
      preleveurUserIds: incompleteCampaignRecipients(campaign.targets, campaign.responses)
    })
    queuedCount += count
  }

  return {queuedCount}
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\'', '&#39;')
}

export function buildCampaignEmail(notification, {frontUrl = process.env.FRONT_URL || process.env.FRONTEND_URL} = {}) {
  const url = new URL(frontUrl)
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error('URL du site invalide.')
  }

  const {campaign, submission, kind} = notification
  const volet = submission?.response?.kind === 'NEEDS' ? 'besoins' : 'index'
  const link = new URL(`/mes-${volet}/${encodeURIComponent(campaign.id)}`, url).toString()
  const title = kind === 'RECEIPT' ? 'Accusé de réception' : (kind === 'REMINDER' ? 'Rappel : réponse attendue' : 'Ouverture de la campagne')
  let body = `<p>${escapeHtml(campaign.openingMessage ?? '')}</p>`
  if (kind === 'RECEIPT') {
    body = `<p>Votre transmission « ${escapeHtml(volet)} » a été enregistrée le ${escapeHtml(new Date(submission.submittedAt).toLocaleString('fr-FR', {timeZone: campaign.timezone}))}.</p><p>Référence : ${escapeHtml(submission.id)} — version ${escapeHtml(submission.version)}.</p><p>Auteur : ${escapeHtml(submission.createdBy?.firstName)} ${escapeHtml(submission.createdBy?.lastName)} (${escapeHtml(submission.createdByUserId)}). Le récépissé et l’historique sont disponibles dans votre espace.</p>`
  } else {
    body += '<p>Les index et les besoins sont deux transmissions distinctes. Consultez votre espace pour retrouver les volets restant à transmettre.</p>'
    if (campaign.closesAt) {
      body += `<p>Échéance : ${escapeHtml(new Date(campaign.closesAt).toLocaleString('fr-FR', {timeZone: campaign.timezone}))}.</p>`
    }
  }

  return {subject: `${title} — ${campaign.name}`, html: `<h1>${escapeHtml(title)}</h1><h2>${escapeHtml(campaign.name)}</h2>${body}<p><a href="${escapeHtml(link)}">Accéder à la campagne</a></p>`}
}

export async function processCampaignNotification(id, {client = prisma, mailer = sendEmail, now = new Date(), frontUrl} = {}) {
  const eligible = {id, attempts: {lt: MAX_ATTEMPTS}, OR: [{status: {in: ['PENDING', 'FAILED']}, OR: [{leaseUntil: null}, {leaseUntil: {lte: now}}]}, {status: 'SENDING', leaseUntil: {lte: now}}]}
  const claimed = await client.campaignNotification.updateMany({where: eligible, data: {status: 'SENDING', attempts: {increment: 1}, leaseUntil: new Date(now.getTime() + LEASE_MS), error: null}})
  if (!claimed.count) {
    return {claimed: false}
  }

  try {
    const notification = await client.campaignNotification.findUnique({
      where: {id},
      include: {campaign: true, preleveur: {include: {user: true, contactEmails: true}}, submission: {include: {response: true, createdBy: true}}}
    })
    const recipient = notification.preleveur
    const email = getPrimaryDeclarantContactEmail(recipient)
    let skipReason = recipient.user.deletedAt || !email ? 'DESTINATAIRE_INDISPONIBLE' : null
    if (notification.kind !== 'RECEIPT') {
      if (recipient.declarationNotificationsEnabled === false) {
        skipReason = 'NOTIFICATIONS_DESACTIVEES'
      }

      if (notification.campaign.status !== 'OPEN' || (notification.campaign.closesAt && now >= notification.campaign.closesAt)) {
        skipReason = 'CAMPAGNE_FERMEE'
      }

      const targets = await client.campaignTarget.findMany({where: {campaignId: notification.campaignId, preleveurUserId: notification.preleveurUserId}, select: {preleveurUserId: true}})
      if (targets.length === 0) {
        skipReason = 'DESTINATAIRE_HORS_PERIMETRE'
      } else if (notification.kind === 'REMINDER') {
        const responses = await client.campaignResponse.findMany({where: {campaignId: notification.campaignId, preleveurUserId: notification.preleveurUserId}, select: {preleveurUserId: true, kind: true, latestSubmissionId: true}})
        if (incompleteCampaignRecipients(targets, responses).length === 0) {
          skipReason = 'REPONSES_DEJA_TRANSMISES'
        }
      }
    }

    if (skipReason) {
      await client.campaignNotification.update({where: {id}, data: {status: 'SKIPPED', error: skipReason, leaseUntil: null}})
      return {skipped: true}
    }

    const {subject, html} = buildCampaignEmail(notification, {frontUrl})
    await mailer(email, subject, html)
    await client.campaignNotification.update({where: {id}, data: {status: 'SENT', sentAt: now, leaseUntil: null, error: null}})
    return {sent: true}
  } catch {
    await client.campaignNotification.update({where: {id}, data: {status: 'FAILED', error: 'ECHEC_ENVOI', leaseUntil: new Date(now.getTime() + LEASE_MS)}})
    return {failed: true}
  }
}

function assertExportScope(record, access) {
  const exportableIds = new Set(access.permissions.exportTargetIds ?? [])
  const currentIds = new Set(access.targets.filter(target => exportableIds.has(target.id)).map(target => target.id))
  if (!access.permissions.canExport || !Array.isArray(record.targetIds) || record.targetIds.some(id => !currentIds.has(id))) {
    throw createHttpError(403, 'Le périmètre autorisé a changé. Demandez un nouvel export.')
  }
}

export async function createCampaignExport(user, campaignId, {client = prisma} = {}) {
  const access = await getCampaignAccess(user, campaignId, {client})
  const exportableIds = new Set(access.permissions.exportTargetIds ?? [])
  const targetIds = access.targets.filter(target => exportableIds.has(target.id)).map(target => target.id)
  if (!access.permissions.canExport || targetIds.length === 0) {
    throw createHttpError(403, 'Vous ne pouvez pas exporter cette campagne.')
  }

  return client.campaignExport.create({data: {campaignId, createdByUserId: user.id, targetIds}, select: exportSelect})
}

export async function listCampaignExports(user, campaignId, {client = prisma} = {}) {
  const access = await getCampaignAccess(user, campaignId, {client})
  if (!access.permissions.canExport) {
    throw createHttpError(403, 'Vous ne pouvez pas exporter cette campagne.')
  }

  return client.campaignExport.findMany({where: {campaignId, createdByUserId: user.id}, select: exportSelect, orderBy: {createdAt: 'desc'}, take: 50})
}

export async function getCampaignExport(user, campaignId, exportId, {client = prisma, storageFactory = createStorageClient} = {}) {
  const access = await getCampaignAccess(user, campaignId, {client})
  const record = await client.campaignExport.findFirst({where: {id: exportId, campaignId, createdByUserId: user.id}})
  if (!record) {
    throw createHttpError(404, 'Export introuvable.')
  }

  assertExportScope(record, access)
  const result = Object.fromEntries(Object.keys(exportSelect).map(key => [key, record[key]]))
  if (record.status === 'COMPLETED' && record.storageKey) {
    result.downloadUrl = await storageFactory('exports').getPresignedUrl(record.storageKey, {filename: 'campagne.xlsx', type: XLSX_TYPE, expiresIn: 300})
  }

  return result
}

export async function processCampaignExport(id, {client = prisma, storageFactory = createStorageClient, now = new Date()} = {}) {
  const claimed = await client.campaignExport.updateMany({where: {id, OR: [{status: 'PENDING'}, {status: 'PROCESSING', leaseUntil: {lte: now}}]}, data: {status: 'PROCESSING', leaseUntil: new Date(now.getTime() + LEASE_MS)}})
  if (!claimed.count) {
    return {claimed: false}
  }

  try {
    const record = await client.campaignExport.findUnique({where: {id}, include: {createdBy: {include: {declarant: true}}}})
    if (record.createdBy.deletedAt) {
      throw createHttpError(403, 'Compte désactivé.')
    }

    const result = await listCampaignResponses(record.createdBy, record.campaignId, {client})
    assertExportScope(record, result)
    const targetIds = new Set(record.targetIds)
    const targets = result.targets.filter(target => targetIds.has(target.id))
    const preleveurIds = new Set(targets.map(target => target.preleveurUserId))
    const responses = result.responses.filter(response => preleveurIds.has(response.preleveurUserId))
      .map(response => {
        if (!response.latestSubmission) {
          return response
        }

        const {snapshot, publication} = response.latestSubmission
        const allTargetsAllowed = result.targets.filter(target => target.preleveurUserId === response.preleveurUserId).every(target => targetIds.has(target.id))
        return {...response, latestSubmission: {...response.latestSubmission, snapshot: {
          ...snapshot, comment: allTargetsAllowed ? snapshot.comment : undefined,
          readings: (snapshot.readings ?? []).filter(line => targetIds.has(line.targetId)),
          meterEvents: (snapshot.meterEvents ?? []).filter(line => targetIds.has(line.targetId)),
          needs: (snapshot.needs ?? []).filter(line => targetIds.has(line.targetId))
        }, publication: publication ? {...publication, totals: (publication.totals ?? []).filter(line => targetIds.has(line.targetId))} : null}}
      })
    const workbook = buildCampaignWorkbook({campaign: result.campaign, targets, responses})
    const buffer = await workbook.xlsx.writeBuffer()
    const storageKey = `campaigns/${record.campaignId}/${id}.xlsx`
    await storageFactory('exports').uploadObject(storageKey, buffer, {filename: 'campagne.xlsx', type: XLSX_TYPE})
    await client.campaignExport.update({where: {id}, data: {status: 'COMPLETED', storageKey, completedAt: new Date(), leaseUntil: null, error: null}})
    return {completed: true}
  } catch {
    await client.campaignExport.update({where: {id}, data: {status: 'FAILED', leaseUntil: null, error: 'ECHEC_EXPORT_OU_DROITS_MODIFIES'}})
    return {failed: true}
  }
}

export async function processCampaignDelivery({client = prisma, now = new Date(), ...dependencies} = {}) {
  const notifications = await client.campaignNotification.findMany({where: {attempts: {lt: MAX_ATTEMPTS}, OR: [{status: {in: ['PENDING', 'FAILED']}, OR: [{leaseUntil: null}, {leaseUntil: {lte: now}}]}, {status: 'SENDING', leaseUntil: {lte: now}}]}, select: {id: true}, orderBy: {createdAt: 'asc'}, take: 25})
  for (const notification of notifications) {
    // Do not burst the mail provider; durable leases allow another worker later.
    // eslint-disable-next-line no-await-in-loop
    await processCampaignNotification(notification.id, {client, now, ...dependencies})
  }

  const exports = await client.campaignExport.findMany({where: {OR: [{status: 'PENDING'}, {status: 'PROCESSING', leaseUntil: {lte: now}}]}, select: {id: true}, orderBy: {createdAt: 'asc'}, take: 5})
  for (const item of exports) {
    // XLSX buffers are processed one at a time to bound worker memory.
    // eslint-disable-next-line no-await-in-loop
    await processCampaignExport(item.id, {client, now, ...dependencies})
  }

  return {notifications: notifications.length, exports: exports.length}
}
