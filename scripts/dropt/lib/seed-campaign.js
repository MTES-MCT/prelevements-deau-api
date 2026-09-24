import {readFile, realpath} from 'node:fs/promises'
import path from 'node:path'
import {normalizeEmail} from '../../../lib/util/email.js'
import {referenceIdentity, validateManifest} from './apply-epidropt.js'
import {digest, stableId, SCOPE} from './epidropt.js'
import {getTransactionTimeoutMs} from './import-options.js'

export const COLLECTEUR_SOURCE_ID = 'dropt-epidropt:collecteur:ougc-dropt'
export const CAMPAIGN_SOURCE_ID = 'dropt-epidropt:campaign:index-needs:2026-2027'
export const CAMPAIGN_TYPE = 'DROPT_INDEX_NEEDS_2026_2027'
const DEFAULT_NAME = 'Collecte des index et des besoins 2025–2027'
const stateDigest = value => digest(JSON.parse(JSON.stringify(value)))
const requireCondition = (condition, message) => { if (!condition) throw new Error(message) }
const uuid = value => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value)

function textValue(value, label, maximum = 200) {
  requireCondition(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maximum,
    `Configuration de campagne invalide : ${label}.`)
  return value.trim()
}

export function validateCampaignSeedConfig(input, {actorUserId} = {}) {
  requireCondition(input && typeof input === 'object' && !Array.isArray(input), 'Configuration privée de campagne obligatoire.')
  const collector = input.collecteur
  requireCondition(collector && typeof collector === 'object' && !Array.isArray(collector), 'Configuration privée du collecteur obligatoire.')
  requireCondition(Object.keys(input).every(key => ['name', 'createdByUserId', 'collecteur'].includes(key))
    && Object.keys(collector).every(key => ['sourceId', 'socialReason', 'firstName', 'lastName', 'email', 'phoneNumber'].includes(key)),
  'Clé de configuration de campagne inconnue.')
  requireCondition(!collector.sourceId || collector.sourceId === COLLECTEUR_SOURCE_ID, 'Identité source du collecteur incompatible.')
  requireCondition(!actorUserId || !input.createdByUserId || actorUserId === input.createdByUserId, 'Deux administrateurs différents ont été indiqués.')
  const createdByUserId = actorUserId ?? input.createdByUserId
  requireCondition(uuid(createdByUserId), 'Un administrateur existant doit être indiqué par --actor-user-id ou createdByUserId.')
  const email = normalizeEmail(collector.email)
  requireCondition(!email.endsWith('@import.local') && !email.endsWith('@email.fr'), 'Email de connexion du collecteur invalide.')
  return {name: textValue(input.name ?? DEFAULT_NAME, 'nom'), createdByUserId,
    collecteur: {sourceId: COLLECTEUR_SOURCE_ID, email,
      socialReason: textValue(collector.socialReason, 'raison sociale'),
      firstName: textValue(collector.firstName, 'prénom'), lastName: textValue(collector.lastName, 'nom du contact'),
      phoneNumber: textValue(collector.phoneNumber, 'téléphone', 50)}}
}

// Resolve symlinks too: the collector's contact details belong to private data,
// never to an example or fixture committed in the public application repository.
export async function readCampaignSeedConfig(filename, options = {}) {
  requireCondition(typeof filename === 'string' && filename.length > 0, '--campaign-config data/.../configuration.json obligatoire.')
  const [directory, resolved] = await Promise.all([realpath(path.resolve('data')), realpath(path.resolve(filename))])
  const relative = path.relative(directory, resolved)
  requireCondition(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    'La configuration privée de campagne doit se trouver dans data/.')
  let input
  try { input = JSON.parse(await readFile(resolved, 'utf8')) } catch { throw new Error('Configuration privée de campagne illisible ou JSON invalide.') }
  return validateCampaignSeedConfig(input, options)
}

