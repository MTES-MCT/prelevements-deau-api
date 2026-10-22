/* eslint-disable no-await-in-loop -- Isolated synthetic connector fixtures and ordered deliveries. */
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {ingestAuthorizedConnectorOutput, ingestServiceAccountConnectorOutputHandler} from '../service-account-connectors.js'
import {getAuthorizedCumulativeAggregation} from '../series-aggregation.js'
import {findConflictingChunkValuesForIncomingChunkValues} from '../../services/chunk-value-conflicts.js'
import {reconstructVolumesFromIndexInTransaction, reconstructVolumesFromIndexForPoint} from '../../services/volumes-from-index.js'
import {getServiceAccountConnectorCursors} from '../../services/connector-cursors.js'

const integration = process.env.METER_INTEGRATION_TESTS === '1' ? test.serial : test.skip
const start = new Date('2026-07-01T00:00:00Z')
const end = new Date('2026-07-02T00:00:00Z')
test.before(() => { if (process.env.METER_INTEGRATION_TESTS === '1') requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

async function fixture(client, connectorType = 'willie') {
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
      declarantPointPrelevementId: exploitation.id, connectorType, rate, connectorParameters: {sourcePointId}
    }}))
  }
  return {owner, point, usage, exploitation, connectors}
}

async function rollbackFixture(operation, connectorType) {
  const rollback = new Error('ROLLBACK_CONNECTOR_FIXTURE')
  try {
    await prisma.$transaction(async client => {
      await operation(client, await fixture(client, connectorType))
      throw rollback
    }, {timeout: 60000})
  } catch (error) {
    if (error !== rollback) throw error
  }
}

