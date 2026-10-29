/* eslint-disable no-await-in-loop -- Ordered synthetic transactions exercise pagination and advisory locks. */
import test from 'ava'
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {previewDeclarantsLastDeclarationAt} from '../../models/declarant.js'
import {finalizeMeterStreamsInTransaction, ingestMeterBatch} from '../meter-ingestion.js'
import {lockMeter, lockMeters, lockMeterPublicationPoints, meterReadingIntervals, reprocessMeterStreamInTransaction} from '../meter-publication.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => {
  await prisma.$disconnect()
  await globalThis.pgPool?.end()
})

const instant = day => `2026-07-${String(day).padStart(2, '0')}T00:00:00.000Z`

async function fixture({scope: sharedScope, serviceAccountId} = {}) {
  const key = randomUUID()
  const provider = 'synthetic-window'
  const scope = sharedScope ?? key
  const user = await prisma.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT'}}}})
  const admin = await prisma.user.create({data: {role: 'ADMIN'}})
  const usage = await prisma.sandreWaterUse.findUniqueOrThrow({where: {code: '2'}})
  const point = await prisma.pointPrelevement.create({data: {
    name: `Synthetic meter window ${key}`, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'
  }})
  const exploitation = await prisma.declarantPointPrelevement.create({data: {
    pointPrelevementId: point.id, declarantUserId: user.id, usageId: usage.id, status: 'EN_ACTIVITE'
  }})
  const meter = await prisma.compteur.create({data: {serialNumber: key}})
  const account = serviceAccountId ? {id: serviceAccountId} : await prisma.serviceAccount.create({data: {name: `Synthetic window ${key}`}})
  const allocationSnapshot = [{key, percentage: '100', inScope: true}]
  const stream = await prisma.meterStream.create({data: {
    compteurId: meter.id, externalId: key, serviceAccountId: account.id, enabled: true,
    provider, scope, activatedAt: new Date(instant(1)), allocationSnapshot, allocationSnapshotValidated: true
  }})
  await prisma.meterAllocation.create({data: {
    sourceId: key, provider, scope, compteurId: meter.id, exploitationId: exploitation.id,
    versions: {create: {
      version: 1, enabled: true, startDate: new Date(instant(1)), percentage: 100,
      metadata: {allocationSnapshot, allocationSnapshotValidated: true}
    }}
  }})
  return {key, provider, scope, meter, point, stream, user, actor: {serviceAccountId: account.id}, adminActor: {user: admin}}
}

function batch(f, rows, {mode = 'LIVE', from = 1, to = 10, fetchedAt = instant(20)} = {}) {
  return {
    provider: f.provider, scope: f.scope, batchId: randomUUID(), mode,
    windowStart: instant(from), windowEnd: instant(to), fetchedAt, complete: true,
    readings: rows.map(([day, index, status = 'VALID']) => ({
      externalId: f.key, observedAt: instant(day), index: String(index), status,
      quality: 'synthetic', origin: 'synthetic',
      ...(status === 'INVALID' ? {reason: 'SYNTHETIC_INVALID'} : {})
    }))
  }
}

async function publicationSnapshot(f) {
  const publications = await prisma.meterPublication.findMany({
    where: {compteurId: f.meter.id}, orderBy: [{periodStart: 'asc'}, {id: 'asc'}],
    include: {
      source: {include: {chunks: {orderBy: {id: 'asc'}, include: {chunkValues: {orderBy: {id: 'asc'}}}}}},
      contributions: {orderBy: {id: 'asc'}}
    }
  })
  return JSON.parse(JSON.stringify(publications))
}

function activeSummary(publications) {
  return publications.filter(publication => publication.active).map(publication => [
    publication.periodStart, publication.periodEnd, Number(publication.physicalVolume)
  ])
}

async function readingsSnapshot(f) {
  return prisma.meterReading.findMany({
    where: {compteurId: f.meter.id}, orderBy: {observedAt: 'asc'}, include: {currentRevision: true}
  })
}