async function resolveScope(tx, manifest) {
  const points = new Map(manifest.points.map(record => [record.id, record]))
  const declarants = new Map(manifest.declarants.map(record => [record.id, record]))
  const identities = {points: new Map(), declarants: new Map()}
  const entries = []
  const liveIds = new Set()
  for (const record of [...manifest.exploitations].sort((a, b) => a.id.localeCompare(b.id))) {
    const point = points.get(record.pointId)
    const declarant = declarants.get(record.declarantId)
    requireCondition(point && declarant && record.sourceId?.startsWith('dropt-epidropt:exploitation:'), 'Dépendance importée de campagne manquante.')
    if (!identities.points.has(point.id)) identities.points.set(point.id, (await referenceIdentity(tx, point, 'POINT')).id)
    if (!identities.declarants.has(declarant.id)) identities.declarants.set(declarant.id, (await referenceIdentity(tx, declarant, 'DECLARANT')).id)
    const found = await tx.declarantPointPrelevement.findMany({where: {OR: [{id: record.id}, {sourceId: record.sourceId}]},
      include: {pointPrelevement: {select: {id: true, name: true, deletedAt: true}},
        declarant: {select: {userId: true, declarantRole: true, user: {select: {role: true, deletedAt: true}}}}}})
    requireCondition(found.length === 1 && found[0].sourceId === record.sourceId, 'Exploitation importée absente ou identité ambiguë.')
    const live = found[0]
    requireCondition(!liveIds.has(live.id), 'Plusieurs exploitations source désignent la même exploitation.')
    liveIds.add(live.id)
    requireCondition(live.pointPrelevementId === identities.points.get(point.id)
      && live.declarantUserId === identities.declarants.get(declarant.id)
      && String(live.countingCode ?? '') === String(record.countingCode ?? ''), 'Rattachement importé modifié ; vérification manuelle nécessaire.')
    requireCondition(!live.pointPrelevement.deletedAt && !live.declarant.user.deletedAt && !live.endDate
      && ['NON_RENSEIGNE', 'EN_ACTIVITE'].includes(live.status)
      && live.declarant.user.role === 'DECLARANT' && live.declarant.declarantRole === 'PRELEVEUR',
    'Exploitation importée inactive ; vérifier le périmètre avant de créer la campagne.')
    const nonReplenished = !/CACG/i.test(point.data.name)
    requireCondition(nonReplenished === !/CACG/i.test(live.pointPrelevement.name), 'Catégorie du point modifiée ; vérifier le périmètre de campagne.')
    entries.push({id: live.id, sourceId: record.sourceId, pointPrelevementId: live.pointPrelevementId,
      preleveurUserId: live.declarantUserId, selected: nonReplenished, stateHash: stateDigest(live)})
  }
  requireCondition(entries.length > 0 && entries.some(entry => entry.selected), 'Aucune exploitation non réalimentée importée à inclure.')
  return entries
}

async function inspectCollector(tx, config) {
  const id = stableId(COLLECTEUR_SOURCE_ID)
  const candidates = await tx.declarant.findMany({where: {OR: [{sourceId: COLLECTEUR_SOURCE_ID}, {userId: id}]}, include: {user: true}})
  requireCondition(candidates.length <= 1, 'Identité du collecteur ambiguë.')
  const existing = candidates[0]
  if (existing) requireCondition(existing.sourceId === COLLECTEUR_SOURCE_ID && existing.declarantRole === 'COLLECTEUR'
    && existing.user.role === 'DECLARANT' && !existing.user.deletedAt, 'Le compte collecteur existant est incompatible ou supprimé.')
  else requireCondition(!await tx.user.findUnique({where: {id}, select: {id: true}}), 'Identifiant du collecteur déjà occupé.')
  const ownerId = existing?.userId ?? id
  const email = config.collecteur.email
  const [primary, alias, verification, identity, contact] = await Promise.all([
    tx.user.findFirst({where: {email, id: {not: ownerId}}, select: {id: true}}),
    tx.userEmailAlias.findFirst({where: {email, userId: {not: ownerId}}, select: {id: true}}),
    tx.userEmailVerification.findFirst({where: {email, userId: {not: ownerId}, status: {in: ['PENDING', 'SEND_FAILED']}}, select: {id: true}}),
    tx.userEmailIdentity.findUnique({where: {email}}),
    tx.declarantContactEmail.findFirst({where: {email, declarantUserId: {not: ownerId}}, select: {id: true}})
  ])
  const conflictingClaim = identity && ['primaryUserId', 'aliasUserId', 'verificationUserId'].some(key => identity[key] && identity[key] !== ownerId)
  requireCondition(!primary && !alias && !verification && !conflictingClaim && !contact, 'Email du collecteur déjà attribué, partagé ou réservé ; aucun compte modifié.')
  return {id: ownerId, action: existing ? 'PRESERVED' : 'CREATE', stateHash: stateDigest(existing ?? null)}
}

