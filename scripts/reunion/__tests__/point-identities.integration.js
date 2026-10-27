import process from 'node:process'
import {randomUUID} from 'node:crypto'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../../lib/util/test-helpers/disposable-database.js'
import {stableSourceId} from '../lib/core.js'
import {synchronizePointIdentities} from '../sync-point-identities.js'

const enabled = process.env.REUNION_ACCESS_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

async function fixture(client) {
  const input = {id_point: 912345, nom: `Captage synthétique ${randomUUID()}`}
  const point = await client.pointPrelevement.create({data: {name: input.nom, sourceId: stableSourceId('point', input.id_point),
    waterBodyType: 'SOUTERRAIN', flowType: 'PRELEVEMENT', identifiers: {BSS: 'unchanged'}, codeBSS: 'unchanged-code', internalComment: 'unchanged-comment'}})
  const usage = await client.sandreWaterUse.findUniqueOrThrow({where: {code: '2'}})
  const date = new Date('2026-01-01T00:00:00Z')
  const source = await client.source.create({data: {type: 'DECLARATION', status: 'COMPLETED', chunks: {create: {
    pointPrelevementId: point.id, pointPrelevementName: input.nom, usageId: usage.id, minDate: date, maxDate: date,
    metadata: {nativeTemporal: true}, contentHash: 'unchanged-content', instructionStatus: 'VALIDATED', chunkValues: {create: {
      metricTypeCode: 'index', unit: 'm³', frequency: 'instant', periodStart: date, periodEnd: date, value: '12.123456789012345', metadata: {nativeTemporal: true}}}
  }}}, include: {chunks: {include: {chunkValues: true}}}})
  return {input, point, source}
}

integration('SQL simulation, targeted rename and replay preserve point UUID, other fields and historical values', async t => {
  const rollback = new Error('ROLLBACK_POINT_IDENTITY_TEST')
  try {
    await prisma.$transaction(async client => {
      const {input, point, source} = await fixture(client)
      const before = await client.chunkValue.findMany({where: {chunkId: source.chunks[0].id}})
      const simulation = await synchronizePointIdentities(client, {points: [input]})
      t.is(simulation.changes.length, 1)
      t.deepEqual(await client.pointPrelevement.findUnique({where: {id: point.id}}), point)
      const applied = await synchronizePointIdentities(client, {points: [input], apply: true,
        validatePlan: plan => { t.is(plan.planHash, simulation.planHash) }})
      t.true(applied.verified)
      t.is(applied.changes[0].id, point.id)
      const after = await client.pointPrelevement.findUniqueOrThrow({where: {id: point.id}})
      t.is(after.name, `${input.id_point} - ${input.nom}`)
      t.deepEqual(after.identifiers, {BSS: 'unchanged', REUNION: String(input.id_point)})
      t.is(after.codeBSS, point.codeBSS)
      t.is(after.internalComment, point.internalComment)
      t.deepEqual(await client.chunkValue.findMany({where: {chunkId: source.chunks[0].id}}), before)
      const replay = await synchronizePointIdentities(client, {points: [input], apply: true})
      t.is(replay.changes.length, 0)
      t.deepEqual(await client.pointPrelevement.findUnique({where: {id: point.id}}), after)
      t.is(replay.relationsHash, simulation.relationsHash)
      throw rollback
    })
  } catch (error) { if (error !== rollback) throw error }
})

integration('SQL refuses foreign name collision and stale simulation before any update', async t => {
  const rollback = new Error('ROLLBACK_POINT_IDENTITY_TEST')
  try {
    await prisma.$transaction(async client => {
      const {input, point} = await fixture(client)
      await t.throwsAsync(synchronizePointIdentities(client, {points: [input], apply: true,
        validatePlan: () => { throw new Error('stale simulation') }}), {message: 'stale simulation'})
      t.deepEqual(await client.pointPrelevement.findUnique({where: {id: point.id}}), point)
      await client.pointPrelevement.create({data: {name: `${input.id_point} - ${input.nom}`, sourceId: `foreign:${randomUUID()}`,
        waterBodyType: 'SOUTERRAIN', flowType: 'PRELEVEMENT'}})
      await t.throwsAsync(synchronizePointIdentities(client, {points: [input], apply: true}), {message: /Nom cible/})
      t.deepEqual(await client.pointPrelevement.findUnique({where: {id: point.id}}), point)
      throw rollback
    })
  } catch (error) { if (error !== rollback) throw error }
})
