import test from 'ava'
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import {prisma} from '../../../../db/prisma.js'
import {requireDisposableDatabase} from '../../../../lib/util/test-helpers/disposable-database.js'
import {applyManifest} from '../apply-epidropt.js'
import {seedManifestCampaign, CAMPAIGN_SOURCE_ID, COLLECTEUR_SOURCE_ID, CAMPAIGN_TYPE} from '../seed-campaign.js'
import {digest, stableId} from '../epidropt.js'

const integration = process.env.DROPT_INTEGRATION_TESTS === '1' ? test.serial : test.skip
const owned = {users: new Set(), points: new Set(), exploitations: new Set(), zones: new Set()}
let validated = false

test.before(() => {
  if (process.env.DROPT_INTEGRATION_TESTS !== '1') return
  requireDisposableDatabase()
  validated = true
})

test.afterEach.always(async () => {
  if (!validated) return
  await prisma.$transaction(async tx => {
    await tx.collectionResponse.deleteMany({where: {campaign: {sourceId: CAMPAIGN_SOURCE_ID}}})
    await tx.collectionCampaign.deleteMany({where: {sourceId: CAMPAIGN_SOURCE_ID}})
    await tx.externalReference.deleteMany({where: {OR: [
      {declarantUserId: {in: [...owned.users]}}, {pointPrelevementId: {in: [...owned.points]}}
    ]}})
    await tx.declarantPointPrelevement.deleteMany({where: {id: {in: [...owned.exploitations]}}})
    await tx.pointPrelevement.deleteMany({where: {id: {in: [...owned.points]}}})
    await tx.user.deleteMany({where: {id: {in: [...owned.users]}}})
    await tx.zone.deleteMany({where: {id: {in: [...owned.zones]}}})
  })
  for (const ids of Object.values(owned)) ids.clear()
})

test.after.always(async () => {
  await prisma.$disconnect()
  await globalThis.pgPool?.end()
})

function sign(input) {
  const {manifestHash, ...manifest} = input
  return {...manifest, manifestHash: digest(manifest)}
}

function fixture({cacg = false, domestic = false} = {}) {
  const key = randomUUID()
  const pointId = stableId(`campaign-seed-point:${key}`)
  const ownerId = stableId(`campaign-seed-owner:${key}`)
  const exploitationId = stableId(`campaign-seed-exploitation:${key}`)
  owned.points.add(pointId)
  owned.users.add(ownerId)
  owned.exploitations.add(exploitationId)
  return {formatVersion: 1, scope: 'epidropt', issues: [],
    points: [{id: pointId, key, sourceId: `dropt-epidropt:point:${key}`, coordinates: [0.4, 44.6],
      references: [{provider: 'epidropt', externalId: key}],
      data: {name: `${cacg ? 'CACG_' : 'NON_ALIMENTE_'}${key}`, flowType: 'PRELEVEMENT', waterBodyType: 'SUPERFICIELLE',
        collectionMode: cacg ? 'EXTERNAL' : 'MANUAL'}}],
    declarants: [{id: ownerId, key, sourceId: `dropt-epidropt:preleveur:${key}`,
      references: [{provider: 'epidropt', externalId: key}], emails: [`${key}@example.test`],
      user: {role: 'DECLARANT', email: null},
      data: {socialReason: 'Préleveur de test', preleveurType: domestic ? 'AUTRE' : 'IRRIGANT', declarationNotificationsEnabled: false}}],
    exploitations: [{id: exploitationId, sourceId: `dropt-epidropt:exploitation:${key}`,
      pointId, declarantId: ownerId, usageCode: domestic ? '17' : '2', aliases: []}], meters: [], allocations: []}
}

async function setup(t, items = [fixture(), fixture({cacg: true}), fixture({domestic: true})]) {
  const manifest = sign({...items[0], ...Object.fromEntries(['points', 'declarants', 'exploitations', 'meters', 'allocations']
    .map(key => [key, items.flatMap(item => item[key])]))})
  const imported = await applyManifest(prisma, manifest, {apply: true})
  t.true(imported.complete, JSON.stringify(imported.executionIssues))
  const actor = await addUser({role: 'ADMIN'})
  const config = {createdByUserId: actor.id, name: 'Collecte synthétique', collecteur: {
    socialReason: 'Collecteur de test', firstName: 'Contact', lastName: 'Test', email: `${randomUUID()}@example.test`, phoneNumber: '0000000000'
  }}
  owned.users.add(stableId(COLLECTEUR_SOURCE_ID))
  return {manifest, config, actor}
}