async function inspectCampaign(tx, collectorId, entries) {
  const existing = await tx.collectionCampaign.findUnique({where: {sourceId: CAMPAIGN_SOURCE_ID}})
  if (!existing) return {action: 'CREATE', sourceId: CAMPAIGN_SOURCE_ID, stateHash: stateDigest(null)}
  requireCondition(existing.type === CAMPAIGN_TYPE && existing.collecteurUserId === collectorId, 'Campagne existante incompatible ; aucune modification automatique.')
  const responses = await tx.collectionResponse.findMany({where: {campaignId: existing.id}, orderBy: {exploitationId: 'asc'}})
  const expected = entries.filter(entry => entry.selected).map(entry => ({exploitationId: entry.id, preleveurUserId: entry.preleveurUserId}))
    .sort((a, b) => a.exploitationId.localeCompare(b.exploitationId))
  const actual = responses.map(response => ({exploitationId: response.exploitationId, preleveurUserId: response.preleveurUserId}))
  requireCondition(digest(actual) === digest(expected), 'Population de campagne modifiée ; conserver les réponses et vérifier manuellement le périmètre.')
  return {id: existing.id, action: 'PRESERVED', sourceId: CAMPAIGN_SOURCE_ID, stateHash: stateDigest({existing, responses})}
}

async function inspectRights(tx, collectorId, entries) {
  const links = await tx.declarantCollecteurExploitation.findMany({where: {collecteurUserId: collectorId}, orderBy: {exploitationId: 'asc'}})
  const linked = new Set(links.map(link => link.exploitationId))
  const pointIds = [...new Set(entries.map(entry => entry.pointPrelevementId))]
  const pointZones = await tx.pointPrelevementZone.findMany({where: {pointPrelevementId: {in: pointIds}},
    select: {pointPrelevementId: true, zoneId: true}, orderBy: [{pointPrelevementId: 'asc'}, {zoneId: 'asc'}]})
  const zones = await tx.declarantZone.findMany({where: {declarantUserId: collectorId}, orderBy: {zoneId: 'asc'}})
  const existingZones = new Set(zones.map(zone => zone.zoneId))
  return {exploitationIds: entries.filter(entry => !linked.has(entry.id)).map(entry => entry.id).sort(),
    zoneIds: [...new Set(pointZones.map(row => row.zoneId))].filter(id => !existingZones.has(id)).sort(),
    stateHash: stateDigest({links, zones, pointZones})}
}