integration('bounded LIVE promotion recomputes both strict neighbours and preserves outside publications and replay', async t => {
  const f = await fixture()
  await ingestMeterBatch(batch(f, Array.from({length: 8}, (_, index) => [index + 1, (index + 1) * 10]), {
    mode: 'OFFLINE', fetchedAt: instant(19)
  }), f.adminActor)
  const before = await publicationSnapshot(f)
  const outside = publications => publications.filter(publication => publication.periodEnd < instant(4) || publication.periodStart > instant(6))
  const payload = batch(f, [[4, 45], [6, 65]], {from: 4, to: 6})
  const result = await ingestMeterBatch(payload, f.actor)
  const after = await publicationSnapshot(f)
  t.is(result.counts.published, 4)
  t.deepEqual(activeSummary(after), [[1, 2, 10], [2, 3, 10], [3, 4, 15], [4, 5, 5], [5, 6, 15], [6, 7, 5], [7, 8, 10]]
    .map(([start, end, value]) => [instant(start), instant(end), value]))
  t.deepEqual(outside(after), outside(before))
  const readings = await readingsSnapshot(f)
  t.deepEqual(readings.map(row => row.currentMode), ['OFFLINE', 'OFFLINE', 'OFFLINE', 'LIVE', 'OFFLINE', 'LIVE', 'OFFLINE', 'OFFLINE'])
  t.deepEqual(await ingestMeterBatch(payload, f.actor), result)
  t.deepEqual(await publicationSnapshot(f), after)
  t.deepEqual(await readingsSnapshot(f), readings)
})

integration('empty bounded windows retain only the enclosing pair with real SQL pagination and open bounds', async t => {
  const f = await fixture()
  await ingestMeterBatch(batch(f, [[1, 10], [3, 30], [7, 70], [9, 90]]), f.actor)
  const collect = async options => {
    const pairs = []
    for await (const [start, end] of meterReadingIntervals(prisma, f.meter.id, {pageSize: 1, ...options})) {
      pairs.push([start.observedAt.toISOString(), end.observedAt.toISOString()])
    }
    return pairs
  }
  const pair = (start, end) => [instant(start), instant(end)]
  t.deepEqual(await collect({from: new Date(instant(4)), to: new Date(instant(6))}), [pair(3, 7)])
  t.deepEqual(await collect({from: new Date(instant(4))}), [pair(3, 7), pair(7, 9)])
  t.deepEqual(await collect({to: new Date(instant(6))}), [pair(1, 3), pair(3, 7)])
  t.deepEqual(await collect({}), [pair(1, 3), pair(3, 7), pair(7, 9)])
  const before = await publicationSnapshot(f)
  const result = await prisma.$transaction(tx => reprocessMeterStreamInTransaction(tx, f.stream.id, {
    from: new Date(instant(4)), to: new Date(instant(6))
  }))
  t.like(result, {published: 0, conflicts: 0, intervals: {examined: 1, unchanged: 1, blocked: 0}})
  t.deepEqual(await publicationSnapshot(f), before)
})

integration('invalid strict neighbours remain barriers instead of being skipped during bounded LIVE promotion', async t => {
  const f = await fixture()
  await ingestMeterBatch(batch(f, [
    [1, 10], [2, 20, 'INVALID'], [3, 30], [4, 40], [5, 50], [6, 60, 'INVALID'], [7, 70], [8, 80]
  ], {mode: 'OFFLINE', fetchedAt: instant(19)}), f.adminActor)
  const before = await publicationSnapshot(f)
  const invalidBefore = (await readingsSnapshot(f)).filter(row => !row.currentRevision.admissible)
  const result = await ingestMeterBatch(batch(f, [[3, 35], [5, 55]], {from: 3, to: 5}), f.actor)
  const after = await publicationSnapshot(f)
  t.is(result.counts.published, 2)
  t.deepEqual(activeSummary(after), [[3, 4, 5], [4, 5, 15], [7, 8, 10]]
    .map(([start, end, value]) => [instant(start), instant(end), value]))
  t.deepEqual((await readingsSnapshot(f)).filter(row => !row.currentRevision.admissible), invalidBefore)
  t.deepEqual(after.filter(row => row.periodStart === instant(7)), before.filter(row => row.periodStart === instant(7)))
})