async function addUser(data = {}) {
  const id = randomUUID()
  owned.users.add(id)
  return prisma.user.create({data: {id, role: 'DECLARANT', ...data}})
}

async function preview({manifest, config}, options = {}) {
  return seedManifestCampaign(prisma, manifest, config, {target: 'local', ...options})
}

async function apply(input) {
  const expectedReport = await preview(input)
  return preview(input, {apply: true, expectedReport})
}

async function addZone(pointId) {
  const id = randomUUID()
  owned.zones.add(id)
  await prisma.$executeRaw`INSERT INTO "Zone" (id, code, type, name, coordinates, "createdAt", "updatedAt")
    VALUES (${id}::uuid, ${id}, 'SAGE', 'Zone synthétique', ST_GeomFromText('MULTIPOLYGON(((0 44,1 44,1 45,0 45,0 44)))',4326), NOW(), NOW())`
  if (pointId) await prisma.pointPrelevementZone.create({data: {pointPrelevementId: pointId, zoneId: id}})
  return id
}

integration('simulation sans effet puis collecteur territorial, campagne brouillon et population non CACG sans filtre d’usage', async t => {
  const input = await setup(t)
  const zoneId = await addZone(input.manifest.points[1].id)
  const usersBefore = await prisma.user.findMany({where: {id: {in: input.manifest.declarants.map(row => row.id)}}, orderBy: {id: 'asc'}})
  const dry = await preview(input)
  t.true(dry.complete)
  t.false(dry.applied)
  t.deepEqual(dry.counts, {territoryExploitations: 3, campaignExploitations: 2, campaignPreleveurs: 2,
    collectorsCreated: 1, campaignsCreated: 1, rightsCreated: 3, zonesCreated: 1})
  t.is(await prisma.collectionCampaign.count({where: {sourceId: CAMPAIGN_SOURCE_ID}}), 0)
  t.is(await prisma.declarant.count({where: {sourceId: COLLECTEUR_SOURCE_ID}}), 0)
  const result = await preview(input, {apply: true, expectedReport: dry})
  t.true(result.applied)
  const campaign = await prisma.collectionCampaign.findUnique({where: {id: result.campaignId}, include: {responses: true}})
  t.is(campaign.status, 'DRAFT')
  t.is(campaign.type, CAMPAIGN_TYPE)
  t.is(campaign.opensOn, null)
  t.is(campaign.closesOn, null)
  t.is(campaign.createdByUserId, input.actor.id)
  t.deepEqual(campaign.responses.map(row => row.exploitationId).sort(),
    [input.manifest.exploitations[0].id, input.manifest.exploitations[2].id].sort())
  t.is(await prisma.declarantCollecteurExploitation.count({where: {collecteurUserId: campaign.collecteurUserId}}), 3)
  t.is(await prisma.declarantZone.count({where: {declarantUserId: campaign.collecteurUserId, zoneId}}), 1)
  const user = await prisma.user.findUnique({where: {id: campaign.collecteurUserId}, include: {declarant: true}})
  t.is(user.email, input.config.collecteur.email)
  t.is(user.declarant.declarantRole, 'COLLECTEUR')
  t.false(user.declarant.declarationNotificationsEnabled)
  t.is(user.accountCreationMailSentAt, null)
  t.is(await prisma.authToken.count({where: {userId: user.id}}), 0)
  t.is(await prisma.passwordCredential.count({where: {userId: user.id}}), 0)
  t.deepEqual(await prisma.user.findMany({where: {id: {in: input.manifest.declarants.map(row => row.id)}}, orderBy: {id: 'asc'}}), usersBefore)
})

