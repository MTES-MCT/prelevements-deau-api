/* eslint-disable no-await-in-loop -- Bounded synthetic fixtures and permission checks on the guarded disposable database only. */
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import test from 'ava'
import express from 'express'
import request from 'supertest'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {createRoutes} from '../../routes.js'
import {createQuickDeclarationHandler, previewQuickDeclarationConflictsHandler, getQuickDeclarationContextHandler, getAllowedTypesMetaForDeclarant} from '../../handlers/declarations.js'
import {createCollectionCampaign, transitionCollectionCampaign, getAuthorizedCampaignResponseContext, saveCollectionResponseDraft} from '../collection-campaigns.js'
import {submitCampaignResponse} from '../campaign-submission.js'
import {ingestDeclarationSeries} from '../../declaration-importer/importer.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
const excludedMessage = 'Cette exploitation est exclue de la saisie rapide.'
const period = {measurementType: 'VOLUME', periodStartDate: '2026-06-01', periodEndDate: '2026-06-10'}
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

async function fixture(codes = ['001', '002']) {
  const owner = await prisma.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT', quickDeclarationEnabled: true}}}})
  const collector = await prisma.user.create({data: {role: 'DECLARANT', declarant: {create: {declarantRole: 'COLLECTEUR', quickDeclarationEnabled: true}}}})
  const admin = await prisma.user.create({data: {role: 'ADMIN'}})
  const point = await prisma.pointPrelevement.create({data: {name: `Exclusion synthétique ${randomUUID()}`, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT', collectionMode: 'MANUAL'}})
  const usage = await prisma.sandreWaterUse.findFirstOrThrow({where: {kind: 'USAGE', code: '2'}})
  const exploitations = []
  for (const countingCode of codes) {
    exploitations.push(await prisma.declarantPointPrelevement.create({data: {
      declarantUserId: owner.id, pointPrelevementId: point.id, usageId: usage.id, status: 'EN_ACTIVITE', countingCode,
      collecteurs: {create: {collecteurUserId: collector.id}}
    }}))
  }

  return {owner, collector, admin, point, usage, exploitations}
}

async function invoke(handler, user, body, query = {}) {
  let payload
  let status = 200
  let caught
  const response = {
    status(value) { status = value; return response },
    json(value) { payload = value; return response }
  }
  await handler({user, body, query}, response, error => { caught = error })
  if (caught) throw caught
  return {status, payload}
}

function appFor(user) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = user
    req.userRole = user.role
    req.auth = {type: 'USER_SESSION', role: user.role, user}
    next()
  })
  app.use(createRoutes())
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({message: error.message}))
  return app
}

function entry(f, index, value = 10) {
  return {pointPrelevementId: f.point.id, exploitationId: f.exploitations[index].id, usageId: f.usage.id, value}
}

function bodyFor(f, entries, extra = {}) {
  return {...period, declarantUserId: f.owner.id, entries, ...extra}
}

async function setExcluded(exploitation, excludeFromQuickDeclaration = true) {
  return prisma.declarantPointPrelevement.update({where: {id: exploitation.id}, data: {excludeFromQuickDeclaration}})
}

async function assertExcluded(t, promise) {
  const error = await t.throwsAsync(promise)
  t.is(error.statusCode, 403)
  t.is(error.message, excludedMessage)
}

async function snapshot(f) {
  return {
    declarations: await prisma.declaration.findMany({where: {declarantUserId: f.owner.id}, orderBy: {id: 'asc'}}),
    chunks: await prisma.chunk.findMany({where: {pointPrelevementId: f.point.id}, orderBy: {id: 'asc'}, include: {chunkValues: {orderBy: {id: 'asc'}}}})
  }
}

