/* eslint-disable no-await-in-loop -- Synthetic rows are created inside one rolled-back transaction. */
import test from 'ava'
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {getWillieConnectorCursors} from '../connector-cursors.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => {
  await prisma.$disconnect()
  await globalThis.pgPool?.end()
})

integration('Willie reprend chaque module sur ses seules valeurs persistées, même avant le rattachement historique', async t => {
  const rollback = new Error('SYNTHETIC_ROLLBACK')
  try {
    await prisma.$transaction(async client => {
      const owner = await client.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT'}}}})
      const point = await client.pointPrelevement.create({data: {name: `Curseurs synthétiques ${randomUUID()}`, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'}})
      const usage = await client.sandreWaterUse.findFirst({where: {kind: 'USAGE'}})
      const exploitation = await client.declarantPointPrelevement.create({data: {
        declarantUserId: owner.id, pointPrelevementId: point.id, usageId: usage.id,
        mostRecentAvailableDate: new Date('2026-12-01Z')
      }})
      const connectors = []
      for (const name of ['one', 'two', 'empty']) connectors.push(await client.declarantPointPrelevementConnector.create({data: {
        declarantPointPrelevementId: exploitation.id, connectorType: 'willie', connectorParameters: {sourcePointId: name}
      }}))
      const add = async ({connector = connectors[0], day, sourceType = 'API', station, instructionStatus = 'VALIDATED', strategy = 'GENERIC', metric = 'volume', attached = true, preleveurUserId = owner.id}) => {
        const start = new Date(`2026-01-${String(day).padStart(2, '0')}T00:00:00Z`)
        const end = new Date(start.getTime() + 86_400_000)
        await client.source.create({data: {
          type: sourceType, status: 'COMPLETED', metadata: {
            connector: 'willie', connectorId: connector.id, sourcePointId: station ?? connector.connectorParameters.sourcePointId
          }, chunks: {create: {
            pointPrelevementId: point.id, preleveurUserId, exploitationId: attached ? exploitation.id : null,
            usageId: usage.id, instructionStatus, calculationStrategy: strategy, minDate: start, maxDate: end,
            chunkValues: {create: {metricTypeCode: metric, frequency: '1 day', unit: 'm3', periodStart: start, periodEnd: end, value: 10}}
          }}
        }})
      }
      await add({day: 1})
      await add({connector: connectors[1], day: 3, attached: false})
      await add({day: 4, sourceType: 'DECLARATION'})
      await add({day: 5, station: 'another-station'})
      await add({day: 6, instructionStatus: 'REJECTED'})
      await add({day: 7, strategy: 'METER'})
      await add({day: 8, metric: 'index'})
      await add({day: 9, preleveurUserId: null, attached: false})
      const cursors = await getWillieConnectorCursors(connectors, {client})
      t.is(cursors.get(connectors[0].id).toISOString(), '2026-01-02T00:00:00.000Z')
      t.is(cursors.get(connectors[1].id).toISOString(), '2026-01-04T00:00:00.000Z')
      t.is(cursors.get(connectors[2].id), null)
      t.is((await getWillieConnectorCursors([{id: randomUUID(), connectorType: 'eveler'}], {client})).size, 0)
      throw rollback
    })
  } catch (error) {
    if (error !== rollback) throw error
  }
})
