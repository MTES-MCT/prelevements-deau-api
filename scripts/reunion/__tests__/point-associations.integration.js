import process from 'node:process'
import {randomUUID, randomBytes} from 'node:crypto'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../../lib/util/test-helpers/disposable-database.js'
import * as associations from '../../../lib/declaration-importer/native-point-association.js'
import {computeGlobalPointMatchingStatus} from '../../../lib/handlers/chunks.js'
import {historyPlanHash} from '../lib/history-target.js'
import {associationRepairScope, assertAssociationBackup, reconcilePointAssociations, repairChunkTotals} from '../repair-point-associations.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
const helpers = {...associations, computeGlobalPointMatchingStatus}
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

function scopeFixture() {
  const points = Array.from({length: 11}, (_, index) => ({id: randomUUID(), sourceId: `reunion:DEP-974:point:${970000 + index}`, identifiers: {REUNION: String(970000 + index)}}))
  const sources = Array.from({length: 59}, () => ({id: randomUUID()}))
  const chunks = Array.from({length: 291}, (_, index) => ({id: randomUUID(), sourceId: sources[index % sources.length].id,
    metadata: {sourcePointReference: points[index % points.length].sourceId}}))
  return {points, sources, chunks, chunkIds: chunks.map(chunk => chunk.id)}
}

test('reprise : une cohorte incomplète, dupliquée ou avec identité PP contradictoire est refusée', t => {
  const snapshot = scopeFixture()
  t.is(associationRepairScope(snapshot).chunkIds.length, 291)
  const invalid = [
    {...snapshot, chunkIds: snapshot.chunkIds.slice(1)},
    {...snapshot, chunkIds: [snapshot.chunkIds[1], ...snapshot.chunkIds.slice(1)]},
    {...snapshot, points: snapshot.points.map((point, index) => index === 0 ? {...point, identifiers: {REUNION: 'other'}} : point)},
    {...snapshot, points: snapshot.points.map((point, index) => index === 0 ? {...point, deletedAt: '2026-01-01'} : point)}
  ]
  for (const changed of invalid) t.throws(() => associationRepairScope(changed))
})

test('reprise : sauvegarde, cohorte et plan doivent avoir les mêmes empreintes', t => {
  const snapshot = {...scopeFixture(), declarations: [], sourceChunks: [], exploitations: [], usages: [], actorActivity: []}
  const hashes = {sourceHash: 'source-hash', planHash: 'plan-hash', snapshotSha256: 'snapshot-hash'}
  const evidence = {operation: 'reunion-native-point-associations', sourceHash: hashes.sourceHash, planHash: hashes.planHash,
    backup: {sha256: hashes.snapshotSha256}, rowsSha256: historyPlanHash({sources: snapshot.sources, declarations: snapshot.declarations,
      chunks: snapshot.sourceChunks, points: snapshot.points, exploitations: snapshot.exploitations, usages: snapshot.usages, actorActivity: snapshot.actorActivity})}
  t.notThrows(() => assertAssociationBackup(evidence, snapshot, hashes))
  for (const changed of [{...evidence, sourceHash: 'other'}, {...evidence, planHash: 'other'}, {...evidence, backup: {sha256: 'other'}},
    {...evidence, rowsSha256: 'other'}, {...evidence, operation: 'other'}]) {
    t.throws(() => assertAssociationBackup(changed, snapshot, hashes))
  }
})

test('reprise : les volumes décimaux sont additionnés exactement avant la conversion des totaux', t => {
  const values = [{metricTypeCode: 'volume', value: '0.1'}, {metricTypeCode: 'volume', value: '0.2'}, {metricTypeCode: 'index', value: '99'}]
  t.deepEqual(repairChunkTotals(values, 'PRELEVEMENT'), {totalWaterVolume: 0.3, totalWaterVolumeWithdrawn: 0.3, totalWaterVolumeDischarged: 0})
  t.deepEqual(repairChunkTotals(values, 'REJET'), {totalWaterVolume: 0.3, totalWaterVolumeWithdrawn: 0, totalWaterVolumeDischarged: 0.3})
})

