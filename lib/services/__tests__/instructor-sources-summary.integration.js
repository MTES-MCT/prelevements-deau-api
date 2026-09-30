/* eslint-disable no-await-in-loop -- Synthetic fixtures share one transaction that always rolls back. */
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {listSourcesForAdmin, listSourcesForInstructor} from '../instructor-sources.js'

const integration = process.env.METER_INTEGRATION_TESTS === '1' ? test.serial : test.skip
test.before(() => { if (process.env.METER_INTEGRATION_TESTS === '1') requireDisposableDatabase() })
test.after.always(async () => {
  await prisma.$disconnect()
  await globalThis.pgPool?.end()
})

integration('la liste summary garde les totaux, dates et bénéficiaires METER dans le périmètre autorisé', async t => {
  const rollback = new Error('ROLLBACK_SUMMARY_FIXTURE')
  try {
    await prisma.$transaction(async client => {
      const usage = await client.sandreWaterUse.create({data: {
        code: `s${randomUUID().slice(0, 12)}`, kind: 'USAGE', label: 'Résumé synthétique'
      }})
      const source = await client.source.create({data: {
        type: 'API', status: 'COMPLETED', metadata: {calculationStrategy: 'METER', totalWaterVolumeWithdrawn: 100}
      }})
      const actors = []
      const points = []
      const zones = []
      for (let index = 0; index < 2; index++) {
        const actor = await client.user.create({data: {
          role: 'DECLARANT', firstName: `Prénom ${index}`, lastName: 'Synthétique',
          declarant: {create: {declarantRole: 'PRELEVEUR', preleveurType: 'IRRIGANT'}}
        }})
        actors.push(actor)
        const zoneId = randomUUID()
        await client.$executeRaw`INSERT INTO "Zone" (id,code,type,name,coordinates,"createdAt","updatedAt")
          VALUES (${zoneId}::uuid, ${zoneId}, 'SAGE', 'Résumé synthétique',
            ST_Multi(ST_GeomFromText('POLYGON((0 0,0 1,1 1,1 0,0 0))',4326)), CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`
        zones.push(zoneId)
        const point = await client.pointPrelevement.create({data: {
          name: randomUUID(), waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT',
          zones: {create: {zoneId}}
        }})
        points.push(point)
        await client.declarantPointPrelevement.create({data: {
          pointPrelevementId: point.id, declarantUserId: actor.id, usageId: usage.id
        }})
        const periodStart = new Date(`2026-08-3${index}T21:59:30Z`)
        const periodEnd = new Date(`2026-08-3${index}T22:00:30Z`)
        await client.chunk.create({data: {
          sourceId: source.id, calculationStrategy: 'METER', instructionStatus: 'AUTOMATICALLY_VALIDATED',
          pointPrelevementId: point.id, preleveurUserId: actor.id, usageId: usage.id, flowType: 'PRELEVEMENT',
          minDate: periodStart, maxDate: periodEnd,
          metadata: {totalWaterVolumeWithdrawn: index === 0 ? 40 : 60},
          parsingInfo: {diagnostics: 'Non nécessaire dans la liste'},
          chunkValues: {create: {metricTypeCode: 'volume', frequency: 'irregular', unit: 'm³',
            value: index === 0 ? 40 : 60, periodStart, periodEnd}}
        }})
      }
      // A shared point must not expose the other beneficiary in the list.
      await client.declarantPointPrelevement.create({data: {
        pointPrelevementId: points[0].id, declarantUserId: actors[1].id, usageId: usage.id
      }})
      for (const [list, filters, expectedTotal, expectedCount] of [
        [listSourcesForInstructor, {zoneIds: [zones[0]]}, 40, 1],
        [listSourcesForAdmin, {}, 100, 2]
      ]) {
        const detailed = (await list(filters, {client})).items.find(item => item.id === source.id)
        const summary = (await list({...filters, view: 'summary'}, {client})).items.find(item => item.id === source.id)
        t.deepEqual(summary.metadata, detailed.metadata)
        t.is(summary.metadata.totalWaterVolumeWithdrawn, expectedTotal)
        t.is(summary._count.chunks, expectedCount)
        t.is(summary.chunks.length, expectedCount)
        t.is(summary.readOnly, true)
        const metadataById = chunks => Object.fromEntries(chunks.map(chunk => [chunk.id, chunk.metadata]))
        t.deepEqual(metadataById(summary.chunks), metadataById(detailed.chunks))
        for (const chunk of summary.chunks) {
          t.false(Object.hasOwn(chunk, 'parsingInfo'))
          t.deepEqual(chunk.pointPrelevement.declarants.map(link => link.declarantUserId), [chunk.preleveurUserId])
          t.deepEqual(Object.keys(chunk.pointPrelevement.declarants[0].declarant.user).sort(), ['firstName', 'id', 'lastName'])
          t.is(chunk._count.chunkValues, 1)
        }
      }
      throw rollback
    }, {timeout: 30000})
  } catch (error) {
    if (error !== rollback) throw error
  }
})