integration('a bounded predecessor insertion rejects an already published rebound without bridging the dip', async t => {
  const f = await fixture()
  await ingestMeterBatch(batch(f, [[2, 200], [3, 1015], [4, 1020]], {
    from: 2, to: 4, fetchedAt: instant(18)
  }), f.actor)
  const before = await publicationSnapshot(f)
  const rebound = before.find(row => row.periodStart === instant(2))
  t.is(Number(rebound.physicalVolume), 815)
  const existingReadings = await readingsSnapshot(f)
  const payload = batch(f, [[1, 1000]], {from: 1, to: 2, fetchedAt: instant(19)})
  payload.windowEnd = instant(1).replace('T00:', 'T12:')
  const result = await ingestMeterBatch(payload, f.actor)
  const after = await publicationSnapshot(f)
  t.deepEqual(activeSummary(after), [[instant(3), instant(4), 5]])
  t.false(after.find(row => row.id === rebound.id).active)
  t.is(after.find(row => row.id === rebound.id).source.globalInstructionStatus, 'REJECTED')
  t.true(after.find(row => row.id === rebound.id).source.chunks.every(chunk => chunk.instructionStatus === 'REJECTED'))
  t.regex((await prisma.meterStream.findUniqueOrThrow({where: {id: f.stream.id}})).lastIssue, /INDEX_REBOUND_UNRESOLVED/)
  t.deepEqual((await readingsSnapshot(f)).filter(row => row.observedAt >= new Date(instant(2))), existingReadings)
  t.deepEqual(await ingestMeterBatch(payload, f.actor), result)
  t.deepEqual(await publicationSnapshot(f), after)

  // A genuine source revision resolves the dip; no synthetic index or bridging
  // interval is needed, and the rejected publication remains available to audit.
  const correction = batch(f, [[2, 1010]], {from: 2, to: 3, fetchedAt: instant(20)})
  correction.windowEnd = instant(2).replace('T00:', 'T12:')
  await ingestMeterBatch(correction, f.actor)
  const corrected = await publicationSnapshot(f)
  t.deepEqual(activeSummary(corrected), [[1, 2, 10], [2, 3, 5], [3, 4, 5]]
    .map(([start, end, volume]) => [instant(start), instant(end), volume]))
  t.false(corrected.find(row => row.id === rebound.id).active)
})

integration('a durable reset still publishes consecutive increasing readings below the former index', async t => {
  const f = await fixture()
  await ingestMeterBatch(batch(f, [[1, 1000], [2, 200], [3, 215], [4, 220]], {from: 1, to: 4}), f.actor)
  t.deepEqual(activeSummary(await publicationSnapshot(f)), [[2, 3, 15], [3, 4, 5]]
    .map(([start, end, volume]) => [instant(start), instant(end), volume]))
  const stream = await prisma.meterStream.findUniqueOrThrow({where: {id: f.stream.id}})
  t.is(stream.lastIssue, 'INDEX_DECREASE')
})

integration('concurrent distinct batches on the same physical meter publish once and both remain replayable', async t => {
  const f = await fixture()
  const first = batch(f, [[3, 30], [4, 40]], {from: 3, to: 4})
  const second = {...first, batchId: randomUUID()}
  const results = await Promise.all([ingestMeterBatch(first, f.actor), ingestMeterBatch(second, f.actor)])
  t.not(results[0].ingestionId, results[1].ingestionId)
  t.is(results.reduce((sum, result) => sum + result.counts.published, 0), 1)
  t.is(await prisma.meterReading.count({where: {compteurId: f.meter.id}}), 2)
  t.is(await prisma.meterReadingRevision.count({where: {streamId: f.stream.id}}), 2)
  const before = await publicationSnapshot(f)
  t.is(before.length, 1)
  t.true(before[0].active)
  t.deepEqual(await Promise.all([ingestMeterBatch(first, f.actor), ingestMeterBatch(second, f.actor)]), results)
  t.deepEqual(await publicationSnapshot(f), before)
})