integration('le défaut SQL et les créations API conservent un booléen explicite, les patches omis le préservent', async t => {
  const f = await fixture(['001'])
  t.false(f.exploitations[0].excludeFromQuickDeclaration)
  const app = appFor(f.admin)
  const payload = {declarantUserId: f.owner.id, pointPrelevementId: f.point.id, usageId: f.usage.id, status: 'EN_ACTIVITE'}
  for (const [countingCode, extra, expected] of [['002', {}, false], ['003', {excludeFromQuickDeclaration: true}, true], ['004', {excludeFromQuickDeclaration: false}, false]]) {
    const point = await prisma.pointPrelevement.create({data: {name: `Création exclusion ${randomUUID()}`, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'}})
    const created = await request(app).post('/exploitations').send({...payload, pointPrelevementId: point.id, countingCode, ...extra})
    t.is(created.status, 200, JSON.stringify(created.body))
    t.is(created.body.excludeFromQuickDeclaration, expected)
  }

  const path = `/exploitations/${f.exploitations[0].id}`
  t.true((await request(app).put(path).send({excludeFromQuickDeclaration: true})).body.excludeFromQuickDeclaration)
  const omitted = await request(app).put(path).send({comment: 'Modification sans changer l’exclusion'})
  t.is(omitted.status, 200)
  t.true(omitted.body.excludeFromQuickDeclaration)
  t.true((await request(appFor(f.owner)).get(path)).body.excludeFromQuickDeclaration)
  t.true((await request(appFor(f.collector)).get(path)).body.excludeFromQuickDeclaration)
  t.false((await request(app).put(path).send({excludeFromQuickDeclaration: false})).body.excludeFromQuickDeclaration)
  t.false((await prisma.declarantPointPrelevement.findUniqueOrThrow({where: {id: f.exploitations[0].id}})).excludeFromQuickDeclaration)
})

integration('seuls les administrateurs et agents ayant le droit habituel sur la zone peuvent basculer l’exclusion', async t => {
  const f = await fixture(['001'])
  const zoneId = randomUUID()
  await prisma.$executeRaw`INSERT INTO "Zone" (id,code,type,name,coordinates,"createdAt","updatedAt")
    VALUES (${zoneId}::uuid, ${zoneId}, 'SAGE', 'Zone synthétique exclusion', ST_Multi(ST_GeomFromText('POLYGON((0 0,0 1,1 1,1 0,0 0))',4326)), now(),now())`
  await prisma.pointPrelevementZone.create({data: {pointPrelevementId: f.point.id, zoneId}})
  const instructor = await prisma.user.create({data: {role: 'INSTRUCTOR', instructor: {create: {}}}})
  const right = await prisma.instructorZone.create({data: {
    instructorUserId: instructor.id, zoneId, startDate: new Date('2020-01-01Z'),
    permissions: {create: [{permission: 'exploitation.detail.read'}, {permission: 'exploitation.update'}]}
  }})
  const path = `/exploitations/${f.exploitations[0].id}`
  for (const actor of [f.owner, f.collector]) {
    t.is((await request(appFor(actor)).put(path).send({excludeFromQuickDeclaration: true})).status, 403)
  }

  const changed = await request(appFor(instructor)).put(path).send({excludeFromQuickDeclaration: true})
  t.is(changed.status, 200)
  t.true(changed.body.excludeFromQuickDeclaration)
  await prisma.instructorZonePermission.deleteMany({where: {instructorZoneId: right.id, permission: 'exploitation.update'}})
  t.is((await request(appFor(instructor)).put(path).send({excludeFromQuickDeclaration: false})).status, 403)
  t.true((await prisma.declarantPointPrelevement.findUniqueOrThrow({where: {id: f.exploitations[0].id}})).excludeFromQuickDeclaration)
  t.is((await request(appFor(f.admin)).put(path).send({excludeFromQuickDeclaration: false})).status, 200)
})

for (const actorName of ['owner', 'collector']) {
  integration(`${actorName} ne voit plus l’exploitation exclue et ne peut ni créer ni corriger sa saisie rapide`, async t => {
    const f = await fixture()
    const actor = f[actorName]
    t.is((await invoke(createQuickDeclarationHandler, actor, bodyFor(f, [entry(f, 0), entry(f, 1, 20)]))).status, 201)
    await setExcluded(f.exploitations[0])
    const before = await snapshot(f)
    const context = await invoke(getQuickDeclarationContextHandler, actor, undefined, {declarantUserId: f.owner.id})
    t.deepEqual(context.payload.data.points.map(point => point.exploitationId), [f.exploitations[1].id])
    for (const handler of [previewQuickDeclarationConflictsHandler, createQuickDeclarationHandler]) {
      await assertExcluded(t, invoke(handler, actor, bodyFor(f, [entry(f, 0, 12)])))
      await assertExcluded(t, invoke(handler, actor, bodyFor(f, [entry(f, 1, 25), entry(f, 0, 12)])))
      await assertExcluded(t, invoke(handler, actor, bodyFor(f, [entry(f, 0, 100)], {measurementType: 'INDEX', readingDate: '2026-07-01'})))
      const ambiguous = entry(f, 0)
      delete ambiguous.exploitationId
      t.is((await t.throwsAsync(invoke(handler, actor, bodyFor(f, [ambiguous])))).statusCode, 409)
    }

    t.deepEqual(await snapshot(f), before, 'A refused correction or batch must preserve existing declarations and values.')
    const preview = await invoke(previewQuickDeclarationConflictsHandler, actor, bodyFor(f, [entry(f, 1, 25)]))
    t.true(preview.payload.data.hasConflicts)
    t.is((await invoke(createQuickDeclarationHandler, actor, bodyFor(f, [entry(f, 1, 25)]))).status, 201)
    const values = await prisma.chunkValue.findMany({where: {metricTypeCode: 'volume', chunk: {pointPrelevementId: f.point.id, instructionStatus: {not: 'REJECTED'}, source: {status: 'COMPLETED'}}}, include: {chunk: true}})
    t.deepEqual(values.map(row => [row.chunk.exploitationId, Number(row.value)]).sort(), [[f.exploitations[0].id, 10], [f.exploitations[1].id, 25]].sort())
    await setExcluded(f.exploitations[0], false)
    t.is((await invoke(createQuickDeclarationHandler, actor, bodyFor(f, [entry(f, 0, 12)]))).status, 201)
  })
}

integration('un payload historique non ambigu est refusé lorsque sa seule exploitation est exclue', async t => {
  const f = await fixture([null])
  await setExcluded(f.exploitations[0])
  const legacy = entry(f, 0)
  delete legacy.exploitationId
  for (const handler of [previewQuickDeclarationConflictsHandler, createQuickDeclarationHandler]) {
    await assertExcluded(t, invoke(handler, f.owner, bodyFor(f, [legacy])))
  }

  const context = (await invoke(getQuickDeclarationContextHandler, f.owner)).payload.data
  t.is(context.points.length, 0)
  t.false(context.canCreateQuickDeclaration)
  t.true(context.quickDeclarationEnabled)
  t.is(await prisma.declaration.count({where: {declarantUserId: f.owner.id}}), 0)
})

integration('les capacités du flux et du contexte suivent la dernière exploitation éligible du préleveur et du collecteur', async t => {
  const f = await fixture()
  await setExcluded(f.exploitations[0])
  for (const expected of [true, false]) {
    if (!expected) await setExcluded(f.exploitations[1])
    for (const actor of [f.owner, f.collector]) {
      for (const path of ['/declarations/me', '/declarations/allowed-types', '/declarations/allowed-types?includePreleveurs=false']) {
        const result = await request(appFor(actor)).get(path)
        t.is(result.status, 200, JSON.stringify(result.body))
        t.true(result.body.meta.quickDeclarationEnabled)
        t.is(result.body.meta.canCreateQuickDeclaration, expected)
        if (actor.id === f.collector.id && !path.includes('includePreleveurs=false')) {
          t.is(result.body.meta.preleveurs.find(preleveur => preleveur.id === f.owner.id).canCreateQuickDeclaration, expected)
        }
      }

      const context = (await invoke(getQuickDeclarationContextHandler, actor, undefined, {declarantUserId: f.owner.id})).payload.data
      t.is(context.canCreateQuickDeclaration, expected)
      t.is(context.points.length, expected ? 1 : 0)
      t.true(context.quickDeclarationEnabled)
    }
  }
})

integration('les capacités appliquent les mêmes critères de collecte, statut et dates que le contexte rapide', async t => {
  const unavailableCases = [
    {point: {collectionMode: 'EXTERNAL'}},
    {point: {deletedAt: new Date()}},
    {exploitation: {status: 'ABANDONNEE'}},
    {exploitation: {startDate: new Date(Date.now() + 24 * 60 * 60 * 1000)}},
    {exploitation: {endDate: new Date(Date.now() - 24 * 60 * 60 * 1000)}}
  ]
  for (const unavailable of unavailableCases) {
    const f = await fixture(['001'])
    if (unavailable.point) await prisma.pointPrelevement.update({where: {id: f.point.id}, data: unavailable.point})
    if (unavailable.exploitation) await prisma.declarantPointPrelevement.update({where: {id: f.exploitations[0].id}, data: unavailable.exploitation})
    for (const actor of [f.owner, f.collector]) {
      const {meta} = await getAllowedTypesMetaForDeclarant(actor.id)
      t.false(meta.canCreateQuickDeclaration)
      const context = (await invoke(getQuickDeclarationContextHandler, actor, undefined, {declarantUserId: f.owner.id})).payload.data
      t.false(context.canCreateQuickDeclaration)
      t.deepEqual(context.points, [])
    }
  }
})

integration('une exploitation éligible non déléguée ne réactive pas la saisie rapide du collecteur', async t => {
  const f = await fixture()
  await setExcluded(f.exploitations[0])
  await prisma.declarantCollecteurExploitation.deleteMany({where: {collecteurUserId: f.collector.id, exploitationId: f.exploitations[1].id}})

  t.true((await getAllowedTypesMetaForDeclarant(f.owner.id)).meta.canCreateQuickDeclaration)
  const {meta} = await getAllowedTypesMetaForDeclarant(f.collector.id)
  t.false(meta.canCreateQuickDeclaration)
  t.false(meta.preleveurs.find(preleveur => preleveur.id === f.owner.id).canCreateQuickDeclaration)
  const context = (await invoke(getQuickDeclarationContextHandler, f.collector, undefined, {declarantUserId: f.owner.id})).payload.data
  t.false(context.canCreateQuickDeclaration)
  t.deepEqual(context.points, [])
})

integration('l’exclusion ne se propage pas à un autre préleveur exploitant le même point', async t => {
  const f = await fixture(['001'])
  await setExcluded(f.exploitations[0])
  const other = await prisma.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT'}}}})
  const exploitation = await prisma.declarantPointPrelevement.create({data: {declarantUserId: other.id, pointPrelevementId: f.point.id, usageId: f.usage.id, status: 'EN_ACTIVITE'}})
  const context = await invoke(getQuickDeclarationContextHandler, other)
  t.deepEqual(context.payload.data.points.map(point => point.exploitationId), [exploitation.id])
  const body = {...period, entries: [{...entry(f, 0), exploitationId: exploitation.id}]}
  t.is((await invoke(createQuickDeclarationHandler, other, body)).status, 201)
  t.is(await prisma.declaration.count({where: {declarantUserId: f.owner.id}}), 0)
})

integration('la relecture Serializable refuse une exclusion activée après la vérification initiale', async t => {
  const f = await fixture(['001'])
  const originalTransaction = prisma.$transaction
  let intercepted = false
  prisma.$transaction = async function (callback, options) {
    if (!intercepted && options?.isolationLevel === 'Serializable') {
      intercepted = true
      await setExcluded(f.exploitations[0])
    }

    return originalTransaction.call(prisma, callback, options)
  }

  try {
    await assertExcluded(t, invoke(createQuickDeclarationHandler, f.owner, bodyFor(f, [entry(f, 0)])))
    t.true(intercepted)
    t.is(await prisma.declaration.count({where: {declarantUserId: f.owner.id}}), 0)
    t.is(await prisma.chunk.count({where: {pointPrelevementId: f.point.id}}), 0)
  } finally {
    prisma.$transaction = originalTransaction
  }
})

integration('les noms d’usage annexes ne permettent pas de modifier un point dont toutes les exploitations sont exclues', async t => {
  const f = await fixture(['001'])
  const point = await prisma.pointPrelevement.create({data: {name: `Point annexe ${randomUUID()}`, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT', collectionMode: 'MANUAL'}})
  await prisma.declarantPointPrelevement.create({data: {declarantUserId: f.owner.id, pointPrelevementId: point.id, usageId: f.usage.id, status: 'EN_ACTIVITE', excludeFromQuickDeclaration: true}})
  const body = bodyFor(f, [entry(f, 0)], {pointUsageNames: [{pointPrelevementId: point.id, usageName: 'Modification interdite'}]})
  for (const handler of [previewQuickDeclarationConflictsHandler, createQuickDeclarationHandler]) {
    await assertExcluded(t, invoke(handler, f.owner, body))
  }

  t.is((await prisma.pointPrelevement.findUniqueOrThrow({where: {id: point.id}})).usageName, null)
  t.is(await prisma.declaration.count({where: {declarantUserId: f.owner.id}}), 0)
})

integration('une exploitation exclue reste ciblable, saisissable et corrigeable dans sa campagne', async t => {
  const f = await fixture(['001'])
  await setExcluded(f.exploitations[0])
  const today = Date.now()
  const opensOn = new Date(today - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const closesOn = new Date(Math.max(today + 2 * 24 * 60 * 60 * 1000, Date.parse('2026-12-31'))).toISOString().slice(0, 10)
  const campaign = await createCollectionCampaign({name: 'Campagne synthétique exclusion', opensOn, closesOn, collecteurUserId: f.collector.id, exploitationIds: [f.exploitations[0].id]}, {user: f.admin})
  await transitionCollectionCampaign(f.admin, campaign.id, 'open')
  const response = await prisma.collectionResponse.findFirstOrThrow({where: {campaignId: campaign.id}})
  for (const actor of [f.owner, f.collector]) {
    const context = await getAuthorizedCampaignResponseContext(actor, campaign.id, response.id)
    t.true(context.permissions.canEdit)
    t.true(context.permissions.canSubmit)
  }

  const fields = {usageId: f.usage.id, surface: '1', crops: 'Culture synthétique'}
  const data = {meters: [{serialNumber: `EXCLUSION-${randomUUID()}`, offSeason: {...fields, indexStart: '100', indexEnd: '200'}, season: {...fields, indexEnd: '260'}}], needs: {offSeason: {...fields, flow: '1', volume: '100'}, season: {...fields, flow: '1', volume: '60'}}, comment: ''}
  await saveCollectionResponseDraft(f.owner, campaign.id, response.id, {revision: 0, data})
  const submitted = await submitCampaignResponse({user: f.owner, campaignId: campaign.id, responseId: response.id, body: {revision: 1, data}})
  t.is(submitted.response.publicationStatus, 'PUBLISHED')
  const correctedData = structuredClone(submitted.response.submittedData)
  correctedData.meters[0].season.indexEnd = '280'
  const corrected = await submitCampaignResponse({user: f.collector, campaignId: campaign.id, responseId: response.id, body: {revision: submitted.response.revision, data: correctedData}})
  t.is(corrected.response.publicationStatus, 'PUBLISHED')
  t.is(corrected.response.declarationId, submitted.response.declarationId)
  t.is(corrected.response.revision, submitted.response.revision + 1)
  t.true((await prisma.declarantPointPrelevement.findUniqueOrThrow({where: {id: f.exploitations[0].id}})).excludeFromQuickDeclaration)
})

integration('un import de fichier continue à rapprocher une exploitation exclue de la saisie rapide', async t => {
  const f = await fixture(['001'])
  await setExcluded(f.exploitations[0])
  const declaration = await prisma.declaration.create({data: {code: randomUUID().slice(0, 6).toUpperCase(), type: 'template-file', declarantUserId: f.owner.id, createdByDeclarantUserId: f.owner.id, dataSourceType: 'MANUAL', waterWithdrawalType: 'unknown'}})
  const series = [{pointPrelevement: f.point.name, countingCode: '001', parameter: 'volume', unit: 'm³', frequency: '1 day', minDate: '2026-04-01', maxDate: '2026-04-01', usageId: f.usage.id,
    data: [{date: '2026-04-01', periodStart: '2026-04-01T00:00:00Z', periodEnd: '2026-04-02T00:00:00Z', value: 15}]}]
  const result = await ingestDeclarationSeries({declarationId: declaration.id, data: {conflictPolicy: 'REPLACE_EXISTING', series}, logger: {log() {}, warn() {}, error() {}}})
  t.true(result.imported)
  const chunks = await prisma.chunk.findMany({where: {sourceId: result.sourceId}, include: {chunkValues: true}})
  t.is(chunks.length, 1)
  t.is(chunks[0].exploitationId, f.exploitations[0].id)
  t.is(Number(chunks[0].chunkValues[0].value), 15)
})