integration('le rejeu conserve les réponses, dates, nom et identifiants modifiés manuellement', async t => {
  const input = await setup(t)
  const result = await apply(input)
  const collectorId = result.plan.collecteur.id
  const manualEmail = `${randomUUID()}@example.test`
  await prisma.user.update({where: {id: collectorId}, data: {email: manualEmail}})
  await prisma.collectionCampaign.update({where: {id: result.campaignId}, data: {name: 'Nom corrigé', opensOn: new Date('2026-10-01'), closesOn: new Date('2026-11-30')}})
  await prisma.collectionResponse.updateMany({where: {campaignId: result.campaignId}, data: {draftData: {synthetic: true}, revision: 2}})
  const campaignBefore = await prisma.collectionCampaign.findUnique({where: {id: result.campaignId}, include: {responses: {orderBy: {id: 'asc'}}}})
  const userBefore = await prisma.user.findUnique({where: {id: collectorId}})
  const replay = await apply(input)
  t.is(replay.counts.collectorsCreated, 0)
  t.is(replay.counts.campaignsCreated, 0)
  t.is(replay.counts.rightsCreated, 0)
  t.is(replay.counts.zonesCreated, 0)
  t.deepEqual(await prisma.collectionCampaign.findUnique({where: {id: result.campaignId}, include: {responses: {orderBy: {id: 'asc'}}}}), campaignBefore)
  t.deepEqual(await prisma.user.findUnique({where: {id: collectorId}}), userBefore)
})

integration('les droits et zones extérieurs au manifeste restent inchangés', async t => {
  const input = await setup(t)
  const outside = fixture()
  t.true((await applyManifest(prisma, sign(outside), {apply: true})).complete)
  const applied = await apply(input)
  const collecteurUserId = applied.plan.collecteur.id
  const link = await prisma.declarantCollecteurExploitation.create({data: {collecteurUserId, exploitationId: outside.exploitations[0].id}})
  const zoneId = await addZone()
  const zone = await prisma.declarantZone.create({data: {declarantUserId: collecteurUserId, zoneId, source: 'MANUAL'}})
  const replay = await apply(input)
  t.is(replay.counts.rightsCreated, 0)
  t.deepEqual(await prisma.declarantCollecteurExploitation.findUnique({where: {id: link.id}}), link)
  t.deepEqual(await prisma.declarantZone.findUnique({where: {id: zone.id}}), zone)
})

integration('un email principal, alias, contact partagé ou réservation n’est jamais repris', async t => {
  const input = await setup(t)
  const email = input.config.collecteur.email
  const other = await addUser({email})
  await t.throwsAsync(() => preview(input), {message: /Email du collecteur déjà/})
  await prisma.user.update({where: {id: other.id}, data: {email: null}})
  const alias = await prisma.userEmailAlias.create({data: {userId: other.id, email}})
  await t.throwsAsync(() => preview(input), {message: /Email du collecteur déjà/})
  await prisma.userEmailAlias.delete({where: {id: alias.id}})
  await prisma.declarant.create({data: {userId: other.id, preleveurType: 'AUTRE', contactEmails: {create: {email}}}})
  await t.throwsAsync(() => preview(input), {message: /Email du collecteur déjà/})
  await prisma.declarantContactEmail.deleteMany({where: {declarantUserId: other.id}})
  await prisma.userEmailVerification.create({data: {userId: other.id, email, purpose: 'ALIAS_ADD', status: 'PENDING',
    tokenHash: digest(randomUUID()), lastAttemptedAt: new Date(), expiresAt: new Date(Date.now() + 60_000)}})
  await t.throwsAsync(() => preview(input), {message: /Email du collecteur déjà/})
  t.is(await prisma.declarant.count({where: {sourceId: COLLECTEUR_SOURCE_ID}}), 0)
  t.is(await prisma.collectionCampaign.count({where: {sourceId: CAMPAIGN_SOURCE_ID}}), 0)
})

integration('aucun administrateur implicite et aucune cible production', async t => {
  const input = await setup(t)
  await t.throwsAsync(() => preview(input, {target: 'prod'}), {message: /production interdite/})
  await prisma.user.update({where: {id: input.actor.id}, data: {role: 'INSTRUCTOR'}})
  await t.throwsAsync(() => preview(input), {message: /administrateur actif/})
  await prisma.user.update({where: {id: input.actor.id}, data: {role: 'ADMIN', deletedAt: new Date()}})
  await t.throwsAsync(() => preview(input), {message: /administrateur actif/})
  t.is(await prisma.collectionCampaign.count({where: {sourceId: CAMPAIGN_SOURCE_ID}}), 0)
})

integration('l’application exige une simulation du même manifeste, configuration et cible', async t => {
  const input = await setup(t)
  await t.throwsAsync(() => preview(input, {apply: true}), {message: /Simulation de campagne compatible/})
  const expectedReport = await preview(input)
  await t.throwsAsync(() => preview(input, {apply: true, expectedReport, target: 'testing'}), {message: /Simulation de campagne compatible/})
  await t.throwsAsync(() => preview({...input, config: {...input.config, name: 'Autre'}}, {apply: true, expectedReport}), {message: /Simulation de campagne compatible/})
  const altered = structuredClone(input.manifest)
  altered.points[0].data.name = 'ALTÉRÉ'
  await t.throwsAsync(() => preview({...input, manifest: altered}), {message: /Empreinte du manifeste invalide/})
})