async function fixture(run) {
  const rollback = new Error('ROLLBACK_POINT_ASSOCIATION_REPAIR')
  try {
    await prisma.$transaction(async client => {
      await client.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'")
      const owner = await client.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT', lastDeclarationAt: new Date(Date.UTC(2026, 0, 59))}}}})
      const usage = await client.sandreWaterUse.findUniqueOrThrow({where: {code: '0'}})
      const initial = scopeFixture()
      await client.pointPrelevement.createMany({data: initial.points.map(point => ({...point, name: `PP synthétique ${point.id}`,
        waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'}))})
      await client.declarantPointPrelevement.create({data: {pointPrelevementId: initial.points[0].id, declarantUserId: owner.id,
        usageId: usage.id, startDate: new Date('2027-01-01'), countingCode: 'SYNTHETIC_CACHE'}})
      const declarations = initial.sources.map((source, index) => ({id: randomUUID(), code: randomBytes(3).toString('hex'), type: 'reunion_camion_citerne',
        declarantUserId: owner.id, waterWithdrawalType: 'unknown', dataSourceType: 'SPREADSHEET', importSourceId: `reunion:synthetic:${randomUUID()}`,
        createdAt: new Date(Date.UTC(2026, 0, index + 1))}))
      await client.declaration.createMany({data: declarations})
      await client.source.createMany({data: initial.sources.map((source, index) => ({id: source.id, declarationId: declarations[index].id,
        type: 'DECLARATION', status: 'COMPLETED', createdAt: new Date(Date.UTC(2026, 0, index + 1)),
        metadata: {nativeTemporal: true, provenance: 'DN'}}))})
      const chunks = initial.chunks.map((chunk, index) => {
        const reference = index === 1 ? initial.points[0].sourceId : chunk.metadata.sourcePointReference
        const date = new Date(Date.UTC(2025, 0, index === 1 ? 1 : index + 1))
        const issue = {code: 'UNMATCHED_POINT', severity: 'warning', seriesKey: chunk.id}
        return {...chunk, seriesKey: chunk.id, pointPrelevementName: reference, preleveurUserId: owner.id, submittedByDeclarantUserId: owner.id,
          usageId: usage.id, instructionStatus: 'PENDING', contentHash: `unchanged-${index}`, minDate: date, maxDate: date,
          metadata: {nativeTemporal: true, sourcePointReference: reference, valueType: 'cumulative', totalWaterVolume: 0,
            totalWaterVolumeWithdrawn: 0, totalWaterVolumeDischarged: 0, importHistory: [{reason: 'IMPORT'}]},
          parsingInfo: {issues: [issue], issueCounts: {total: 1, byCode: {UNMATCHED_POINT: 1}, bySeverity: {warning: 1}}, issuesSampled: false}}
      })
      await client.chunk.createMany({data: chunks})
      await client.chunkValue.createMany({data: chunks.map(chunk => ({chunkId: chunk.id, periodStart: chunk.minDate,
        periodEnd: new Date(+chunk.minDate + 86400000), metricTypeCode: 'volume', frequency: '1 day', unit: 'm³', value: '1',
        metadata: {nativeTemporal: true, originalCell: 'B4'}}))})
      const read = async (table, column, ids) => (await client.$queryRawUnsafe(
        `SELECT to_jsonb(t) AS row FROM "${table}" t WHERE "${column}" = ANY($1::uuid[]) ORDER BY id`, ids)).map(item => item.row)
      const state = async () => ({sources: await read('Source', 'id', initial.sources.map(row => row.id)),
        declarations: await read('Declaration', 'id', declarations.map(row => row.id)), chunks: await read('Chunk', 'id', initial.chunkIds),
        points: await read('PointPrelevement', 'id', initial.points.map(row => row.id)),
        exploitations: await read('DeclarantPointPrelevement', 'pointPrelevementId', initial.points.map(row => row.id)), usages: await read('SandreWaterUse', 'id', [usage.id]),
        actorActivity: await client.$queryRaw`SELECT "userId", "lastDeclarationAt"::text AS "lastDeclarationAt" FROM "Declarant" WHERE "userId"=${owner.id}::uuid`})
      const fingerprints = () => client.$queryRawUnsafe(`SELECT "chunkId", count(*)::integer AS count,
        md5(string_agg(md5(to_jsonb(v)::text), '' ORDER BY v.id)) AS "orderedRowsMd5"
        FROM "ChunkValue" v WHERE "chunkId"=ANY($1::uuid[]) GROUP BY "chunkId" ORDER BY "chunkId"`, initial.chunkIds)
      const before = await state()
      const snapshot = {...before, sourceChunks: before.chunks, chunks: before.chunks, chunkIds: initial.chunkIds,
        valueFingerprints: await fingerprints()}
      await run({client, owner, snapshot, state, fingerprints, duplicateId: chunks[1].id})
      throw rollback
    }, {timeout: 90000})
  } catch (error) { if (error !== rollback) throw error }
}

integration('reprise SQL : simulation sans écriture, conflit interne, application bornée et rejeu sans changement', async t => {
  await fixture(async ({client, snapshot, state, fingerprints, duplicateId}) => {
    const before = await state(), valuesBefore = await fingerprints()
    const simulation = await reconcilePointAssociations(client, {snapshot, helpers})
    t.is(simulation.changes.length, 291)
    t.is(simulation.sourceChanges.length, 59)
    t.is(simulation.availabilityChanges.length, 1)
    t.is(simulation.changes.filter(change => change.data.instructionStatus === 'REJECTED').length, 1)
    t.is(simulation.changes.find(change => change.id === duplicateId).data.instructionStatus, 'REJECTED')
    t.true(simulation.changes.every(change => change.data.exploitationId === null))
    t.deepEqual(await state(), before)
    t.deepEqual(await fingerprints(), valuesBefore)
    await t.throwsAsync(reconcilePointAssociations(client, {snapshot, helpers, apply: true,
      validatePlan: () => { throw new Error('Plan non approuvé') }}), {message: 'Plan non approuvé'})
    t.deepEqual(await state(), before)
    const applied = await reconcilePointAssociations(client, {snapshot, helpers, apply: true,
      validatePlan: plan => { t.is(plan.planHash, simulation.planHash) }})
    t.true(applied.verified)
    t.is(applied.changes.length, 291)
    t.is(applied.afterState.sources.reduce((sum, source) => sum + source.metadata.totalWaterVolumeWithdrawn, 0), 290)
    t.deepEqual(await fingerprints(), valuesBefore)
    t.deepEqual(applied.afterState.points, before.points)
    t.deepEqual(applied.afterState.declarations, before.declarations)
    t.deepEqual(applied.afterState.exploitations.map(({updatedAt, mostRecentAvailableDate, ...identity}) => identity),
      before.exploitations.map(({updatedAt, mostRecentAvailableDate, ...identity}) => identity))
    const latest = Math.max(...applied.afterState.chunks.filter(chunk => chunk.pointPrelevementId === before.exploitations[0].pointPrelevementId
      && chunk.instructionStatus !== 'REJECTED').map(chunk => +new Date(chunk.maxDate)))
    t.is(+new Date(`${applied.afterState.exploitations[0].mostRecentAvailableDate}Z`), latest)
    t.is(before.exploitations[0].mostRecentAvailableDate, null)
    t.deepEqual(applied.afterState.actorActivity, before.actorActivity)
    const previousReport = {...applied, apply: true, complete: true, operation: 'reunion-native-point-associations'}
    let replayValidated = false
    const replay = await reconcilePointAssociations(client, {snapshot, helpers, apply: true, previousReport,
      validatePlan: () => { replayValidated = true }})
    t.true(replay.alreadyApplied)
    t.true(replayValidated)
    t.is(replay.changes.length, 0)
    t.is(replay.availabilityChanges.length, 0)
    t.deepEqual(await state(), applied.afterState)
    t.deepEqual(await fingerprints(), valuesBefore)
    await client.chunkValue.updateMany({where: {chunkId: snapshot.chunkIds[0]}, data: {value: '3'}})
    await t.throwsAsync(reconcilePointAssociations(client, {snapshot, helpers, apply: true, previousReport}), {message: /Valeurs différentes de la sauvegarde/})
    t.deepEqual(await state(), applied.afterState)
  })
})

integration('reprise SQL : une valeur différente du snapshot empêche toute association', async t => {
  await fixture(async ({client, snapshot, state}) => {
    await client.chunkValue.updateMany({where: {chunkId: snapshot.chunkIds[0]}, data: {value: '2'}})
    const before = await state()
    await t.throwsAsync(reconcilePointAssociations(client, {snapshot, helpers, apply: true}), {message: /Valeurs différentes de la sauvegarde/})
    t.deepEqual(await state(), before)
  })
})

integration('reprise SQL : une activité incohérente est bloquée sans étendre les colonnes modifiées', async t => {
  await fixture(async ({client, owner, snapshot, state}) => {
    await client.declarant.update({where: {userId: owner.id}, data: {lastDeclarationAt: new Date('2026-01-01')}})
    const before = await state()
    snapshot.actorActivity = before.actorActivity
    await t.throwsAsync(reconcilePointAssociations(client, {snapshot, helpers, apply: true}), {message: /activité/})
    t.deepEqual(await state(), before)
  })
})
