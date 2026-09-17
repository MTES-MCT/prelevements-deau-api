import test from 'ava'
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import express from 'express'
import request from 'supertest'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {ingestMeterBatch, getMeterStreamContext} from '../meter-ingestion.js'
import {reprocessMeterStream} from '../meter-publication.js'
import {replayMeterStreams} from '../meter-replay.js'
import {getMeterAllocationSettings, updateMeterAllocationSettings, searchMeterAllocationTargets} from '../meter-allocation-editing.js'
import {getExploitationMeterReadingsHandler} from '../../handlers/meters.js'
import {createRoutes} from '../../routes.js'
import {updateExploitationById} from '../../models/exploitation.js'
import {validateChanges} from '../../validation/exploitation-validation.js'
import {createServiceAccountAccessToken} from '../../models/service-account-token.js'
import {createSessionToken} from '../../models/session-token.js'

const integration = process.env.METER_INTEGRATION_TESTS === '1' ? test.serial : test.skip
test.before(() => { if (process.env.METER_INTEGRATION_TESTS === '1') requireDisposableDatabase() })
test.after.always(async () => {
  await prisma.$disconnect()
  await globalThis.pgPool?.end()
})

async function fixture({shares = [70, 30], external = 0, enabled = true, targetExploitation,
  provider = 'sample-provider', scope = 'sample-scope', supersedeSameMeter = false, activationDate = '2026-07-01Z'} = {}) {
  const key = randomUUID()
  const user = await prisma.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT'}}}})
  const admin = await prisma.user.create({data: {role: 'ADMIN'}})
  const usage = await prisma.sandreWaterUse.findFirst({where: {kind: 'USAGE'}})
  const point = await prisma.pointPrelevement.create({data: {name: `Meter integration ${key}`, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'}})
  const exploitation = await prisma.declarantPointPrelevement.create({data: {
    pointPrelevementId: point.id, declarantUserId: user.id, usageId: usage.id, status: 'EN_ACTIVITE'
  }})
  const meter = await prisma.compteur.create({data: {serialNumber: key}})
  const account = await prisma.serviceAccount.create({data: {name: `Meter ${key}`}})
  const allocationSnapshot = shares.map((percentage, index) => ({key: `${key}:${index}`, percentage: String(percentage), inScope: true}))
  if (external) allocationSnapshot.push({key: `${key}:external`, percentage: String(external), inScope: false})
  const stream = await prisma.meterStream.create({data: {
    compteurId: meter.id, externalId: key, serviceAccountId: account.id, enabled, provider, scope, supersedeSameMeter,
    activatedAt: enabled ? new Date(activationDate) : null,
    allocationSnapshot, allocationSnapshotValidated: true
  }})
  await Promise.all(shares.map((percentage, index) => prisma.meterAllocation.create({data: {
    sourceId: `${key}:${index}`, provider, scope, metadata: {contractId: `${index}`, lieuId: key}, compteurId: meter.id, exploitationId: targetExploitation?.id ?? exploitation.id,
    versions: {create: {version: 1, enabled: true, startDate: new Date(activationDate), percentage,
      metadata: {allocationSnapshot, allocationSnapshotValidated: true}}}
  }})))
  return {key, provider, scope, user, admin, usage, point, exploitation, meter, account, stream,
    actor: {serviceAccountId: account.id}, adminActor: {user: admin}}
}

function batch(context, {id = randomUUID(), fetchedAt = '2026-07-16T10:00:00Z', values = [100, 110], mode = 'LIVE', quality = 'sample-quality'} = {}) {
  return {
    provider: context.provider, scope: context.scope, batchId: id, windowStart: '2026-07-01T00:00:00Z', windowEnd: '2026-07-16T00:00:00Z', fetchedAt, complete: true, mode,
    readings: values.map((value, index) => ({externalId: context.key, observedAt: `2026-07-${String(index + 2).padStart(2, '0')}T00:00:00Z`, index: String(value), status: 'VALID', quality, origin: 'test', raw: {originalIndex: value}}))
  }
}

async function activeValues(context) {
  return prisma.chunkValue.findMany({where: {chunk: {compteurId: context.meter.id, calculationStrategy: 'METER', instructionStatus: {not: 'REJECTED'}}}, orderBy: {periodStart: 'asc'}})
}

integration('atomic shared-meter publication conserves shares, groups contracts and replays exactly', async t => {
  const f = await fixture({shares: [40, 30], external: 30})
  const payload = batch(f)
  const result = await ingestMeterBatch(payload, f.actor)
  t.true(result.persisted)
  t.is(result.counts.received, 2)
  t.is(result.counts.published, 1)
  const publication = await prisma.meterPublication.findFirst({where: {compteurId: f.meter.id}, include: {contributions: true}})
  t.is(publication.physicalVolume.toString(), '10')
  t.is(publication.inScopeVolume.toString(), '7')
  t.is(publication.outOfScopeVolume.toString(), '3')
  t.is(publication.contributions.length, 2)
  t.is(new Set(publication.contributions.map(row => row.chunkValueId)).size, 1)
  t.is((await activeValues(f))[0].value.toString(), '7')
  t.deepEqual(await ingestMeterBatch(payload, f.actor), result)
  const error = await t.throwsAsync(ingestMeterBatch({...payload, readings: []}, f.actor))
  t.is(error.status, 409)
  t.is(await prisma.meterIngestion.count({where: {serviceAccountId: f.account.id}}), 1)
})

integration('canonical revisions supersede visible volumes, preserve audit, and ignore OFFLINE/delayed LIVE', async t => {
  const f = await fixture()
  await ingestMeterBatch(batch(f), f.actor)
  await ingestMeterBatch(batch(f, {values: [100, 120], fetchedAt: '2026-07-16T11:00:00Z'}), f.actor)
  t.is((await activeValues(f))[0].value.toString(), '20')
  const historical = await prisma.meterPublication.findMany({where: {compteurId: f.meter.id}, include: {source: {include: {chunks: true}}}})
  t.is(historical.length, 2)
  t.is(historical.filter(row => row.active).length, 1)
  t.true(historical.filter(row => !row.active).every(row => row.source.chunks.every(chunk => chunk.instructionStatus === 'REJECTED')))
  await ingestMeterBatch(batch(f, {values: [100, 999], fetchedAt: '2026-07-16T12:00:00Z', mode: 'OFFLINE'}), f.adminActor)
  await ingestMeterBatch(batch(f, {values: [100, 888], fetchedAt: '2026-07-16T10:30:00Z'}), f.actor)
  t.is((await activeValues(f))[0].value.toString(), '20')
  const revision = await prisma.meterReadingRevision.findFirst({where: {streamId: f.stream.id}})
  await t.throwsAsync(prisma.meterReadingRevision.update({where: {id: revision.id}, data: {index: 1}}))
})

integration('bad quality and decreasing index never bridge; future valid correction republish is atomic', async t => {
  const f = await fixture()
  await ingestMeterBatch(batch(f, {values: [100, 110, 120]}), f.actor)
  const invalid = batch(f, {values: [100, 110, 120], fetchedAt: '2026-07-16T11:00:00Z'})
  invalid.readings[1].status = 'INVALID'
  invalid.readings[1].reason = 'producer-quality-decision'
  await ingestMeterBatch(invalid, f.actor)
  t.is((await activeValues(f)).length, 0)
  await ingestMeterBatch(batch(f, {values: [100, 90, 120], fetchedAt: '2026-07-16T12:00:00Z'}), f.actor)
  const active = await activeValues(f)
  t.is(active.length, 1)
  t.is(active[0].value.toString(), '30')
  t.is(active[0].periodStart.toISOString(), '2026-07-03T00:00:00.000Z')
})

integration('malformed raw rows persist; unknown timestamp blocks known meter window until newer complete batch', async t => {
  const f = await fixture()
  const invalid = batch(f)
  invalid.readings.push(
    {externalId: null, observedAt: null, index: null, status: 'INVALID', raw: null},
    {externalId: null, observedAt: null, index: null, status: 'INVALID', raw: 42},
    {externalId: f.key, observedAt: null, index: '130', status: 'INVALID', reason: 'producer-time-decision', raw: {timestamp: 'bad date'}}
  )
  const result = await ingestMeterBatch(invalid, f.actor)
  t.is(result.counts.received, 5)
  t.is(result.counts.blocked, 3)
  t.is((await activeValues(f)).length, 0)
  t.is((await prisma.meterIngestion.findUnique({where: {id: result.ingestionId}})).rawPayload.length, 5)
  await ingestMeterBatch(batch(f, {fetchedAt: '2026-07-16T11:00:00Z'}), f.actor)
  t.is((await activeValues(f)).length, 1)
})

integration('stream scope, OFFLINE rights and physical reading rights cannot leak beneficiaries', async t => {
  const f = await fixture()
  const other = await fixture()
  const context = await getMeterStreamContext({provider: f.provider, scope: f.scope}, f.actor)
  t.deepEqual(context.streams.map(stream => stream.id), [f.stream.id])
  const unknown = await ingestMeterBatch(batch(other), f.actor)
  t.is(unknown.counts.unknownMeters, 2)
  t.is(await prisma.meterReading.count({where: {compteurId: other.meter.id}}), 0)
  t.is((await t.throwsAsync(ingestMeterBatch(batch(f, {mode: 'OFFLINE'}), f.actor))).status, 403)
  t.is((await t.throwsAsync(getExploitationMeterReadingsHandler({user: f.user, params: {exploitationId: f.exploitation.id, meterId: f.meter.id}}, {}))).status, 403)
})

async function ordinaryVolume(f, compteurId, value = 500) {
  const source = await prisma.source.create({data: {type: 'API', status: 'COMPLETED'}})
  const chunk = await prisma.chunk.create({data: {
    sourceId: source.id, pointPrelevementId: f.point.id, preleveurUserId: f.user.id,
    compteurId, usageId: f.usage.id, minDate: new Date('2026-07-02Z'), maxDate: new Date('2026-07-03Z'), instructionStatus: 'VALIDATED'
  }})
  const data = {chunkId: chunk.id, periodStart: new Date('2026-07-02Z'), periodEnd: new Date('2026-07-03Z'), metricTypeCode: 'volume', frequency: '1 day', value}
  const row = await prisma.chunkValue.create({data})
  return {source, chunk, row, data}
}

integration('known same meter replaces ordinary value with audit; unknown identity blocks', async t => {
  const f = await fixture({supersedeSameMeter: true})
  const ordinary = await ordinaryVolume(f, f.meter.id)
  await ingestMeterBatch(batch(f), f.actor)
  t.is(await prisma.chunkValue.count({where: {id: ordinary.row.id}}), 0)
  t.is(await prisma.chunkValueReplacement.count({where: {replacedChunkValueId: ordinary.row.id}}), 1)
  t.is((await activeValues(f))[0].value.toString(), '10')
  // This simulates an old API inserting after its earlier conflict-check transaction.
  await t.throwsAsync(prisma.chunkValue.create({data: ordinary.data}))
  const unknown = await fixture()
  await ordinaryVolume(unknown, null)
  const result = await ingestMeterBatch(batch(unknown), unknown.actor)
  t.is(result.counts.conflicts, 1)
  t.is((await activeValues(unknown)).length, 0)
})

integration('allocation closure is allowed, changing percentage is not; crossing cutoff is not interpolated', async t => {
  const f = await fixture({shares: [100]})
  await ingestMeterBatch(batch(f), f.actor)
  const version = await prisma.meterAllocationVersion.findFirst({where: {allocation: {compteurId: f.meter.id}}})
  await t.throwsAsync(prisma.meterAllocationVersion.update({where: {id: version.id}, data: {percentage: 90}}))
  await prisma.meterAllocationVersion.update({where: {id: version.id}, data: {endDate: new Date('2026-07-02T12:00Z')}})
  const closed = await prisma.meterAllocationVersion.findUnique({where: {id: version.id}})
  t.is(closed.metadata._periodClosures.length, 1)
  await reprocessMeterStream(f.stream.id)
  t.is((await activeValues(f)).length, 0)
  await t.throwsAsync(prisma.meterAllocationVersion.update({where: {id: version.id}, data: {endDate: null}}))
  await t.throwsAsync(prisma.declarantPointPrelevement.update({where: {id: f.exploitation.id}, data: {declarantUserId: (await fixture()).user.id}}))
})

integration('concurrent batches serialize canonical revisions and prevent duplicate publication', async t => {
  const f = await fixture({shares: [100]})
  const payload = batch(f)
  const results = await Promise.all([ingestMeterBatch(payload, f.actor), ingestMeterBatch(payload, f.actor)])
  t.is(results[0].ingestionId, results[1].ingestionId)
  t.is(await prisma.meterPublication.count({where: {compteurId: f.meter.id, active: true}}), 1)
})

integration('equal-time contradictory fetches quarantine canonical reading, a later fetch resolves it', async t => {
  const f = await fixture({shares: [100]})
  await ingestMeterBatch(batch(f), f.actor)
  const conflicting = await ingestMeterBatch(batch(f, {values: [100, 120]}), f.actor)
  t.is(conflicting.counts.blocked, 1)
  t.is((await activeValues(f)).length, 0)
  await ingestMeterBatch(batch(f, {values: [100, 120], fetchedAt: '2026-07-16T11:00:00Z'}), f.actor)
  t.is((await activeValues(f))[0].value.toString(), '20')
})

integration('publication failure rolls back durable batch, readings, revisions and values together', async t => {
  const f = await fixture({shares: [100]})
  const failingClient = {$transaction: (callback, options) => prisma.$transaction(tx => callback(new Proxy(tx, {
    get(target, property) {
      if (property === 'meterVolumeContribution') return {
        ...target[property], createMany() { throw new Error('INJECTED_PUBLICATION_FAILURE') }
      }
      return target[property]
    }
  })), options)}
  await t.throwsAsync(ingestMeterBatch(batch(f), f.actor, {client: failingClient}), {message: 'INJECTED_PUBLICATION_FAILURE'})
  t.is(await prisma.meterIngestion.count({where: {serviceAccountId: f.account.id}}), 0)
  t.is(await prisma.meterReading.count({where: {compteurId: f.meter.id}}), 0)
  t.is(await prisma.meterPublication.count({where: {compteurId: f.meter.id}}), 0)
  t.is((await activeValues(f)).length, 0)
})

integration('readings are cursor-paginated only inside an explicit exploitation/meter association', async t => {
  const f = await fixture({shares: [100]})
  await ingestMeterBatch(batch(f, {values: [100, 110, 120]}), f.actor)
  const request = {user: f.admin, params: {exploitationId: f.exploitation.id, meterId: f.meter.id}, query: {limit: '2'}}
  let body
  await getExploitationMeterReadingsHandler(request, {send(value) { body = value }})
  t.is(body.items.length, 2)
  t.truthy(body.nextCursor)
  t.is(body.items[0].index, '120')
  await getExploitationMeterReadingsHandler({...request, query: {cursor: body.nextCursor, limit: '2'}}, {send(value) { body = value }})
  t.is(body.items.length, 1)
  t.is(body.items[0].index, '100')
  t.is(body.nextCursor, null)
  const other = await fixture()
  t.is((await t.throwsAsync(getExploitationMeterReadingsHandler({...request, params: {...request.params, meterId: other.meter.id}}, {}))).status, 404)
})

integration('preactivation history is retained but not interpolated into the activation window', async t => {
  const f = await fixture({shares: [100]})
  await prisma.meterStream.update({where: {id: f.stream.id}, data: {activatedAt: new Date('2026-07-02T12:00Z')}})
  const result = await ingestMeterBatch(batch(f, {values: [100, 110, 120]}), f.actor)
  t.is(result.counts.accepted, 3)
  t.is(result.counts.published, 1)
  t.is((await activeValues(f))[0].periodStart.toISOString(), '2026-07-03T00:00:00.000Z')
  t.is(await prisma.meterReading.count({where: {compteurId: f.meter.id}}), 3)
})

integration('database guards also block late completion and reconciliation of an ordinary source', async t => {
  const f = await fixture({shares: [100]})
  const pending = await ordinaryVolume(f, null)
  await prisma.source.update({where: {id: pending.source.id}, data: {status: 'PENDING'}})
  await ingestMeterBatch(batch(f), f.actor)
  await t.throwsAsync(prisma.source.update({where: {id: pending.source.id}, data: {status: 'COMPLETED'}}))
  await prisma.chunk.update({where: {id: pending.chunk.id}, data: {instructionStatus: 'REJECTED'}})
  await t.throwsAsync(prisma.chunk.update({where: {id: pending.chunk.id}, data: {instructionStatus: 'VALIDATED'}}))
})

integration('distinct physical meters add only when both dated allocations explicitly allow it', async t => {
  const f = await fixture({shares: [100]})
  const other = await fixture({shares: [100], targetExploitation: f.exploitation})
  // Activated versions are immutable, so additions are a newly validated version.
  const firstVersions = await prisma.meterAllocationVersion.findMany({where: {allocation: {compteurId: {in: [f.meter.id, other.meter.id]}}}})
  await Promise.all(firstVersions.map(version => prisma.meterAllocationVersion.update({where: {id: version.id}, data: {enabled: false}})))
  await Promise.all(firstVersions.map(version => prisma.meterAllocationVersion.create({data: {
    allocationId: version.allocationId, version: 2, startDate: version.startDate, percentage: version.percentage,
    enabled: true, additive: true, metadata: version.metadata
  }})))
  await ingestMeterBatch(batch(f), f.actor)
  await ingestMeterBatch(batch(other, {values: [50, 55]}), other.actor)
  t.is((await activeValues(f))[0].value.toString(), '10')
  t.is((await activeValues(other))[0].value.toString(), '5')
})

integration('allocation and stream identities cannot rewrite historical contribution ownership', async t => {
  const f = await fixture({shares: [100]})
  const other = await fixture({shares: [100]})
  await ingestMeterBatch(batch(f), f.actor)
  const allocation = await prisma.meterAllocation.findFirst({where: {compteurId: f.meter.id}})
  await t.throwsAsync(prisma.meterAllocation.update({where: {id: allocation.id}, data: {exploitationId: other.exploitation.id}}))
  await t.throwsAsync(prisma.meterAllocation.update({where: {id: allocation.id}, data: {compteurId: other.meter.id}}))
  await t.throwsAsync(prisma.meterStream.update({where: {id: f.stream.id}, data: {externalId: 'reassigned'}}))
})

function routeApp({user, serviceAccount, impersonation} = {}) {
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => {
    if (!user && !serviceAccount) return next()
    req.auth = {type: serviceAccount ? 'SERVICE_ACCOUNT_ACCESS' : 'USER_SESSION', impersonation}
    // ACCESS authentication also exposes a pseudo-user, not a User database row.
    req.user = serviceAccount ? {id: serviceAccount.id, name: serviceAccount.name} : user
    req.userRole = serviceAccount ? 'SERVICE_ACCOUNT' : user?.role
    req.serviceAccount = serviceAccount
    next()
  })
  app.use(createRoutes())
  app.use((error, req, res, next) => {
    res.status(error.status ?? 500).send({message: error.message})
  })
  return app
}

integration('real service-account token ingests and replays with service-account-only audit', async t => {
  const f = await fixture({shares: [100]})
  const other = await fixture({shares: [100]})
  const {token} = await createServiceAccountAccessToken(f.account.id, null)
  const app = routeApp()
  const payload = batch(f)
  const path = '/service-accounts/meter-readings/ingestions'
  t.is(await prisma.user.findUnique({where: {id: f.account.id}}), null)
  const context = await request(app).get(`/service-accounts/meter-streams?provider=${f.provider}&scope=${f.scope}`).auth(token, {type: 'bearer'})
  t.is(context.status, 200)
  t.deepEqual(context.body.streams.map(stream => stream.id), [f.stream.id])
  const response = await request(app).post(path).auth(token, {type: 'bearer'}).send(payload)
  t.is(response.status, 200)
  t.true(response.body.persisted)
  t.is(response.body.counts.published, 1)
  const ingestion = await prisma.meterIngestion.findUniqueOrThrow({where: {id: response.body.ingestionId}})
  t.is(ingestion.serviceAccountId, f.account.id)
  t.is(ingestion.actorUserId, null)
  const replay = await request(app).post(path).auth(token, {type: 'bearer'}).send(payload)
  t.is(replay.status, 200)
  t.deepEqual(replay.body, response.body)
  const foreignPayload = batch(other)
  const foreign = await request(app).post(path).auth(token, {type: 'bearer'}).send(foreignPayload)
  t.is(foreign.status, 200)
  t.is(foreign.body.counts.unknownMeters, 2)
  t.is(await prisma.meterReading.count({where: {compteurId: other.meter.id}}), 0)
  t.is((await request(app).post(path).auth(token, {type: 'bearer'}).send(batch(f, {mode: 'OFFLINE'}))).status, 403)
  t.is((await request(app).post('/admin/meter-readings/ingestions').auth(token, {type: 'bearer'}).send(batch(f, {mode: 'OFFLINE'}))).status, 403)
})

integration('domain service-account identity cannot become a User audit or acquire attached admin privileges', async t => {
  const f = await fixture({shares: [100]})
  const other = await fixture({provider: 'other-provider'})
  const payload = batch(f)
  const actor = {...f.actor, user: {id: f.account.id, name: f.account.name}}
  const result = await ingestMeterBatch(payload, actor)
  const ingestion = await prisma.meterIngestion.findUniqueOrThrow({where: {id: result.ingestionId}})
  t.is(ingestion.serviceAccountId, f.account.id)
  t.is(ingestion.actorUserId, null)
  t.deepEqual(await ingestMeterBatch(payload, actor), result)
  const mixedActor = {...f.actor, user: f.admin}
  const context = await getMeterStreamContext({provider: f.provider, scope: f.scope}, mixedActor)
  t.deepEqual(context.streams.map(stream => stream.id), [f.stream.id])
  t.is((await t.throwsAsync(ingestMeterBatch(batch(f, {mode: 'OFFLINE'}), mixedActor))).status, 403)
  t.is((await t.throwsAsync(ingestMeterBatch(batch(other), mixedActor))).status, 403)
  t.is((await t.throwsAsync(ingestMeterBatch(payload, {...other.actor, user: other.admin}))).status, 409)
})

integration('dedicated HTTP routes enforce service-account, admin and exploitation permissions', async t => {
  const f = await fixture({shares: [100]})
  const other = await fixture({shares: [100]})
  const contextPath = `/service-accounts/meter-streams?provider=${f.provider}&scope=${f.scope}`
  const ingestionPath = '/service-accounts/meter-readings/ingestions'
  const adminPath = '/admin/meter-readings/ingestions'
  t.is((await request(routeApp()).get(contextPath)).status, 401)
  t.is((await request(routeApp({user: f.admin})).get(contextPath)).status, 401)
  t.is((await request(routeApp({serviceAccount: f.account})).get(contextPath)).status, 200)
  t.is((await request(routeApp({serviceAccount: f.account})).post(ingestionPath).send(batch(f, {mode: 'OFFLINE'}))).status, 403)
  t.is((await request(routeApp({user: f.user})).post(adminPath).send(batch(f, {mode: 'OFFLINE'}))).status, 403)
  t.is((await request(routeApp({user: f.admin, impersonation: true})).post(adminPath).send(batch(f, {mode: 'OFFLINE'}))).status, 403)
  const adminResponse = await request(routeApp({user: f.admin})).post(adminPath).send(batch(f, {mode: 'OFFLINE'}))
  t.is(adminResponse.status, 200)
  const adminIngestion = await prisma.meterIngestion.findUniqueOrThrow({where: {id: adminResponse.body.ingestionId}})
  t.is(adminIngestion.actorUserId, f.admin.id)
  t.is(adminIngestion.serviceAccountId, null)
  const allocationPath = `/exploitations/${f.exploitation.id}/meter-allocations`
  const allocationResponse = await request(routeApp({user: f.user})).get(allocationPath)
  t.is(allocationResponse.status, 200)
  t.false(allocationResponse.body.meterAllocations[0].capabilities.canReadGlobalReadings)
  t.is((await request(routeApp({user: other.user})).get(allocationPath)).status, 403)
  const readingsPath = `/exploitations/${f.exploitation.id}/meters/${f.meter.id}/readings`
  t.is((await request(routeApp({user: f.user})).get(readingsPath)).status, 403)
  t.is((await request(routeApp({serviceAccount: f.account})).get(readingsPath)).status, 403)
  t.is((await request(routeApp({user: f.admin})).get(readingsPath)).status, 200)
})

integration('two opaque providers use the same API without crossing namespace or service-account grants', async t => {
  const first = await fixture({provider: 'sample-provider'})
  const second = await fixture({provider: 'another-provider'})
  const sharedBatchId = randomUUID()
  const path = '/service-accounts/meter-readings/ingestions'
  for (const f of [first, second]) {
    // eslint-disable-next-line no-await-in-loop -- Two independent HTTP producers are exercised through the same route.
    const response = await request(routeApp({serviceAccount: f.account})).post(path).send(batch(f, {id: sharedBatchId}))
    t.is(response.status, 200)
    t.true(response.body.persisted)
  }
  const forbidden = await request(routeApp({serviceAccount: first.account})).post(path).send(batch(second))
  t.is(forbidden.status, 403)
  const missingNamespace = await request(routeApp({serviceAccount: first.account})).get('/service-accounts/meter-streams')
  t.is(missingNamespace.status, 400)
  const oldFormat = await request(routeApp({serviceAccount: first.account})).post(path).send({
    ...batch(first), readings: [{NumeroSerieCompteur: first.key, Date: '2026-07-02T02:00:00', Index: 100, CodeValidite: 'A'}]
  })
  t.is(oldFormat.status, 400)
  t.is(await prisma.meterIngestion.count({where: {serviceAccountId: first.account.id}}), 1)
})

integration('same physical meter does not supersede ordinary values without explicit stream policy', async t => {
  const f = await fixture({shares: [100]})
  const ordinary = await ordinaryVolume(f, f.meter.id)
  const result = await ingestMeterBatch(batch(f), f.actor)
  t.is(result.counts.conflicts, 1)
  t.is((await activeValues(f)).length, 0)
  t.is(await prisma.chunkValue.count({where: {id: ordinary.row.id}}), 1)
  t.is(await prisma.chunkValueReplacement.count({where: {replacedChunkValueId: ordinary.row.id}}), 0)
})

integration('legacy connector edits preserve identity and reject cross-exploitation UUIDs atomically', async t => {
  const f = await fixture({shares: [100]})
  const other = await fixture({shares: [100]})
  const retained = await prisma.declarantPointPrelevementConnector.create({data: {
    declarantPointPrelevementId: f.exploitation.id, connectorType: 'orange', connectorParameters: {meterId: 'serial-a'}, rate: 100
  }})
  const removed = await prisma.declarantPointPrelevementConnector.create({data: {
    declarantPointPrelevementId: f.exploitation.id, connectorType: 'aquasys', connectorParameters: {meterId: 'serial-b'}
  }})
  const foreign = await prisma.declarantPointPrelevementConnector.create({data: {
    declarantPointPrelevementId: other.exploitation.id, connectorType: 'orange', connectorParameters: {meterId: 'foreign'}
  }})
  await updateExploitationById(f.exploitation.id, validateChanges({connectors: [
    {id: retained.id, connectorType: 'orange', connectorParameters: {meterId: 'serial-a'}, rate: 75},
    {connectorType: 'aquasys', connectorParameters: {meterId: 'serial-c'}}
  ]}))
  const connectors = await prisma.declarantPointPrelevementConnector.findMany({where: {declarantPointPrelevementId: f.exploitation.id}})
  t.is(connectors.length, 2)
  const kept = connectors.find(connector => connector.id === retained.id)
  t.is(kept.createdAt.getTime(), retained.createdAt.getTime())
  t.is(Number(kept.rate), 75)
  t.false(connectors.some(connector => connector.id === removed.id))
  const denied = await t.throwsAsync(updateExploitationById(f.exploitation.id, validateChanges({
    comment: 'Cross-scope write must be rolled back', connectors: [{id: foreign.id, connectorType: 'orange', rate: 1}]
  })))
  t.is(denied.status, 409)
  t.is((await prisma.declarantPointPrelevement.findUnique({where: {id: f.exploitation.id}})).comment, null)
  t.is(Number((await prisma.declarantPointPrelevementConnector.findUnique({where: {id: foreign.id}})).rate), 100)
  t.is(await prisma.declarantPointPrelevementConnector.count({where: {declarantPointPrelevementId: f.exploitation.id}}), 2)
})

async function humanToken(user) {
  return (await createSessionToken(user.id, user.role, 3600, {authVersion: user.authVersion})).token
}

async function seriesFixture(options) {
  const f = await fixture(options)
  const zoneId = randomUUID()
  await prisma.$executeRaw`
    INSERT INTO "Zone" (id, code, type, name, coordinates, "createdAt", "updatedAt")
    VALUES (${zoneId}::uuid, ${f.key}, 'SAGE', ${`Series ${f.key}`},
      ST_Multi(ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 1,0 0))', 4326)), NOW(), NOW())
  `
  await prisma.pointPrelevementZone.create({data: {pointPrelevementId: f.point.id, zoneId}})
  return {...f, zoneId}
}

function physicalSeriesQuery(f, extras = {}) {
  return {pointIds: f.point.id, metricTypeCode: 'index', meterId: f.meter.id,
    temporalOperator: 'raw', aggregationFrequency: 'instantaneous', ...extras}
}

async function preactivationReadings(f, readings) {
  const instants = readings.map(([observedAt]) => new Date(observedAt).getTime())
  return ingestMeterBatch({
    ...batch(f, {mode: 'OFFLINE'}), windowStart: new Date(Math.min(...instants) - 86_400_000).toISOString(),
    windowEnd: new Date(Math.max(...instants) + 86_400_000).toISOString(),
    readings: readings.map(([observedAt, index, status = 'VALID']) => ({
      externalId: f.key, observedAt, index, status, quality: 'opaque-quality', origin: 'synthetic',
      ...(status === 'INVALID' ? {reason: 'SYNTHETIC_INVALID'} : {})
    }))
  }, f.adminActor)
}

integration('physical index options opt in, deduplicate meters and coexist with legacy series without writes', async t => {
  const f = await seriesFixture({scope: randomUUID()})
  await prisma.meterStream.update({where: {id: f.stream.id}, data: {activatedAt: new Date('2026-07-10Z')}})
  await preactivationReadings(f, [
    ['2026-06-30T22:00:00Z', '0.0000'], ['2026-06-30T22:03:04.123Z', '1.2345'],
    ['2026-06-30T23:00:00Z', '4.5678', 'INVALID'], ['2026-07-01T22:00:00Z', '8.0000']
  ])
  await prisma.meterStream.update({where: {id: f.stream.id}, data: {enabled: false}})
  const second = await fixture({scope: randomUUID(), enabled: false, targetExploitation: f.exploitation})
  await preactivationReadings(second, [['2026-06-30T22:00:00Z', '200.0000']])
  const ordinary = await ordinaryVolume(f, null)
  await prisma.chunkValue.create({data: {...ordinary.data, metricTypeCode: 'index', value: 999}})
  const snapshot = async () => Promise.all([
    prisma.source.count(), prisma.chunk.count(), prisma.chunkValue.count(),
    prisma.meterPublication.count(), prisma.meterReading.count(), prisma.meterReadingRevision.count()
  ])
  const before = await snapshot()
  const token = await humanToken(f.admin)
  const app = routeApp()
  const legacy = await request(app).get('/aggregated-series/options').auth(token, {type: 'bearer'}).query({pointIds: f.point.id})
  t.is(legacy.status, 200)
  t.false(legacy.body.parameters.some(parameter => parameter.readingSeries))
  const options = await request(app).get('/aggregated-series/options').auth(token, {type: 'bearer'}).query({pointIds: f.point.id, includeMeterReadings: true})
  t.is(options.status, 200)
  t.deepEqual(options.body.parameters.filter(parameter => !parameter.readingSeries), legacy.body.parameters)
  const physical = options.body.parameters.filter(parameter => parameter.readingSeries)
  t.is(physical.length, 2)
  t.deepEqual(physical.map(parameter => parameter.meterId).sort(), [f.meter.id, second.meter.id].sort())
  const option = physical.find(parameter => parameter.meterId === f.meter.id)
  t.is(option.minDate, '2026-07-01')
  t.is(option.maxDate, '2026-07-02')
  t.is(option.seriesCount, 1)
  t.is(option.valuesCount, 4)
  const query = physicalSeriesQuery(f, {startDate: '2026-07-01', endDate: '2026-07-01', limit: 2})
  const first = await request(app).get('/aggregated-series').auth(token, {type: 'bearer'}).query(query)
  t.is(first.status, 200)
  t.true(first.body.metadata.readingSeries)
  t.is(first.body.metadata.scope, 'PHYSICAL_METER')
  t.false(first.body.metadata.distribution.applied)
  t.deepEqual(first.body.values[0].values.map(reading => reading.value), ['0.0000', '1.2345'])
  t.is(first.body.values[0].values[1].observedAt, '2026-06-30T22:03:04.123Z')
  const next = await request(app).get('/aggregated-series').auth(token, {type: 'bearer'}).query({...query, cursor: first.body.nextCursor})
  t.is(next.status, 200)
  t.is(next.body.nextCursor, null)
  t.is(next.body.values[0].values.length, 1)
  t.like(next.body.values[0].values[0], {value: null, index: '4.5678', admissible: false, quality: 'opaque-quality', reason: 'SYNTHETIC_INVALID'})
  const legacyValues = await request(app).get('/aggregated-series').auth(token, {type: 'bearer'}).query({pointIds: f.point.id, metricTypeCode: 'index'})
  t.is(legacyValues.status, 200)
  t.deepEqual(legacyValues.body.values.map(row => row.value), [999])
  const bySource = await request(app).get('/aggregated-series/options').auth(token, {type: 'bearer'}).query({sourceId: ordinary.source.id, includeMeterReadings: true})
  t.false(bySource.body.parameters.some(parameter => parameter.readingSeries))
  t.deepEqual(await snapshot(), before)
})

integration('real authentication keeps physical index options and values ADMIN-only', async t => {
  const f = await seriesFixture({scope: randomUUID(), enabled: false})
  await preactivationReadings(f, [['2026-06-30T22:00:00Z', '1.0000']])
  const instructor = await prisma.user.create({data: {role: 'INSTRUCTOR', instructor: {create: {}}}})
  await prisma.instructorZone.create({data: {
    instructorUserId: instructor.id, zoneId: f.zoneId, startDate: new Date('2020-01-01Z'),
    permissions: {create: {permission: 'pp.volumes.read'}}
  }})
  const app = routeApp()
  const optionsQuery = {pointIds: f.point.id, includeMeterReadings: true}
  for (const user of [f.user, instructor]) {
    // eslint-disable-next-line no-await-in-loop -- Real authentication is exercised independently for both non-admin roles.
    const token = await humanToken(user)
    // eslint-disable-next-line no-await-in-loop
    const options = await request(app).get('/aggregated-series/options').auth(token, {type: 'bearer'}).query(optionsQuery)
    t.is(options.status, 200)
    t.false(options.body.parameters.some(parameter => parameter.readingSeries))
    // eslint-disable-next-line no-await-in-loop
    const denied = await request(app).get('/aggregated-series').auth(token, {type: 'bearer'}).query(physicalSeriesQuery(f))
    t.is(denied.status, 403)
  }
  const {token} = await createServiceAccountAccessToken(f.account.id, null)
  t.is((await request(app).get('/aggregated-series/options').auth(token, {type: 'bearer'}).query(optionsQuery)).status, 403)
  t.is((await request(app).get('/aggregated-series').auth(token, {type: 'bearer'}).query(physicalSeriesQuery(f))).status, 403)
  t.is((await request(app).get('/aggregated-series').query(physicalSeriesQuery(f))).status, 401)
})

integration('physical index scope intersects point, preleveur and collecteur and rejects foreign cursors', async t => {
  const f = await seriesFixture({scope: randomUUID(), enabled: false})
  const other = await fixture({scope: randomUUID(), enabled: false})
  await preactivationReadings(f, [['2026-06-30T22:00:00Z', '1.0000']])
  await preactivationReadings(other, [['2026-06-30T22:00:00Z', '2.0000']])
  const otherAtPoint = await prisma.declarantPointPrelevement.create({data: {
    declarantUserId: other.user.id, pointPrelevementId: f.point.id, usageId: f.usage.id
  }})
  await prisma.declarantCollecteurExploitation.create({data: {collecteurUserId: other.user.id, exploitationId: otherAtPoint.id}})
  const token = await humanToken(f.admin)
  const app = routeApp()
  for (const extras of [{pointIds: other.point.id}, {preleveurId: other.user.id},
    {collecteurId: other.user.id}, {preleveurId: f.user.id, collecteurId: other.user.id}, {pointFlowType: 'REJET'}]) {
    // eslint-disable-next-line no-await-in-loop -- Each scope intersection is independently denied.
    const result = await request(app).get('/aggregated-series').auth(token, {type: 'bearer'}).query(physicalSeriesQuery(f, extras))
    t.is(result.status, 404)
  }
  const options = await request(app).get('/aggregated-series/options').auth(token, {type: 'bearer'}).query({
    pointIds: f.point.id, preleveurId: other.user.id, collecteurId: other.user.id, includeMeterReadings: true
  })
  t.is(options.status, 200)
  t.false(options.body.parameters.some(parameter => parameter.readingSeries))
  const foreign = await prisma.meterReading.findFirst({where: {compteurId: other.meter.id}})
  t.is((await request(app).get('/aggregated-series').auth(token, {type: 'bearer'}).query(physicalSeriesQuery(f, {cursor: foreign.id}))).status, 400)
  await prisma.declarantCollecteurExploitation.create({data: {collecteurUserId: other.user.id, exploitationId: f.exploitation.id}})
  t.is((await request(app).get('/aggregated-series').auth(token, {type: 'bearer'}).query(physicalSeriesQuery(f, {preleveurId: f.user.id, collecteurId: other.user.id}))).status, 200)
})

integration('physical index dates use Paris calendar boundaries and retain only canonical revisions', async t => {
  const f = await seriesFixture({scope: randomUUID(), enabled: false})
  const rows = [['2026-03-28T23:00:00Z', '0.0000'], ['2026-03-29T21:59:59Z', '1.2345'], ['2026-03-29T22:00:00Z', '2.0000']]
  await preactivationReadings(f, rows)
  await ingestMeterBatch({
    ...batch(f, {mode: 'OFFLINE', fetchedAt: '2026-07-16T11:00:00Z'}), windowStart: '2026-03-28T00:00:00Z', windowEnd: '2026-03-31T00:00:00Z',
    readings: [{externalId: f.key, observedAt: rows[1][0], index: '1.2346', status: 'VALID'}]
  }, f.adminActor)
  const token = await humanToken(f.admin)
  const app = routeApp()
  const result = await request(app).get('/aggregated-series').auth(token, {type: 'bearer'}).query(physicalSeriesQuery(f, {startDate: '2026-03-29', endDate: '2026-03-29'}))
  t.is(result.status, 200)
  t.is(result.body.values.length, 1)
  t.is(result.body.values[0].date, '2026-03-29')
  t.deepEqual(result.body.values[0].values.map(row => [row.time, row.value]), [['00:00:00', '0.0000'], ['23:59:59', '1.2346']])
  t.is(result.body.nextCursor, null)
  const outside = await prisma.meterReading.findFirst({where: {compteurId: f.meter.id, observedAt: new Date(rows[2][0])}})
  t.is((await request(app).get('/aggregated-series').auth(token, {type: 'bearer'}).query(physicalSeriesQuery(f, {
    startDate: '2026-03-29', endDate: '2026-03-29', cursor: outside.id
  }))).status, 400)
})

function historicalReplay(f, overrides = {}) {
  return {provider: f.provider, scope: f.scope, streamIds: [f.stream.id],
    from: '2026-07-01T22:00:00Z', to: '2026-07-08T22:00:00Z',
    historicalAuthorization: {reference: 'beneficiaries-and-shares-confirmed', confirmedBy: 'test-operator', confirmedAt: '2026-07-16T12:00:00Z'},
    ...overrides}
}

async function meterState(f) {
  return {
    stream: await prisma.meterStream.findUnique({where: {id: f.stream.id}}),
    versions: await prisma.meterAllocationVersion.findMany({where: {allocation: {compteurId: f.meter.id}}, orderBy: {id: 'asc'}}),
    publications: await prisma.meterPublication.count({where: {streamId: f.stream.id}}),
    readings: await prisma.meterReading.count({where: {compteurId: f.meter.id}}),
    revisions: await prisma.meterReadingRevision.count({where: {streamId: f.stream.id}}),
    chunks: await prisma.chunk.count({where: {compteurId: f.meter.id}}),
    audits: await prisma.auditEvent.count({where: {targetId: f.stream.id}})
  }
}

integration('historical replay defaults to full rollback, then publishes once without changing current versions or activation', async t => {
  const f = await fixture({shares: [40, 30], external: 30, activationDate: '2026-07-10Z'})
  const payload = batch(f, {values: [100, 110, 120]})
  await ingestMeterBatch(payload, f.actor)
  const before = await meterState(f)
  t.is(before.publications, 0)
  const replay = historicalReplay(f)
  const preview = await replayMeterStreams(replay)
  t.true(preview.completed)
  t.false(preview.applied)
  t.true(preview.preserveOrdinary)
  t.is(preview.totals.versionsCreated, 2)
  t.is(preview.totals.published, 2)
  t.is(preview.totals.sourcesCreated, 2)
  t.deepEqual(await meterState(f), before)
  const applied = await replayMeterStreams(replay, {apply: true})
  t.is(applied.operationId, preview.operationId)
  t.deepEqual(applied.totals, preview.totals)
  const after = await meterState(f)
  t.is(after.publications, 2)
  t.is(after.audits, before.audits + 1)
  t.is(after.readings, before.readings)
  t.is(after.revisions, before.revisions)
  t.deepEqual(after.stream.activatedAt, before.stream.activatedAt)
  t.is(after.stream.supersedeSameMeter, before.stream.supersedeSameMeter)
  t.deepEqual(after.versions.filter(version => before.versions.some(previous => previous.id === version.id)), before.versions)
  const historical = after.versions.filter(version => version.version === 2)
  t.true(historical.every(version => version.startDate.toISOString() === '2026-07-01T22:00:00.000Z'
    && version.endDate.toISOString() === '2026-07-08T22:00:00.000Z'
    && version.metadata.historicalPublication.reference === replay.historicalAuthorization.reference))
  t.deepEqual((await activeValues(f)).map(value => value.value.toString()), ['7', '7'])
  const publications = await prisma.meterPublication.findMany({where: {streamId: f.stream.id}, include: {contributions: true}})
  t.true(publications.every(publication => publication.physicalVolume.toString() === '10'
    && publication.outOfScopeVolume.toString() === '3' && publication.contributions.length === 2))
  const second = await replayMeterStreams(replay, {apply: true})
  t.is(second.totals.published, 0)
  t.is(second.totals.sourcesCreated, 0)
  t.is(second.totals.versionsCreated, 0)
  t.is(second.totals.versionsReused, 2)
  t.is(second.totals.unchanged, 2)
  const repeated = await meterState(f)
  t.is(repeated.publications, after.publications)
  t.is(repeated.chunks, after.chunks)
  t.deepEqual(repeated.versions, after.versions)
  // The original durable ingestion is unchanged; an explicit replay, not a
  // forged new reading/revision, authorized publication of these observations.
  t.is((await ingestMeterBatch(payload, f.actor)).counts.published, 0)
  await ingestMeterBatch(batch(f, {values: [100, 115, 120], fetchedAt: '2026-07-16T13:00:00Z'}), f.actor)
  t.deepEqual((await activeValues(f)).map(value => value.value.toString()), ['10.5', '3.5'])
})

integration('historical replay preserves ordinary volumes even with explicit same-meter replacement configured', async t => {
  const f = await fixture({shares: [100], activationDate: '2026-07-10Z', supersedeSameMeter: true})
  const ordinary = await ordinaryVolume(f, f.meter.id)
  await ingestMeterBatch(batch(f), f.actor)
  const request = historicalReplay(f)
  const preview = await replayMeterStreams(request)
  t.deepEqual(preview.totals.blockedIntervals, {ORDINARY_VOLUME_PRESERVED: 1})
  t.is(preview.totals.published, 0)
  const applied = await replayMeterStreams(request, {apply: true})
  t.deepEqual(applied.totals, preview.totals)
  // Protection persists when ordinary ingestion later receives a correction.
  await ingestMeterBatch(batch(f, {values: [100, 130], fetchedAt: '2026-07-16T13:00:00Z'}), f.actor)
  t.is(await prisma.chunkValue.count({where: {id: ordinary.row.id}}), 1)
  t.is(await prisma.chunkValueReplacement.count({where: {replacedChunkValueId: ordinary.row.id}}), 0)
  t.is((await activeValues(f)).length, 0)
  t.true((await prisma.meterStream.findUnique({where: {id: f.stream.id}})).supersedeSameMeter)
})

integration('historical replay never bridges invalid observations, resets or the requested boundary', async t => {
  const f = await fixture({shares: [100], activationDate: '2026-07-10Z'})
  const payload = batch(f, {values: [100, 110, 120, 119, 130, 140]})
  payload.readings[1].status = 'INVALID'
  payload.readings[1].reason = 'provider-quality-decision'
  await ingestMeterBatch(payload, f.actor)
  const result = await replayMeterStreams(historicalReplay(f, {to: '2026-07-06T12:00:00Z'}), {apply: true})
  t.true(result.completed)
  t.deepEqual(result.totals.blockedIntervals, {BLOCKED_READING: 2, INDEX_DECREASE: 1})
  t.is(result.totals.published, 1)
  const values = await activeValues(f)
  t.is(values.length, 1)
  t.is(values[0].value.toString(), '11')
  t.is(values[0].periodStart.toISOString(), '2026-07-05T00:00:00.000Z')
  t.is(values[0].periodEnd.toISOString(), '2026-07-06T00:00:00.000Z')
})

integration('historical replay skips disabled and unresolved shares, requires exact namespaces and rejects overlaps', async t => {
  const disabled = await fixture({enabled: false})
  const unresolved = await fixture({shares: [70], activationDate: '2026-07-10Z'})
  const f = await fixture({shares: [100], activationDate: '2026-07-10Z'})
  const before = await meterState(f)
  t.is((await t.throwsAsync(replayMeterStreams(historicalReplay(f, {provider: 'foreign-provider'}), {apply: true}))).status, 404)
  t.is((await t.throwsAsync(replayMeterStreams(historicalReplay(f, {scope: 'foreign-scope'}), {apply: true}))).status, 404)
  t.deepEqual(await meterState(f), before)
  t.is((await replayMeterStreams(historicalReplay(disabled), {apply: true})).streams[0].reason, 'NOT_ACTIVATED')
  t.is((await replayMeterStreams(historicalReplay(unresolved), {apply: true})).streams[0].reason, 'ALLOCATION_TOTAL_NOT_100')
  t.is((await replayMeterStreams(historicalReplay(f, {to: '2026-07-11T00:00:00Z'}), {apply: true})).streams[0].reason, 'HISTORICAL_WINDOW_AFTER_ACTIVATION')
  const allocation = await prisma.meterAllocation.findFirst({where: {compteurId: f.meter.id}})
  await prisma.meterAllocationVersion.create({data: {allocationId: allocation.id, version: 2, enabled: true,
    startDate: new Date('2026-07-05Z'), endDate: new Date('2026-07-06Z'), percentage: 100}})
  const overlap = await replayMeterStreams(historicalReplay(f), {apply: true})
  t.is(overlap.streams[0].reason, 'HISTORICAL_ALLOCATION_OVERLAP')
  t.is(overlap.totals.versionsCreated, 0)
})

integration('historical replay rolls back versions and volumes together on publication failure', async t => {
  const f = await fixture({shares: [100], activationDate: '2026-07-10Z'})
  await ingestMeterBatch(batch(f), f.actor)
  const before = await meterState(f)
  const failingClient = {meterStream: prisma.meterStream,
    $transaction: (callback, options) => prisma.$transaction(tx => callback(new Proxy(tx, {
      get(target, property) {
        if (property === 'meterVolumeContribution') return {
          ...target[property], createMany() { throw new Error('INJECTED_PUBLICATION_FAILURE') }
        }
        return target[property]
      }
    })), options)}
  const result = await replayMeterStreams(historicalReplay(f), {apply: true, client: failingClient})
  t.false(result.completed)
  t.is(result.streams[0].status, 'FAILED')
  t.is(result.streams[0].reason, 'REPLAY_FAILED')
  t.deepEqual(await meterState(f), before)
})

function allocationScope(f, user = f.admin) {
  return {user, meterId: f.meter.id, exploitationId: f.exploitation.id, streamId: f.stream.id}
}

function allocationEdit(settings, overrides = {}) {
  return {streamId: settings.stream.id, expectedVersion: settings.expectedVersion, effectiveDate: '2026-07-04', reason: 'Répartition et bénéficiaires confirmés',
    allocations: settings.allocations.map(({key, exploitationId, percentage, additive}) => ({key, exploitationId, percentage, additive})), ...overrides}
}

integration('allocation editing is ADMIN-only, scope-bound and optimistically locked', async t => {
  const f = await fixture({shares: [100]})
  const other = await fixture()
  const settings = await getMeterAllocationSettings(allocationScope(f))
  for (const user of [undefined, f.user, {id: randomUUID(), role: 'INSTRUCTOR'}, {id: f.account.id, name: f.account.name}]) {
    // eslint-disable-next-line no-await-in-loop -- Every denied role is tested on each independent service.
    t.is((await t.throwsAsync(getMeterAllocationSettings({...allocationScope(f), user}))).status, 403)
    // eslint-disable-next-line no-await-in-loop
    t.is((await t.throwsAsync(updateMeterAllocationSettings({...allocationScope(f), user, body: allocationEdit(settings)}))).status, 403)
    // eslint-disable-next-line no-await-in-loop
    t.is((await t.throwsAsync(searchMeterAllocationTargets({user, search: 'Meter'}))).status, 403)
  }
  t.is((await t.throwsAsync(getMeterAllocationSettings({...allocationScope(f), exploitationId: other.exploitation.id}))).status, 404)
  t.is((await t.throwsAsync(getMeterAllocationSettings({...allocationScope(f), streamId: other.stream.id}))).status, 404)
  t.is(settings.minEffectiveDate, '2026-07-02')
  const body = allocationEdit(settings)
  const updated = await updateMeterAllocationSettings({...allocationScope(f), body})
  t.not(updated.expectedVersion, settings.expectedVersion)
  t.is(updated.minEffectiveDate, '2026-07-05')
  t.is((await t.throwsAsync(updateMeterAllocationSettings({...allocationScope(f), body}))).status, 409)
  t.is((await t.throwsAsync(updateMeterAllocationSettings({...allocationScope(f), body: allocationEdit(updated)}))).status, 400)
  t.is((await t.throwsAsync(updateMeterAllocationSettings({...allocationScope(f), body: allocationEdit(updated, {
    effectiveDate: '2026-07-05', allocations: [{key: 'foreign-key', exploitationId: f.exploitation.id, percentage: '100'}]
  })}))).status, 400)
})

integration('dated reassignment to another point preserves old allocation identity and historical contributions', async t => {
  const f = await fixture({shares: [100]})
  const destination = await fixture({shares: [100]})
  await ingestMeterBatch(batch(f, {values: [100, 110, 120, 130]}), f.actor)
  const originalAllocation = await prisma.meterAllocation.findFirst({where: {compteurId: f.meter.id}, include: {versions: true}})
  const originalPublications = await prisma.meterPublication.findMany({where: {streamId: f.stream.id}, orderBy: {periodStart: 'asc'}, include: {contributions: true}})
  const settings = await getMeterAllocationSettings(allocationScope(f))
  await updateMeterAllocationSettings({...allocationScope(f), body: allocationEdit(settings, {
    allocations: [{key: settings.allocations[0].key, exploitationId: destination.exploitation.id, percentage: '100', additive: true}]
  })})
  const originalAfter = await prisma.meterAllocation.findUnique({where: {id: originalAllocation.id}, include: {versions: true}})
  t.is(originalAfter.exploitationId, f.exploitation.id)
  t.is(originalAfter.sourceId, originalAllocation.sourceId)
  t.is(originalAfter.versions[0].percentage.toString(), '100')
  t.is(originalAfter.versions[0].endDate.toISOString(), '2026-07-03T22:00:00.000Z')
  const replacement = await prisma.meterAllocation.findFirst({where: {compteurId: f.meter.id, exploitationId: destination.exploitation.id}, include: {versions: true}})
  t.truthy(replacement.sourceId.startsWith('manual:'))
  t.is(replacement.versions[0].startDate.toISOString(), '2026-07-03T22:00:00.000Z')
  t.true(replacement.versions[0].additive)
  t.true(replacement.versions[0].metadata.preserveOrdinary)
  const current = await prisma.meterPublication.findMany({where: {streamId: f.stream.id, active: true}, orderBy: {periodStart: 'asc'}, include: {source: {include: {chunks: true}}}})
  t.is(current.length, 2)
  t.is(current[0].id, originalPublications[0].id)
  t.is(current[1].source.chunks[0].pointPrelevementId, destination.point.id)
  t.is(current[1].source.chunks[0].preleveurUserId, destination.user.id)
  t.is(current[1].inScopeVolume.toString(), '10')
  t.is(await prisma.meterVolumeContribution.count({where: {id: {in: originalPublications.flatMap(publication => publication.contributions.map(contribution => contribution.id))}}}), 3)
  t.is((await prisma.meterPublication.findUnique({where: {id: originalPublications[1].id}})).active, false)
  t.is((await getMeterAllocationSettings({...allocationScope(f), exploitationId: destination.exploitation.id})).allocations[0].exploitationId, destination.exploitation.id)
})

integration('edited allocations durably preserve ordinary data during later ingestion and leave disabled streams disabled', async t => {
  const f = await fixture({shares: [100], supersedeSameMeter: true})
  const ordinary = await ordinaryVolume(f, f.meter.id)
  const settings = await getMeterAllocationSettings(allocationScope(f))
  await updateMeterAllocationSettings({...allocationScope(f), body: allocationEdit(settings, {effectiveDate: '2026-07-02'})})
  const ingested = await ingestMeterBatch(batch(f), f.actor)
  t.is(ingested.counts.published, 0)
  t.is(ingested.counts.conflicts, 1)
  t.is(await prisma.chunkValue.count({where: {id: ordinary.row.id}}), 1)
  t.is(await prisma.chunkValueReplacement.count({where: {replacedChunkValueId: ordinary.row.id}}), 0)
  const disabled = await fixture({shares: [100], enabled: false})
  const disabledSettings = await getMeterAllocationSettings(allocationScope(disabled))
  await updateMeterAllocationSettings({...allocationScope(disabled), body: allocationEdit(disabledSettings)})
  const stillDisabled = await prisma.meterStream.findUnique({where: {id: disabled.stream.id}})
  t.false(stillDisabled.enabled)
  t.is(stillDisabled.activatedAt, null)
  await ingestMeterBatch(batch(disabled, {mode: 'OFFLINE'}), disabled.adminActor)
  t.is(await prisma.meterPublication.count({where: {streamId: disabled.stream.id}}), 0)
})

integration('allocation settings distinguish unresolved local beneficiaries and choose latest business date rather than version number', async t => {
  const f = await fixture({shares: [100]})
  const allocation = await prisma.meterAllocation.findFirst({where: {compteurId: f.meter.id}})
  await prisma.meterAllocationVersion.create({data: {allocationId: allocation.id, version: 2, percentage: 100, enabled: true, additive: true,
    startDate: new Date('2026-06-01Z'), endDate: new Date('2026-06-15Z')}})
  const settings = await getMeterAllocationSettings(allocationScope(f))
  t.false(settings.allocations[0].additive)
  await prisma.meterStream.update({where: {id: f.stream.id}, data: {allocationSnapshot: [
    {key: allocation.sourceId, percentage: '60', inScope: true},
    {key: 'missing-local-beneficiary', percentage: '30', inScope: true},
    {key: 'external-beneficiary', percentage: '10', inScope: false}
  ]}})
  const unresolved = await getMeterAllocationSettings(allocationScope(f))
  t.true(unresolved.allocations[1].inScope)
  t.true(unresolved.allocations[1].unresolved)
  t.is(unresolved.allocations[1].exploitationId, null)
  t.false(unresolved.allocations[2].inScope)
  t.false(unresolved.allocations[2].unresolved)
})

integration('allocation edit persists exact Paris DST boundaries and rejects inactive targets atomically', async t => {
  const f = await fixture({shares: [100], activationDate: '2026-03-01Z'})
  const settings = await getMeterAllocationSettings(allocationScope(f))
  await updateMeterAllocationSettings({...allocationScope(f), body: allocationEdit(settings, {effectiveDate: '2026-03-29'})})
  let versions = await prisma.meterAllocationVersion.findMany({where: {allocation: {compteurId: f.meter.id}}, orderBy: {version: 'asc'}})
  t.is(versions[0].endDate.toISOString(), '2026-03-28T23:00:00.000Z')
  t.is(versions[1].startDate.toISOString(), '2026-03-28T23:00:00.000Z')
  const next = await getMeterAllocationSettings(allocationScope(f))
  t.is(next.minEffectiveDate, '2026-03-30')
  await updateMeterAllocationSettings({...allocationScope(f), body: allocationEdit(next, {effectiveDate: '2026-10-25'})})
  versions = await prisma.meterAllocationVersion.findMany({where: {allocation: {compteurId: f.meter.id}}, orderBy: {version: 'asc'}})
  t.is(versions[2].startDate.toISOString(), '2026-10-24T22:00:00.000Z')
  const latest = await getMeterAllocationSettings(allocationScope(f))
  t.is(latest.minEffectiveDate, '2026-10-26')
  const other = await fixture()
  await prisma.declarantPointPrelevement.update({where: {id: other.exploitation.id}, data: {startDate: new Date('2026-11-01Z')}})
  const before = await meterState(f)
  t.is((await t.throwsAsync(updateMeterAllocationSettings({...allocationScope(f), body: allocationEdit(latest, {
    effectiveDate: '2026-10-26', allocations: [{exploitationId: other.exploitation.id, percentage: '100'}]
  })}))).status, 400)
  t.deepEqual(await meterState(f), before)
})

integration('real HTTP allocation editing rejects declarants, instructors, service accounts and impersonation', async t => {
  const f = await fixture({shares: [100]})
  const other = await fixture()
  const instructor = await prisma.user.create({data: {role: 'INSTRUCTOR', instructor: {create: {}}}})
  const app = routeApp()
  const path = `/exploitations/${f.exploitation.id}/meters/${f.meter.id}/allocation-settings`
  const query = {streamId: f.stream.id}
  const adminToken = await humanToken(f.admin)
  const settings = await request(app).get(path).auth(adminToken, {type: 'bearer'}).query(query)
  t.is(settings.status, 200)
  const body = allocationEdit(settings.body)
  const {token: accountToken} = await createServiceAccountAccessToken(f.account.id, null)
  const deniedTokens = [await humanToken(f.user), await humanToken(instructor), accountToken]
  const before = await meterState(f)
  for (const token of deniedTokens) {
    // eslint-disable-next-line no-await-in-loop -- Exercise each real bearer identity without bypassing authentication.
    t.is((await request(app).get(path).auth(token, {type: 'bearer'}).query(query)).status, 403)
    // eslint-disable-next-line no-await-in-loop
    t.is((await request(app).put(path).auth(token, {type: 'bearer'}).send(body)).status, 403)
    // eslint-disable-next-line no-await-in-loop
    t.is((await request(app).get('/meters/allocation-targets').auth(token, {type: 'bearer'}).query({search: f.key})).status, 403)
  }
  t.is((await request(app).put(path).send(body)).status, 401)
  const impersonated = routeApp({user: f.admin, impersonation: {actorUserId: other.admin.id}})
  t.is((await request(impersonated).put(path).send(body)).status, 403)
  t.deepEqual(await meterState(f), before)
  const foreignPath = `/exploitations/${other.exploitation.id}/meters/${f.meter.id}/allocation-settings`
  t.is((await request(app).get(foreignPath).auth(adminToken, {type: 'bearer'}).query(query)).status, 404)
  t.is((await request(app).put(foreignPath).auth(adminToken, {type: 'bearer'}).send(body)).status, 404)
  const search = await request(app).get('/meters/allocation-targets').auth(adminToken, {type: 'bearer'}).query({search: f.key})
  t.is(search.status, 200)
  t.true(search.body.items.some(item => item.id === f.exploitation.id))
  const updated = await request(app).put(path).auth(adminToken, {type: 'bearer'}).send(body)
  t.is(updated.status, 200)
  t.not(updated.body.expectedVersion, settings.body.expectedVersion)
  t.is((await request(app).put(path).auth(adminToken, {type: 'bearer'}).send(body)).status, 409)
  const version = await prisma.meterAllocationVersion.findFirst({where: {allocation: {compteurId: f.meter.id}, version: 2}})
  t.is(version.metadata.allocationEdit.actorUserId, f.admin.id)
  t.is(version.metadata.allocationEdit.reason, body.reason)
})