async function probeLocks(namespace, ids) {
  return prisma.$transaction(async tx => {
    const acquired = []
    for (const id of ids) {
      const rows = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext(${namespace}), hashtext(${id})) AS acquired`
      acquired.push(rows[0].acquired)
    }
    return acquired
  })
}

integration('batched physical locks exclude legacy single-key transactions and release every deduplicated key', async t => {
  const ids = [randomUUID(), randomUUID()].sort()
  const unrelated = randomUUID()
  await prisma.$transaction(async tx => {
    await lockMeters(tx, [ids[1], ids[0], ids[1]])
    t.deepEqual(await probeLocks('physical-meter', [...ids, unrelated]), [false, false, true])
  })
  t.deepEqual(await probeLocks('physical-meter', ids), [true, true])
  await prisma.$transaction(async tx => {
    await lockMeter(tx, ids[0])
    await t.throwsAsync(prisma.$transaction(async contender => {
      await contender.$executeRaw`SET LOCAL lock_timeout = '150ms'`
      await lockMeters(contender, [ids[1], ids[0]])
    }), {message: /lock timeout/})
  })
  t.deepEqual(await probeLocks('physical-meter', ids), [true, true])
})

integration('batched publication locks retain the legacy point namespace and release all points together', async t => {
  const first = await fixture()
  const second = await fixture()
  const points = [first.point.id, second.point.id]
  await prisma.$transaction(async tx => {
    await lockMeterPublicationPoints(tx, [second.meter.id, first.meter.id, second.meter.id])
    t.deepEqual(await probeLocks('volumes-from-index', [...points, randomUUID()]), [false, false, true])
    t.deepEqual(await probeLocks('physical-meter', points), [true, true])
  })
  t.deepEqual(await probeLocks('volumes-from-index', points), [true, true])
})

integration('grouped stream completion preserves physical latest readings, future checkpoints and unrelated stream state', async t => {
  const first = await fixture()
  const empty = await fixture()
  await ingestMeterBatch(batch(first, [[3, 30], [4, 40]], {mode: 'OFFLINE'}), first.adminActor)
  const foreign = await prisma.meterStream.create({data: {
    compteurId: first.meter.id, externalId: randomUUID(), provider: 'synthetic-other-source', scope: randomUUID(),
    serviceAccountId: first.actor.serviceAccountId, enabled: false
  }})
  await ingestMeterBatch(batch({...first, key: foreign.externalId, provider: foreign.provider, scope: foreign.scope}, [
    [9, 90, 'INVALID']
  ], {mode: 'OFFLINE'}), first.adminActor)
  const shared = await prisma.meterStream.create({data: {
    compteurId: first.meter.id, externalId: randomUUID(), provider: first.provider, scope: first.scope,
    serviceAccountId: first.actor.serviceAccountId, enabled: false
  }})
  const blocked = [{windowStart: instant(3), windowEnd: instant(5), fetchedAt: instant(19), mode: 'LIVE'}]
  const firstBefore = await prisma.meterStream.update({where: {id: first.stream.id}, data: {
    checkpoint: new Date(instant(10)), blockedWindows: blocked, lastIssue: 'OLD_ISSUE'
  }})
  const emptyBefore = await prisma.meterStream.update({where: {id: empty.stream.id}, data: {
    checkpoint: new Date(instant(2)), lastReadingAt: new Date(instant(1))
  }})
  const foreignBefore = await prisma.meterStream.findUniqueOrThrow({where: {id: foreign.id}})
  const publicationsBefore = await publicationSnapshot(first)
  const readingsBefore = await readingsSnapshot(first)
  const states = [
    {stream: firstBefore, blockedWindows: [], issues: []},
    {stream: emptyBefore, blockedWindows: blocked, issues: ['INVALID_LOCAL_TIME']},
    {stream: shared, blockedWindows: [], issues: []}
  ]
  await prisma.$transaction(async tx => {
    await lockMeters(tx, [first.meter.id, empty.meter.id])
    await finalizeMeterStreamsInTransaction(tx, states, new Date(instant(5)))
  })
  const read = id => prisma.meterStream.findUniqueOrThrow({where: {id}})
  const [firstAfter, emptyAfter, sharedAfter] = await Promise.all([read(first.stream.id), read(empty.stream.id), read(shared.id)])
  t.is(firstAfter.checkpoint.toISOString(), instant(10))
  t.is(firstAfter.lastReadingAt.toISOString(), instant(9))
  t.deepEqual(firstAfter.blockedWindows, [])
  t.is(firstAfter.lastIssue, null)
  t.is(emptyAfter.checkpoint.toISOString(), instant(5))
  t.is(emptyAfter.lastReadingAt, null)
  t.deepEqual(emptyAfter.blockedWindows, blocked)
  t.is(emptyAfter.lastIssue, 'INVALID_LOCAL_TIME')
  t.is(sharedAfter.checkpoint.toISOString(), instant(5))
  t.is(sharedAfter.lastReadingAt.toISOString(), instant(9))
  t.deepEqual([firstAfter, emptyAfter, sharedAfter].map(row => row.lastSuccessAt), Array(3).fill(firstAfter.lastSuccessAt))
  t.deepEqual([firstAfter, emptyAfter, sharedAfter].map(row => row.updatedAt), Array(3).fill(firstAfter.lastSuccessAt))
  t.deepEqual(await read(foreign.id), foreignBefore)
  t.deepEqual(await publicationSnapshot(first), publicationsBefore)
  t.deepEqual(await readingsSnapshot(first), readingsBefore)
})

integration('failure after the common stream timestamp update rolls back the batch, readings, publications and states', async t => {
  const f = await fixture()
  const before = await prisma.meterStream.findUniqueOrThrow({where: {id: f.stream.id}})
  let updates = 0
  const failingClient = {$transaction: (callback, options) => prisma.$transaction(tx => callback(new Proxy(tx, {
    get(target, property) {
      if (property !== 'meterStream') return target[property]
      return new Proxy(target.meterStream, {
        get(delegate, operation) {
          if (operation !== 'updateMany') return delegate[operation]
          return args => {
            updates++
            if (updates === 2) throw new Error('INJECTED_STREAM_PATCH_FAILURE')
            return delegate.updateMany(args)
          }
        }
      })
    }
  })), options)}
  await t.throwsAsync(ingestMeterBatch(batch(f, [[3, 30], [4, 40]]), f.actor, {client: failingClient}), {
    message: 'INJECTED_STREAM_PATCH_FAILURE'
  })
  t.is(updates, 2)
  t.deepEqual(await prisma.meterStream.findUniqueOrThrow({where: {id: f.stream.id}}), before)
  t.is(await prisma.meterIngestion.count({where: {provider: f.provider, scope: f.scope}}), 0)
  t.is(await prisma.meterReading.count({where: {compteurId: f.meter.id}}), 0)
  t.is(await prisma.meterReadingRevision.count({where: {streamId: f.stream.id}}), 0)
  t.deepEqual(await publicationSnapshot(f), [])
  t.is(await prisma.chunk.count({where: {compteurId: f.meter.id}}), 0)
})

function activityObserver({beforeRefresh, afterRefresh} = {}) {
  const observation = {refreshes: [], sourceReads: []}
  observation.client = {$transaction: (callback, options) => prisma.$transaction(tx => callback(new Proxy(tx, {
    get(target, property) {
      if (property === '$queryRaw') return async (...args) => {
        const activity = args[0]?.sql?.includes('WITH declarant_activity AS MATERIALIZED')
        if (activity) {
          observation.refreshes.push(args[0].values)
          await beforeRefresh?.(target)
        }
        const result = await target.$queryRaw(...args)
        if (activity) await afterRefresh?.(target)
        return result
      }
      if (property !== 'source') return target[property]
      return new Proxy(target.source, {
        get(delegate, operation) {
          if (operation !== 'findMany') return delegate[operation]
          return args => {
            if (args.select?.chunks && args.select?.declaration) observation.sourceReads.push(args.where.id.in)
            return delegate.findMany(args)
          }
        }
      })
    }
  })), options)}
  return observation
}

integration('ingestion refreshes activity once for all published sources and distinct owners, with strict replay', async t => {
  const first = await fixture()
  const second = await fixture({scope: first.scope, serviceAccountId: first.actor.serviceAccountId})
  const outside = await fixture()
  const ownerIds = [first.user.id, second.user.id]
  const outsideBefore = await prisma.declarant.findUniqueOrThrow({where: {userId: outside.user.id}})
  const observer = activityObserver({beforeRefresh: async tx => {
    t.is(await tx.meterPublication.count({where: {compteurId: {in: [first.meter.id, second.meter.id]}, active: true}}), 4)
    t.deepEqual((await tx.declarant.findMany({where: {userId: {in: ownerIds}}})).map(row => row.lastDeclarationAt), [null, null])
  }})
  const payload = batch(first, [[1, 10], [2, 20], [3, 30]])
  payload.readings.push(...batch(second, [[1, 15], [2, 25], [3, 35]]).readings)
  const result = await ingestMeterBatch(payload, first.actor, {client: observer.client})
  t.is(result.counts.published, 4)
  t.is(observer.sourceReads.length, 1)
  t.is(observer.sourceReads[0].length, 4)
  t.deepEqual(observer.refreshes.map(ids => [...ids].sort()), [[...ownerIds].sort()])
  for (const f of [first, second]) {
    const publications = await publicationSnapshot(f)
    const latest = Math.max(...publications.map(row => new Date(row.source.createdAt).getTime()))
    t.is((await prisma.declarant.findUniqueOrThrow({where: {userId: f.user.id}})).lastDeclarationAt.getTime(), latest)
  }
  t.deepEqual(await previewDeclarantsLastDeclarationAt(ownerIds), [])
  t.deepEqual(await prisma.declarant.findUniqueOrThrow({where: {userId: outside.user.id}}), outsideBefore)
  const beforeReplay = await Promise.all([publicationSnapshot(first), publicationSnapshot(second)])
  t.deepEqual(await ingestMeterBatch(payload, first.actor, {client: observer.client}), result)
  t.is(observer.refreshes.length, 1)
  t.is(observer.sourceReads.length, 1)
  t.deepEqual(await Promise.all([publicationSnapshot(first), publicationSnapshot(second)]), beforeReplay)
})

integration('ingestion clears last activity when invalid readings supersede every publication without replacement', async t => {
  const f = await fixture()
  await ingestMeterBatch(batch(f, [[1, 10], [2, 20], [3, 30]]), f.actor)
  t.truthy((await prisma.declarant.findUniqueOrThrow({where: {userId: f.user.id}})).lastDeclarationAt)
  const observer = activityObserver()
  const payload = batch(f, [[2, 20, 'INVALID']], {fetchedAt: instant(21)})
  const result = await ingestMeterBatch(payload, f.actor, {client: observer.client})
  t.is(result.counts.published, 0)
  t.deepEqual(activeSummary(await publicationSnapshot(f)), [])
  t.deepEqual(observer.refreshes, [[f.user.id]])
  t.is(observer.sourceReads.length, 1)
  t.is(observer.sourceReads[0].length, 2)
  t.is((await prisma.declarant.findUniqueOrThrow({where: {userId: f.user.id}})).lastDeclarationAt, null)
  t.deepEqual(await previewDeclarantsLastDeclarationAt([f.user.id]), [])
  t.deepEqual(await ingestMeterBatch(payload, f.actor, {client: observer.client}), result)
  t.is(observer.refreshes.length, 1)
})

integration('batched activity failure rolls back revisions, publications, stream state and activity together', async t => {
  const f = await fixture()
  await ingestMeterBatch(batch(f, [[1, 10], [2, 20], [3, 30]]), f.actor)
  const before = {
    stream: await prisma.meterStream.findUniqueOrThrow({where: {id: f.stream.id}}),
    declarant: await prisma.declarant.findUniqueOrThrow({where: {userId: f.user.id}}),
    publications: await publicationSnapshot(f),
    readings: await readingsSnapshot(f)
  }
  const observer = activityObserver({afterRefresh: () => { throw new Error('INJECTED_ACTIVITY_REFRESH_FAILURE') }})
  await t.throwsAsync(ingestMeterBatch(batch(f, [[2, 25]], {fetchedAt: instant(21)}), f.actor, {client: observer.client}), {
    message: 'INJECTED_ACTIVITY_REFRESH_FAILURE'
  })
  t.deepEqual(observer.refreshes, [[f.user.id]])
  t.is(observer.sourceReads[0].length, 4)
  t.deepEqual(await prisma.meterStream.findUniqueOrThrow({where: {id: f.stream.id}}), before.stream)
  t.deepEqual(await prisma.declarant.findUniqueOrThrow({where: {userId: f.user.id}}), before.declarant)
  t.deepEqual(await publicationSnapshot(f), before.publications)
  t.deepEqual(await readingsSnapshot(f), before.readings)
  t.is(await prisma.meterIngestion.count({where: {provider: f.provider, scope: f.scope}}), 1)
  t.is(await prisma.meterReadingRevision.count({where: {streamId: f.stream.id}}), 3)
  t.is(await prisma.source.count({where: {metadata: {path: ['meterStreamId'], equals: f.stream.id}}}), 2)
})

integration('direct reprocessing keeps immediate activity refresh when reactivating an existing publication', async t => {
  const f = await fixture()
  await ingestMeterBatch(batch(f, [[1, 10], [2, 20]]), f.actor)
  const [publication] = await publicationSnapshot(f)
  await prisma.$transaction([
    prisma.meterPublication.update({where: {id: publication.id}, data: {active: false, supersededAt: new Date()}}),
    prisma.chunk.updateMany({where: {sourceId: publication.sourceId}, data: {instructionStatus: 'REJECTED'}}),
    prisma.source.update({where: {id: publication.sourceId}, data: {globalInstructionStatus: 'REJECTED'}}),
    prisma.declarant.update({where: {userId: f.user.id}, data: {lastDeclarationAt: null}})
  ])
  const observer = activityObserver()
  await observer.client.$transaction(async tx => {
    const result = await reprocessMeterStreamInTransaction(tx, f.stream.id)
    t.is(result.published, 1)
    t.is((await tx.declarant.findUniqueOrThrow({where: {userId: f.user.id}})).lastDeclarationAt.toISOString(), publication.source.createdAt)
  })
  t.deepEqual(observer.refreshes, [[f.user.id]])
  t.deepEqual(observer.sourceReads, [])
  t.deepEqual(await previewDeclarantsLastDeclarationAt([f.user.id]), [])
})