integration('toute dérive depuis la simulation annule l’ensemble de l’opération', async t => {
  const input = await setup(t)
  const expectedReport = await preview(input)
  await prisma.declarantPointPrelevement.update({where: {id: input.manifest.exploitations[0].id}, data: {comment: 'Correction après simulation'}})
  await t.throwsAsync(() => preview(input, {apply: true, expectedReport}), {message: /DRY_RUN_STATE_CHANGED/})
  t.is(await prisma.declarant.count({where: {sourceId: COLLECTEUR_SOURCE_ID}}), 0)
  t.is(await prisma.collectionCampaign.count({where: {sourceId: CAMPAIGN_SOURCE_ID}}), 0)
})

integration('une exploitation absente, réaffectée, inactive ou reclassée bloque le seed sans exclusion silencieuse', async t => {
  const input = await setup(t)
  const exploitation = input.manifest.exploitations[0]
  await prisma.declarantPointPrelevement.update({where: {id: exploitation.id}, data: {endDate: new Date('2026-09-01')}})
  await t.throwsAsync(() => preview(input), {message: /inactive/})
  await prisma.declarantPointPrelevement.update({where: {id: exploitation.id}, data: {endDate: null, declarantUserId: input.manifest.declarants[1].id}})
  await t.throwsAsync(() => preview(input), {message: /Rattachement importé modifié/})
  await prisma.declarantPointPrelevement.update({where: {id: exploitation.id}, data: {declarantUserId: exploitation.declarantId}})
  await prisma.pointPrelevement.update({where: {id: exploitation.pointId}, data: {name: `CACG_${randomUUID()}`}})
  await t.throwsAsync(() => preview(input), {message: /Catégorie du point modifiée/})
  await prisma.pointPrelevement.update({where: {id: exploitation.pointId}, data: {name: input.manifest.points[0].data.name}})
  await prisma.declarantPointPrelevement.delete({where: {id: exploitation.id}})
  await t.throwsAsync(() => preview(input), {message: /Exploitation importée absente/})
})

integration('les références importées priment sur des UUID de manifeste devenus obsolètes', async t => {
  const input = await setup(t)
  const manifest = structuredClone(input.manifest)
  manifest.points[0].id = randomUUID()
  manifest.declarants[0].id = randomUUID()
  manifest.exploitations[0].id = randomUUID()
  manifest.exploitations[0].pointId = manifest.points[0].id
  manifest.exploitations[0].declarantId = manifest.declarants[0].id
  const result = await apply({...input, manifest: sign(manifest)})
  t.is(result.counts.campaignExploitations, 2)
  t.is(await prisma.collectionResponse.count({where: {campaignId: result.campaignId, exploitationId: input.manifest.exploitations[0].id}}), 1)
})

integration('le seed ne rétablit pas silencieusement une population modifiée manuellement', async t => {
  const input = await setup(t)
  const result = await apply(input)
  const response = await prisma.collectionResponse.findFirst({where: {campaignId: result.campaignId}})
  await prisma.collectionResponse.delete({where: {id: response.id}})
  await t.throwsAsync(() => preview(input), {message: /Population de campagne modifiée/})
  t.is(await prisma.collectionResponse.count({where: {campaignId: result.campaignId}}), 1)
})

integration('le collecteur ou le type d’une campagne existante ne sont jamais remplacés', async t => {
  const input = await setup(t)
  const result = await apply(input)
  await t.throwsAsync(() => prisma.collectionCampaign.update({where: {id: result.campaignId}, data: {type: 'OTHER'}}))
  const replacement = await addUser({declarant: {create: {declarantRole: 'COLLECTEUR'}}})
  await prisma.collectionCampaign.update({where: {id: result.campaignId}, data: {collecteurUserId: replacement.id}})
  await t.throwsAsync(() => preview(input), {message: /Campagne existante incompatible/})
  const campaign = await prisma.collectionCampaign.findUnique({where: {id: result.campaignId}})
  t.is(campaign.type, CAMPAIGN_TYPE)
  t.is(campaign.collecteurUserId, replacement.id)
})