async function applyPlan(tx, config, plan, actor) {
  if (plan.collecteur.action === 'CREATE') {
    const {email, firstName, lastName, socialReason, phoneNumber} = config.collecteur
    await tx.user.create({data: {id: plan.collecteur.id, role: 'DECLARANT', email, firstName, lastName,
      declarant: {create: {sourceId: COLLECTEUR_SOURCE_ID, declarantRole: 'COLLECTEUR', declarantType: 'LEGAL_PERSON',
        socialReason, phoneNumber, quickDeclarationEnabled: true, declarationNotificationsEnabled: false,
        contactEmails: {create: {email, isPrimary: true, sourceId: `${COLLECTEUR_SOURCE_ID}:contact`}}}}}})
  }
  if (plan.rights.exploitationIds.length) await tx.declarantCollecteurExploitation.createMany({
    data: plan.rights.exploitationIds.map(exploitationId => ({collecteurUserId: plan.collecteur.id, exploitationId}))})
  if (plan.rights.zoneIds.length) await tx.declarantZone.createMany({data: plan.rights.zoneIds.map(zoneId => ({
    declarantUserId: plan.collecteur.id, zoneId, source: 'MIGRATION', createdByUserId: actor.id}))})
  if (plan.campaign.action === 'PRESERVED') return plan.campaign.id
  const {createCollectionCampaign} = await import('../../../lib/services/collection-campaigns.js')
  const campaign = await createCollectionCampaign({sourceId: CAMPAIGN_SOURCE_ID, name: config.name, type: CAMPAIGN_TYPE,
    opensOn: null, closesOn: null, collecteurUserId: plan.collecteur.id,
    exploitationIds: plan.entries.filter(entry => entry.selected).map(entry => entry.id)}, {user: actor, client: tx})
  return campaign.id
}

export async function seedManifestCampaign(client, manifest, input, {target, actorUserId, apply = false, expectedReport, transactionTimeoutSeconds} = {}) {
  validateManifest(manifest)
  requireCondition(['local', 'testing'].includes(target), 'Cible explicite local ou testing obligatoire ; production interdite.')
  const config = validateCampaignSeedConfig(input, {actorUserId})
  const configHash = digest(config)
  requireCondition(!(apply && !expectedReport) && (!expectedReport || (expectedReport.operation === 'seed-campaign'
    && expectedReport.target === target && expectedReport.configHash === configHash && expectedReport.manifestHash === manifest.manifestHash
    && expectedReport.complete && !expectedReport.applied && expectedReport.planHash)), 'Simulation de campagne compatible obligatoire avant application.')
  const rollback = new Error('CAMPAIGN_SEED_DRY_RUN_ROLLBACK')
  let result
  try {
    return await client.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('dropt-referential'), hashtext(${SCOPE}))`
      const actor = await tx.user.findUnique({where: {id: config.createdByUserId}})
      requireCondition(actor?.role === 'ADMIN' && !actor.deletedAt, 'Un administrateur actif existant est requis pour créer la campagne.')
      const entries = await resolveScope(tx, manifest)
      const collecteur = await inspectCollector(tx, config)
      const campaign = await inspectCampaign(tx, collecteur.id, entries)
      const rights = await inspectRights(tx, collecteur.id, entries)
      const plan = {entries, collecteur, campaign, rights, actor: {id: actor.id, stateHash: stateDigest(actor)}}
      const planHash = digest({target, manifestHash: manifest.manifestHash, configHash, plan})
      requireCondition(!expectedReport || expectedReport.planHash === planHash, 'DRY_RUN_STATE_CHANGED : refaire la simulation de campagne.')
      result = {operation: 'seed-campaign', target, manifestHash: manifest.manifestHash, configHash, planHash,
        applied: false, complete: true, plan,
        counts: {territoryExploitations: entries.length, campaignExploitations: entries.filter(entry => entry.selected).length,
          campaignPreleveurs: new Set(entries.filter(entry => entry.selected).map(entry => entry.preleveurUserId)).size,
          collectorsCreated: Number(collecteur.action === 'CREATE'), campaignsCreated: Number(campaign.action === 'CREATE'),
          rightsCreated: rights.exploitationIds.length, zonesCreated: rights.zoneIds.length}}
      const campaignId = await applyPlan(tx, config, plan, actor)
      if (!apply) throw rollback
      return {...result, campaignId, applied: true}
    }, {isolationLevel: 'Serializable', maxWait: 10_000, timeout: getTransactionTimeoutMs(transactionTimeoutSeconds)})
  } catch (error) {
    if (error === rollback) return result
    throw error
  }
}