async function committedFixture(operation, connectorType) {
  const f = await fixture(prisma, connectorType)
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

function orangeInput(f, index = 0, entries = [[1, 100], [2, 110], [3, 120]]) {
  const request = input(f, index, {type: 'index', granularity: '15 minutes', conflictPolicy: 'REPLACE_EXISTING',
    values: entries.map(([day, value]) => ({date: `2026-07-${String(day).padStart(2, '0')}T00:00:00Z`, value}))})
  return {...request, connector: 'orange_live_objects'}
}

integration('Orange conserve chaque index et somme seulement les deltas propres à chaque capteur, y compris au rejeu', async t => {
  await rollbackFixture(async (client, f) => {
    const first = await ingestAuthorizedConnectorOutput(orangeInput(f), {client})
    await ingestAuthorizedConnectorOutput(orangeInput(f, 1, [[1, 1000], [2, 1060], [3, 1120]]), {client})
    await reconstructVolumesFromIndexInTransaction(client, f.point.id)
    const initial = await storedValues(client, f)
    t.is(initial.filter(row => row.metricTypeCode === 'index').length, 6)
    t.deepEqual(initial.filter(row => row.metricTypeCode === 'volume').map(row => Number(row.value)).sort((a, b) => a - b), [10, 10, 30, 30])
    const aggregate = await getAuthorizedCumulativeAggregation({client, pointIds: [f.point.id],
      preleveurId: f.owner.id, user: {role: 'ADMIN'}, metricTypeCode: 'volume', aggregationFrequency: '1 month'})
    t.deepEqual(aggregate.values.map(row => row.value), [80])
    await ingestAuthorizedConnectorOutput(orangeInput(f), {client})
    await reconstructVolumesFromIndexInTransaction(client, f.point.id)
    const replayed = await storedValues(client, f)
    t.is(replayed.filter(row => row.metricTypeCode === 'index').length, 6)
    t.deepEqual(replayed.filter(row => row.metricTypeCode === 'volume').map(row => Number(row.value)).sort((a, b) => a - b), [10, 10, 30, 30])
    const replaced = await client.chunk.findFirstOrThrow({where: {sourceId: first.sourceId}})
    t.is(replaced.instructionStatus, 'REJECTED')
    t.is(replaced.metadata.totalWaterVolume, 0)
    t.is(await client.chunkValue.count({where: {chunkId: replaced.id}}), 0)
  }, 'orange_live_objects')
})

integration('Orange ne relie pas les index de capteurs dont les instants sont décalés', async t => {
  await rollbackFixture(async (client, f) => {
    await ingestAuthorizedConnectorOutput(orangeInput(f, 0, [[1, 100], [2, 110]]), {client})
    const second = orangeInput(f, 1, [[1, 1000], [2, 1060]])
    second.data.metrics[0].values = second.data.metrics[0].values.map(value => ({...value, date: value.date.replace('00:00:00', '12:00:00')}))
    await ingestAuthorizedConnectorOutput(second, {client})
    await reconstructVolumesFromIndexInTransaction(client, f.point.id)
    const volumes = (await storedValues(client, f)).filter(row => row.metricTypeCode === 'volume')
    t.deepEqual(volumes.map(row => Number(row.value)).sort((a, b) => a - b), [10, 30])
    t.true(volumes.every(row => row.periodEnd - row.periodStart === 86_400_000))
  }, 'orange_live_objects')
})

for (const kind of ['DECLARATION', 'UNKNOWN_CONNECTOR', 'STALE_STREAM', 'CONTRADICTORY_IDENTITY', 'DUPLICATE_STREAM', 'METER']) {
  integration(`Orange conserve les conflits et protections ${kind}`, async t => {
    await rollbackFixture(async (client, f) => {
      const first = await ingestAuthorizedConnectorOutput(orangeInput(f), {client})
      const chunk = await client.chunk.findFirstOrThrow({where: {sourceId: first.sourceId}})
      if (kind === 'DECLARATION') await client.source.update({where: {id: first.sourceId}, data: {type: 'DECLARATION'}})
      if (kind === 'UNKNOWN_CONNECTOR') {
        await client.chunk.update({where: {id: chunk.id}, data: {metadata: {connector: 'orange_live_objects'}, parsingInfo: {connector: 'orange_live_objects'}}})
        await client.source.update({where: {id: first.sourceId}, data: {metadata: {connector: 'orange_live_objects'}}})
      }
      if (kind === 'STALE_STREAM') await client.declarantPointPrelevementConnector.update({where: {id: f.connectors[0].id}, data: {connectorParameters: {sourcePointId: 'changed-stream'}}})
      if (kind === 'CONTRADICTORY_IDENTITY') await client.source.update({where: {id: first.sourceId}, data: {metadata: {connector: 'orange_live_objects', connectorId: f.connectors[1].id, sourcePointId: 'module-b'}}})
      if (kind === 'DUPLICATE_STREAM') await client.declarantPointPrelevementConnector.update({where: {id: f.connectors[1].id}, data: {connectorParameters: {sourcePointId: 'module-a'}}})
      if (kind === 'METER') await client.chunk.update({where: {id: chunk.id}, data: {calculationStrategy: 'METER'}})
      const second = orangeInput(f, 1)
      if (kind === 'DUPLICATE_STREAM') second.sourcePointId = 'module-a'
      second.data.metrics[0].conflictPolicy = 'SKIP_NEW_CHUNK'
      const before = await storedValues(client, f)
      if (kind === 'METER') t.is((await t.throwsAsync(ingestAuthorizedConnectorOutput(second, {client}))).statusCode, 409)
      else t.false((await ingestAuthorizedConnectorOutput(second, {client})).imported)
      t.deepEqual(await storedValues(client, f), before)
    }, 'orange_live_objects')
  })
}

integration('les curseurs Orange suivent les index déclarés du seul capteur, y compris l’historique identifié sans exploitation', async t => {
  await rollbackFixture(async (client, f) => {
    const first = await ingestAuthorizedConnectorOutput(orangeInput(f, 0, [[1, 100], [2, 110]]), {client})
    const second = await ingestAuthorizedConnectorOutput(orangeInput(f, 1, [[1, 1000], [3, 1060]]), {client})
    await client.chunk.updateMany({where: {sourceId: second.sourceId}, data: {exploitationId: null}})
    const chunk = await client.chunk.findFirstOrThrow({where: {sourceId: first.sourceId}})
    await client.chunkValue.updateMany({where: {chunkId: chunk.id, valueKind: 'DECLARED'}, data: {metricTypeCode: 'relevé d\'index'}})
    await client.chunkValue.create({data: {chunkId: chunk.id, metricTypeCode: 'index', valueKind: 'COMPUTED', value: 500,
      frequency: '15 minutes', periodStart: new Date('2026-12-01Z'), periodEnd: new Date('2026-12-01T00:15:00Z')}})
    let cursors = await getServiceAccountConnectorCursors(f.connectors, {client})
    t.is(cursors.get(f.connectors[0].id).toISOString(), '2026-07-02T00:15:00.000Z')
    t.is(cursors.get(f.connectors[1].id).toISOString(), '2026-07-03T00:15:00.000Z')
    t.is(cursors.get(f.connectors[2].id), null)
    await client.chunk.updateMany({where: {sourceId: second.sourceId}, data: {instructionStatus: 'REJECTED'}})
    cursors = await getServiceAccountConnectorCursors(f.connectors, {client})
    t.is(cursors.get(f.connectors[1].id), null)
    await client.source.update({where: {id: first.sourceId}, data: {metadata: {connector: 'orange_live_objects', connectorId: f.connectors[1].id, sourcePointId: 'module-b'}}})
    t.is((await getServiceAccountConnectorCursors(f.connectors, {client})).get(f.connectors[0].id), null)
  }, 'orange_live_objects')
})

integration('la reconstruction supprime les anciens volumes orphelins automatiques et préserve METER et la publication manuelle', async t => {
  await rollbackFixture(async (client, f) => {
    const chunks = []
    for (const [calculationStrategy, autoCalculateVolumes] of [['GENERIC', true], ['GENERIC', false], ['METER', true]]) {
      const source = await client.source.create({data: {type: 'API', status: 'COMPLETED'}})
      chunks.push(await client.chunk.create({data: {sourceId: source.id, pointPrelevementId: f.point.id,
        preleveurUserId: f.owner.id, exploitationId: f.exploitation.id, usageId: f.usage.id,
        calculationStrategy, autoCalculateVolumes, instructionStatus: 'VALIDATED', minDate: start, maxDate: end,
        chunkValues: {create: {metricTypeCode: 'volume', valueKind: 'COMPUTED', value: 12345,
          unit: 'm3', frequency: '1 day', periodStart: start, periodEnd: end}}
      }}))
    }
    await reconstructVolumesFromIndexInTransaction(client, f.point.id)
    t.is(await client.chunkValue.count({where: {chunkId: chunks[0].id}}), 0)
    t.is((await client.chunk.findUniqueOrThrow({where: {id: chunks[0].id}})).metadata.totalWaterVolume, 0)
    t.is(await client.chunkValue.count({where: {chunkId: {in: chunks.slice(1).map(chunk => chunk.id)}}}), 2)
    await reconstructVolumesFromIndexInTransaction(client, f.point.id)
    t.is(await client.chunkValue.count({where: {chunkId: {in: chunks.map(chunk => chunk.id)}}}), 2)
  })
})

integration('les livraisons Orange concurrentes ne doublent pas les index ni les volumes actifs', async t => {
  await committedFixture(async f => {
    await Promise.all([ingestAuthorizedConnectorOutput(orangeInput(f)), ingestAuthorizedConnectorOutput(orangeInput(f))])
    await reconstructVolumesFromIndexForPoint(f.point.id)
    const values = await storedValues(prisma, f)
    t.is(values.filter(row => row.metricTypeCode === 'index').length, 3)
    t.is(values.filter(row => row.metricTypeCode === 'volume').length, 2)
    t.is(values.filter(row => row.metricTypeCode === 'volume').reduce((sum, row) => sum + Number(row.value), 0), 20)
  }, 'orange_live_objects')
})

integration('la suppression de configuration Orange ne modifie pas les deltas de son historique déjà identifié', async t => {
  await rollbackFixture(async (client, f) => {
    await ingestAuthorizedConnectorOutput(orangeInput(f, 0, [[1, 100]]), {client})
    await ingestAuthorizedConnectorOutput(orangeInput(f, 0, [[2, 110]]), {client})
    await client.declarantPointPrelevementConnector.delete({where: {id: f.connectors[0].id}})
    await reconstructVolumesFromIndexInTransaction(client, f.point.id)
    const volumes = (await storedValues(client, f)).filter(row => row.metricTypeCode === 'volume')
    t.deepEqual(volumes.map(row => Number(row.value)), [10])
  }, 'orange_live_objects')
})
