/* eslint-disable no-await-in-loop -- Isolated synthetic connector fixtures and ordered deliveries. */
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {ingestAuthorizedConnectorOutput, ingestServiceAccountConnectorOutputHandler} from '../service-account-connectors.js'
import {getAuthorizedCumulativeAggregation} from '../series-aggregation.js'
import {findConflictingChunkValuesForIncomingChunkValues} from '../../services/chunk-value-conflicts.js'

const integration = process.env.METER_INTEGRATION_TESTS === '1' ? test.serial : test.skip
const start = new Date('2026-07-01T00:00:00Z')
const end = new Date('2026-07-02T00:00:00Z')
test.before(() => { if (process.env.METER_INTEGRATION_TESTS === '1') requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

async function fixture(client) {
  const owner = await client.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT'}}}})
  const point = await client.pointPrelevement.create({data: {
    name: `Connecteurs synthétiques ${randomUUID()}`, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'
  }})
  const usage = await client.sandreWaterUse.findUniqueOrThrow({where: {code: '2'}})
  const exploitation = await client.declarantPointPrelevement.create({data: {
    declarantUserId: owner.id, pointPrelevementId: point.id, usageId: usage.id, status: 'EN_ACTIVITE'
  }})
  const connectors = []
  for (const [sourcePointId, rate] of [['module-a', 100], ['module-b', 50], [' MODULE-A ', 100]]) {
    connectors.push(await client.declarantPointPrelevementConnector.create({data: {
      declarantPointPrelevementId: exploitation.id, connectorType: 'willie', rate, connectorParameters: {sourcePointId}
    }}))
  }
  return {owner, point, usage, exploitation, connectors}
}

async function rollbackFixture(operation) {
  const rollback = new Error('ROLLBACK_CONNECTOR_FIXTURE')
  try {
    await prisma.$transaction(async client => {
      await operation(client, await fixture(client))
      throw rollback
    }, {timeout: 60000})
  } catch (error) {
    if (error !== rollback) throw error
  }
}

async function committedFixture(operation) {
  const f = await fixture(prisma)
  try {
    await operation(f)
  } finally {
    await prisma.source.deleteMany({where: {chunks: {some: {pointPrelevementId: f.point.id}}}})
    await prisma.user.delete({where: {id: f.owner.id}})
    await prisma.pointPrelevement.delete({where: {id: f.point.id}})
    await prisma.exploitationIdentityLock.deleteMany({where: {declarantUserId: f.owner.id}})
  }
}

function input(f, index = 0, metricOverrides = {}) {
  return {
    data: {metrics: [{type: 'volume', unit: 'm3', granularity: '1 day', conflictPolicy: 'SKIP_NEW_CHUNK', usage: '2',
      values: [{periodStart: start.toISOString(), periodEnd: end.toISOString(), value: 100}], ...metricOverrides}]},
    connector: 'willie', serviceAccount: 'synthetic', contextId: randomUUID(),
    point: f.point, declarantId: f.owner.id, exploitationId: f.exploitation.id,
    connectorId: f.connectors[index].id, sourcePointId: f.connectors[index].connectorParameters.sourcePointId
  }
}

async function storedValues(client, f) {
  return client.chunkValue.findMany({where: {chunk: {pointPrelevementId: f.point.id}},
    include: {chunk: true}, orderBy: {id: 'asc'}})
}

integration('deux modules Willie additionnent 100 % et 50 % sur une même exploitation sans modifier son usage', async t => {
  await rollbackFixture(async (client, f) => {
    const first = await ingestAuthorizedConnectorOutput(input(f), {client})
    const second = await ingestAuthorizedConnectorOutput(input(f, 1), {client})
    t.true(first.imported)
    t.true(second.imported)
    const values = await storedValues(client, f)
    t.deepEqual(values.map(row => Number(row.value)).sort((a, b) => a - b), [50, 100])
    t.true(values.every(row => row.chunk.exploitationId === f.exploitation.id
      && row.chunk.preleveurUserId === f.owner.id && row.chunk.usageId === f.usage.id))
    t.is((await client.declarantPointPrelevement.findUnique({where: {id: f.exploitation.id}})).usageId, f.usage.id)
    t.is(await client.declarantPointPrelevementSecondaryUsage.count({where: {exploitationId: f.exploitation.id}}), 0)
    const aggregate = await getAuthorizedCumulativeAggregation({client, pointIds: [f.point.id],
      exploitationId: f.exploitation.id, preleveurId: f.owner.id, user: {role: 'ADMIN'},
      metricTypeCode: 'volume', pointFlowType: 'PRELEVEMENT', aggregationFrequency: '1 day'})
    t.deepEqual(aggregate.values.map(row => Number(row.value)), [150])
    const before = await client.source.findMany({where: {id: {in: [first.sourceId, second.sourceId]}}})
    t.false((await ingestAuthorizedConnectorOutput(input(f), {client})).imported)
    t.false((await ingestAuthorizedConnectorOutput(input(f, 1), {client})).imported)
    t.false((await ingestAuthorizedConnectorOutput(input(f, 2), {client})).imported)
    t.deepEqual(await storedValues(client, f), values)
    t.deepEqual(await client.source.findMany({where: {id: {in: [first.sourceId, second.sourceId]}}}), before)
  })
})

integration('un remplacement reste limité au module courant et conserve le volume du voisin', async t => {
  await rollbackFixture(async (client, f) => {
    await ingestAuthorizedConnectorOutput(input(f), {client})
    await ingestAuthorizedConnectorOutput(input(f, 1), {client})
    await ingestAuthorizedConnectorOutput(input(f, 0, {conflictPolicy: 'REPLACE_EXISTING',
      values: [{periodStart: start.toISOString(), periodEnd: end.toISOString(), value: 120}]}), {client})
    const values = await storedValues(client, f)
    t.deepEqual(values.map(row => Number(row.value)).sort((a, b) => a - b), [50, 120])
    t.is(await client.chunkValueReplacement.count({where: {pointPrelevementId: f.point.id}}), 1)
  })
})

for (const kind of ['DECLARATION', 'OTHER_PROVIDER', 'INDEX', 'UNKNOWN_CONNECTOR', 'STALE_MODULE', 'UNATTRIBUTED_EXPLOITATION', 'CONTRADICTORY_IDENTITY']) {
  integration(`l’addition Willie conserve les conflits ${kind}`, async t => {
    await rollbackFixture(async (client, f) => {
      const firstInput = input(f, 0, kind === 'INDEX' ? {type: 'index'} : {})
      const first = await ingestAuthorizedConnectorOutput(firstInput, {client})
      const chunk = await client.chunk.findFirstOrThrow({where: {sourceId: first.sourceId}})
      if (kind === 'DECLARATION') await client.source.update({where: {id: first.sourceId}, data: {type: 'DECLARATION'}})
      if (kind === 'OTHER_PROVIDER') {
        await client.chunk.update({where: {id: chunk.id}, data: {
          metadata: {...chunk.metadata, connector: 'other'}, parsingInfo: {...chunk.parsingInfo, connector: 'other'}
        }})
        await client.source.update({where: {id: first.sourceId}, data: {metadata: {connector: 'other'}}})
      }
      if (kind === 'UNKNOWN_CONNECTOR') {
        await client.chunk.update({where: {id: chunk.id}, data: {
          metadata: {connector: 'willie'}, parsingInfo: {connector: 'willie'}
        }})
        await client.source.update({where: {id: first.sourceId}, data: {metadata: {connector: 'willie'}}})
      }
      if (kind === 'STALE_MODULE') await client.declarantPointPrelevementConnector.update({
        where: {id: f.connectors[0].id}, data: {connectorParameters: {sourcePointId: 'renamed-module'}}
      })
      if (kind === 'UNATTRIBUTED_EXPLOITATION') await client.chunk.update({where: {id: chunk.id}, data: {exploitationId: null}})
      if (kind === 'CONTRADICTORY_IDENTITY') await client.source.update({where: {id: first.sourceId}, data: {
        metadata: {connector: 'willie', connectorId: f.connectors[1].id, sourcePointId: 'module-b'}
      }})
      const before = await storedValues(client, f)
      const second = await ingestAuthorizedConnectorOutput(input(f, 1, kind === 'INDEX' ? {type: 'index'} : {}), {client})
      t.false(second.imported)
      t.is(second.reason, 'ALL_METRICS_SKIPPED_BY_CONFLICT')
      t.deepEqual(await storedValues(client, f), before)
    })
  })
}

integration('les publications METER restent protégées même avec deux modules Willie distincts', async t => {
  await rollbackFixture(async (client, f) => {
    const first = await ingestAuthorizedConnectorOutput(input(f), {client})
    await client.chunk.updateMany({where: {sourceId: first.sourceId}, data: {calculationStrategy: 'METER'}})
    const before = await storedValues(client, f)
    const error = await t.throwsAsync(ingestAuthorizedConnectorOutput(input(f, 1), {client}))
    t.is(error.statusCode, 409)
    t.deepEqual(await storedValues(client, f), before)
  })
})

integration('les déclarations sans identité additive voient tous les modules pour leur politique existante', async t => {
  await rollbackFixture(async (client, f) => {
    await ingestAuthorizedConnectorOutput(input(f), {client})
    await ingestAuthorizedConnectorOutput(input(f, 1), {client})
    const conflicts = await findConflictingChunkValuesForIncomingChunkValues({client,
      pointPrelevementId: f.point.id, preleveurUserId: f.owner.id, exploitationId: f.exploitation.id,
      valueRows: [{metricTypeCode: 'volume', periodStart: start, periodEnd: end}]})
    t.is(conflicts.length, 2)
  })
})

integration('le module ne peut pas être utilisé pour un autre propriétaire, une autre exploitation ou un autre point source', async t => {
  await rollbackFixture(async (client, f) => {
    for (const overrides of [{declarantId: randomUUID()}, {exploitationId: randomUUID()}, {sourcePointId: 'foreign-module'}]) {
      const error = await t.throwsAsync(ingestAuthorizedConnectorOutput({...input(f), ...overrides}, {client}))
      t.is(error.statusCode, 403)
    }
    t.is((await storedValues(client, f)).length, 0)
    const error = await t.throwsAsync(ingestServiceAccountConnectorOutputHandler({body: {}}, {}))
    t.is(error.statusCode, 401)
  })
})

integration('deux bénéficiaires au même point conservent leurs contributions séparées', async t => {
  await rollbackFixture(async (client, f) => {
    const other = await client.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT'}}}})
    const exploitation = await client.declarantPointPrelevement.create({data: {
      declarantUserId: other.id, pointPrelevementId: f.point.id, usageId: f.usage.id, status: 'EN_ACTIVITE'
    }})
    const connector = await client.declarantPointPrelevementConnector.create({data: {
      declarantPointPrelevementId: exploitation.id, connectorType: 'willie', rate: 50, connectorParameters: {sourcePointId: 'module-a'}
    }})
    await ingestAuthorizedConnectorOutput(input(f), {client})
    await ingestAuthorizedConnectorOutput({...input(f), declarantId: other.id, exploitationId: exploitation.id, connectorId: connector.id}, {client})
    for (const [user, expected] of [[f.owner, 100], [other, 50]]) {
      const aggregate = await getAuthorizedCumulativeAggregation({client, pointIds: [f.point.id], preleveurId: user.id,
        user: {role: 'ADMIN'}, metricTypeCode: 'volume', aggregationFrequency: '1 day'})
      t.deepEqual(aggregate.values.map(row => Number(row.value)), [expected])
    }
  })
})

integration('deux livraisons concurrentes du même module créent une seule contribution', async t => {
  await committedFixture(async f => {
    const results = await Promise.all([ingestAuthorizedConnectorOutput(input(f)), ingestAuthorizedConnectorOutput(input(f))])
    t.is(results.filter(result => result.imported).length, 1)
    t.is((await storedValues(prisma, f)).length, 1)
  })
})

integration('une erreur après création de source annule toute l’ingestion et ses mises à jour', async t => {
  await committedFixture(async f => {
    const before = await prisma.declarantPointPrelevement.findUnique({where: {id: f.exploitation.id}})
    const sourceCount = await prisma.source.count()
    await t.throwsAsync(ingestAuthorizedConnectorOutput(input(f, 0, {unit: 123})))
    t.is(await prisma.source.count(), sourceCount)
    t.is((await storedValues(prisma, f)).length, 0)
    t.deepEqual(await prisma.declarantPointPrelevement.findUnique({where: {id: f.exploitation.id}}), before)
  })
})

integration('un rattrapage historique conserve la date de disponibilité la plus récente', async t => {
  await rollbackFixture(async (client, f) => {
    const recent = new Date('2026-10-12T00:00:00Z')
    await client.declarantPointPrelevement.update({where: {id: f.exploitation.id}, data: {mostRecentAvailableDate: recent}})
    const before = await client.declarantPointPrelevement.findUnique({where: {id: f.exploitation.id}})
    t.true((await ingestAuthorizedConnectorOutput(input(f), {client})).imported)
    const after = await client.declarantPointPrelevement.findUnique({where: {id: f.exploitation.id}})
    t.deepEqual(after.mostRecentAvailableDate, recent)
    t.deepEqual(after.updatedAt, before.updatedAt)
    t.is((await storedValues(client, f)).length, 1)
  })
})

integration('un lot partiel complète le jour suivant un ancien jour implicite sans décalage ni doublon', async t => {
  await rollbackFixture(async (client, f) => {
    await ingestAuthorizedConnectorOutput(input(f, 0, {
      values: [{date: start.toISOString(), value: 10}]
    }), {client})
    const [original] = await storedValues(client, f)
    const replay = input(f, 0, {conflictPolicy: 'SKIP_CONFLICTING_VALUES', values: [
      {periodStart: start.toISOString(), periodEnd: end.toISOString(), value: 10},
      {periodStart: end.toISOString(), periodEnd: '2026-07-03T00:00:00Z', value: 20}
    ]})
    const completed = await ingestAuthorizedConnectorOutput(replay, {client})
    t.true(completed.imported)
    t.is(completed.skippedValues, 1)
    const values = await storedValues(client, f)
    t.is(values.length, 2)
    t.deepEqual(values.find(row => row.id === original.id), original)
    t.is(values.reduce((sum, row) => sum + Number(row.value), 0), 30)
    const repeated = await ingestAuthorizedConnectorOutput(replay, {client})
    t.false(repeated.imported)
    t.is(repeated.skippedValues, 2)
    t.deepEqual(await storedValues(client, f), values)
  })
})
