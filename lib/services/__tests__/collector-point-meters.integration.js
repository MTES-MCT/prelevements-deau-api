import process from 'node:process'
import {randomUUID} from 'node:crypto'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {getCollectorExploitationMeters, saveCollectorExploitationMeters} from '../collector-point-meters.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

async function fixture(run) {
  const rollback = new Error('ROLLBACK_SYNTHETIC_FIXTURE')
  try {
    await prisma.$transaction(async tx => {
      const user = await tx.user.create({data: {role: 'DECLARANT', declarant: {create: {declarantRole: 'PRELEVEUR', preleveurType: 'IRRIGANT'}}}})
      const point = await tx.pointPrelevement.create({data: {name: `Synthetic meter ${randomUUID()}`, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'}})
      const usage = await tx.sandreWaterUse.findFirstOrThrow({where: {code: '2', kind: 'USAGE'}})
      const exploitation = await tx.declarantPointPrelevement.create({data: {declarantUserId: user.id, pointPrelevementId: point.id,
        usageId: usage.id, status: 'EN_ACTIVITE'}})
      const meters = [{serialNumber: `000-${randomUUID()}`}]
      const {mutations} = await saveCollectorExploitationMeters(tx, {exploitation, meters, actorId: user.id})
      const meter = await tx.compteur.findUniqueOrThrow({where: {id: mutations[0].entityId}})
      await run({tx, exploitation, point, user, usage, meter})
      throw rollback
    }, {isolationLevel: 'Serializable', timeout: 20_000})
  } catch (error) {
    if (error !== rollback) throw error
  }
}

integration('SQL: create, correct and clear a serial without any readings, streams or allocation changes', async t => {
  await fixture(async ({tx, exploitation, meter}) => {
    const allocations = await tx.meterAllocation.findMany({where: {compteurId: meter.id}, include: {versions: true}})
    t.is(allocations.length, 1)
    t.deepEqual(allocations[0].versions.map(({enabled, percentage, startDate, endDate}) => ({enabled, percentage, startDate, endDate})),
      [{enabled: false, percentage: null, startDate: null, endDate: null}])
    const corrected = `000-corrected-${randomUUID()}`
    await saveCollectorExploitationMeters(tx, {exploitation, meters: [{id: meter.id, expectedUpdatedAt: meter.updatedAt.toISOString(), serialNumber: corrected}]})
    const [visible] = await getCollectorExploitationMeters(tx, exploitation.id)
    t.is(visible.id, meter.id)
    t.is(visible.serialNumber, corrected)
    t.true(visible.capabilities.canEditSerialNumber)
    await saveCollectorExploitationMeters(tx, {exploitation, meters: [{id: meter.id, expectedUpdatedAt: visible.updatedAt.toISOString(), serialNumber: null}]})
    t.is((await tx.compteur.findUniqueOrThrow({where: {id: meter.id}})).serialNumber, null)
    t.deepEqual(await tx.meterAllocation.findMany({where: {compteurId: meter.id}, include: {versions: true}}), allocations)
    t.is(await tx.meterStream.count({where: {compteurId: meter.id}}), 0)
    t.is(await tx.meterReading.count({where: {compteurId: meter.id}}), 0)
    t.is(await tx.chunk.count({where: {compteurId: meter.id}}), 0)
  })
})

integration('SQL: historical shared allocation and external reference forbid serial edits without exposing beneficiaries', async t => {
  await fixture(async ({tx, exploitation, meter, usage}) => {
    const otherUser = await tx.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT'}}}})
    const other = await tx.declarantPointPrelevement.create({data: {declarantUserId: otherUser.id,
      pointPrelevementId: exploitation.pointPrelevementId, usageId: usage.id, status: 'TERMINEE', endDate: new Date('2025-01-01')}})
    const link = await tx.meterAllocation.create({data: {sourceId: randomUUID(), provider: 'manual-collection', scope: randomUUID(),
      compteurId: meter.id, exploitationId: other.id}})
    const [visible] = await getCollectorExploitationMeters(tx, exploitation.id)
    t.is(visible.capabilities.reason, 'SHARED_METER')
    t.false(JSON.stringify(visible).includes(other.id))
    const error = await t.throwsAsync(saveCollectorExploitationMeters(tx, {exploitation,
      meters: [{id: meter.id, expectedUpdatedAt: meter.updatedAt.toISOString(), serialNumber: 'changed'}]}))
    t.is(error.status, 403)
    await tx.meterAllocation.delete({where: {id: link.id}})
    await tx.externalReference.create({data: {provider: 'willie', scope: randomUUID(), kind: 'METER', externalId: randomUUID(), compteurId: meter.id}})
    t.is((await getCollectorExploitationMeters(tx, exploitation.id))[0].capabilities.reason, 'EXTERNAL_METER')
    t.is((await tx.compteur.findUniqueOrThrow({where: {id: meter.id}})).serialNumber, meter.serialNumber)
  })
})

integration('SQL: an ambiguous legacy chunk protects the physical identity', async t => {
  await fixture(async ({tx, exploitation, meter, usage}) => {
    const source = await tx.source.create({data: {type: 'BATCH', status: 'COMPLETED'}})
    await tx.chunk.create({data: {sourceId: source.id, compteurId: meter.id, pointPrelevementId: exploitation.pointPrelevementId,
      preleveurUserId: exploitation.declarantUserId, usageId: usage.id, minDate: new Date('2025-01-01'), maxDate: new Date('2025-12-31')}})
    t.is((await getCollectorExploitationMeters(tx, exploitation.id))[0].capabilities.reason, 'AMBIGUOUS_HISTORY')
    const error = await t.throwsAsync(saveCollectorExploitationMeters(tx, {exploitation,
      meters: [{id: meter.id, expectedUpdatedAt: meter.updatedAt.toISOString(), serialNumber: 'changed'}]}))
    t.is(error.status, 403)
  })
})

integration('SQL: case, whitespace and deleted-meter collisions refuse implicit associations', async t => {
  await fixture(async ({tx, exploitation}) => {
    const serial = `mixed-${randomUUID()}`
    await tx.compteur.create({data: {serialNumber: ` ${serial.toUpperCase()} `, deletedAt: new Date()}})
    const before = await tx.meterAllocation.count({where: {exploitationId: exploitation.id}})
    const error = await t.throwsAsync(saveCollectorExploitationMeters(tx, {exploitation, meters: [{serialNumber: serial}]}))
    t.is(error.status, 409)
    t.is(await tx.meterAllocation.count({where: {exploitationId: exploitation.id}}), before)
  })
})
