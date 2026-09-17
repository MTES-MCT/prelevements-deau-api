import test from 'ava'
import {
  getMeterChunkAccessWhere, getReadableTelemetrySourceWhere, getVisibleTelemetryChunksWhere, hydrateMeterSourcePeriods, scopeMeterSource
} from '../telemetry-source-access.js'

test('les parts compteur sont limitées au bénéficiaire et non à tous les exploitants du PP', t => {
  const user = {id: 'owner', role: 'DECLARANT'}
  t.deepEqual(getMeterChunkAccessWhere({user}), {preleveurUserId: 'owner'})
  const where = getReadableTelemetrySourceWhere(['owner', 'other-owner'], {user})
  t.deepEqual(where.chunks.some.OR[1], {calculationStrategy: 'METER', preleveurUserId: 'owner'})
  t.deepEqual(where.chunks.some.OR[0].pointPrelevement.declarants.some.declarantUserId, {in: ['owner', 'other-owner']})
})

test('le collecteur accède uniquement aux contributions de ses exploitations explicitement liées', t => {
  const user = {id: 'collector', role: 'DECLARANT', declarant: {declarantRole: 'COLLECTEUR'}}
  const where = getMeterChunkAccessWhere({user})
  t.deepEqual(where.OR[0], {preleveurUserId: 'collector'})
  t.deepEqual(where.OR[1].chunkValues.some.meterContributions.some.allocationVersion.allocation.exploitation,
    {collecteurs: {some: {collecteurUserId: 'collector'}}})
})

test('le filtrage des parts instructeur reste territorial et fermé sans périmètre', t => {
  t.deepEqual(getMeterChunkAccessWhere({user: {role: 'INSTRUCTOR'}, pointIds: ['point']}), {pointPrelevementId: {in: ['point']}})
  t.deepEqual(getMeterChunkAccessWhere({user: {role: 'INSTRUCTOR'}}), {pointPrelevementId: {in: []}})
  t.deepEqual(getMeterChunkAccessWhere(), {id: {in: []}})
  t.deepEqual(getMeterChunkAccessWhere({user: {role: 'ADMIN'}}), {})
  t.deepEqual(getVisibleTelemetryChunksWhere({user: {id: 'owner', role: 'DECLARANT'}}).OR[0], {calculationStrategy: {not: 'METER'}})
})

test('une vue partielle ne révèle ni le total physique, ni les autres parts, ni les paramètres du flux', t => {
  const source = {
    metadata: {calculationStrategy: 'METER', totalWaterVolumeWithdrawn: 100, scope: 'secret-scope', meterStreamId: 'internal'},
    meterPublication: {physicalVolume: '200', allocationSnapshot: ['other-owner']},
    _count: {chunks: 3},
    chunks: [{
      id: 'visible', calculationStrategy: 'METER', instructionStatus: 'AUTOMATICALLY_VALIDATED', preleveurUserId: 'owner',
      metadata: {totalWaterVolume: 40, totalWaterVolumeWithdrawn: 40, totalWaterVolumeDischarged: 0, exploitationId: 'internal'},
      pointPrelevement: {id: 'point', declarants: [{declarantUserId: 'owner'}, {declarantUserId: 'other-owner'}]}
    }]
  }
  const visible = scopeMeterSource(source)
  t.deepEqual(visible.metadata, {calculationStrategy: 'METER', totalWaterVolumeWithdrawn: 40, totalWaterVolumeDischarged: 0})
  t.deepEqual(visible._count, {chunks: 1})
  t.false(Object.hasOwn(visible, 'meterPublication'))
  t.deepEqual(visible.chunks[0].pointPrelevement.declarants, [{declarantUserId: 'owner'}])
  t.like(visible, {readOnly: true, canEdit: false, canDelete: false, canInstruct: false, canReconcile: false})
  t.like(visible.chunks[0], {readOnly: true, canEdit: false, canDelete: false, canInstruct: false, canReconcile: false})
  t.is(source.metadata.totalWaterVolumeWithdrawn, 100)
})

test('les totaux utilisent les valeurs visibles, excluent les parts remplacées et préservent le legacy', t => {
  const visible = scopeMeterSource({metadata: {calculationStrategy: 'METER'}, chunks: [
    {calculationStrategy: 'METER', flowType: 'PRELEVEMENT', metadata: {totalWaterVolumeWithdrawn: 999},
      chunkValues: [{metricTypeCode: 'volume', value: '12.5000'}]},
    {calculationStrategy: 'METER', flowType: 'PRELEVEMENT', instructionStatus: 'REJECTED',
      chunkValues: [{metricTypeCode: 'volume', value: '100'}]}
  ]})
  t.is(visible.metadata.totalWaterVolumeWithdrawn, 12.5)
  const legacy = {type: 'API', metadata: {connector: 'unchanged'}, chunks: [{calculationStrategy: 'GENERIC'}]}
  t.is(scopeMeterSource(legacy), legacy)
})

test('les dates exactes de source proviennent uniquement des valeurs METER visibles non rejetées', t => {
  const source = {metadata: {calculationStrategy: 'METER', periodStart: '1900-01-01T00:00:00Z', periodEnd: '2100-01-01T00:00:00Z'}, chunks: [
    {calculationStrategy: 'METER', flowType: 'PRELEVEMENT', minDate: new Date('2026-08-31Z'), maxDate: new Date('2026-08-31Z'),
      metadata: {periodStart: '1900-01-01Z'}, chunkValues: [
        {periodStart: new Date('2026-08-31T21:59:30Z'), periodEnd: new Date('2026-08-31T22:00:30Z'), metricTypeCode: 'volume', value: '0.0001'}
      ]},
    {calculationStrategy: 'METER', instructionStatus: 'REJECTED', chunkValues: [
      {periodStart: new Date('2026-01-01T00:00:00Z'), periodEnd: new Date('2026-12-01T00:00:00Z'), metricTypeCode: 'volume', value: '100'}
    ]}
  ]}
  const result = scopeMeterSource(source)
  t.like(result.metadata, {periodStart: '2026-08-31T21:59:30.000Z', periodEnd: '2026-08-31T22:00:30.000Z'})
  t.like(result.chunks[0].metadata, {periodStart: '2026-08-31T21:59:30.000Z', periodEnd: '2026-08-31T22:00:30.000Z'})
  t.is(result.metadata.totalWaterVolumeWithdrawn, 0.0001)
})

test('une liste agrège seulement les IDs METER déjà autorisés et retire un cache de date sans valeur', async t => {
  let query
  const sources = [{metadata: {calculationStrategy: 'METER'}, chunks: [
    {id: 'visible', calculationStrategy: 'METER', metadata: {periodStart: '1900-01-01Z', periodEnd: '2100-01-01Z'}},
    {id: 'empty', calculationStrategy: 'METER', metadata: {periodStart: '1900-01-01Z', periodEnd: '2100-01-01Z'}},
    {id: 'legacy', calculationStrategy: 'GENERIC', metadata: {readingDate: '2026-09-01'}}
  ]}]
  const client = {chunkValue: {groupBy: async args => {
    query = args
    return [{chunkId: 'visible', _min: {periodStart: new Date('2026-09-01T22:10:15Z')}, _max: {periodEnd: new Date('2026-09-02T22:20:25Z')}}]
  }}}
  const [hydrated] = await hydrateMeterSourcePeriods(sources, {client})
  t.deepEqual(query, {by: ['chunkId'], where: {chunkId: {in: ['visible', 'empty']}}, _min: {periodStart: true}, _max: {periodEnd: true}})
  const result = scopeMeterSource(hydrated)
  t.like(result.metadata, {periodStart: '2026-09-01T22:10:15.000Z', periodEnd: '2026-09-02T22:20:25.000Z'})
  t.false(Object.hasOwn(result.chunks[1].metadata, 'periodStart'))
  t.is(hydrated.chunks[2], sources[0].chunks[2])
  t.is(sources[0].chunks[0].metadata.periodStart, '1900-01-01Z')
})

test('les détails avec valeurs et les listes legacy ne déclenchent aucune agrégation supplémentaire', async t => {
  const sources = [{chunks: [{calculationStrategy: 'METER', chunkValues: []}, {calculationStrategy: 'GENERIC'}]}]
  const result = await hydrateMeterSourcePeriods(sources, {client: {}})
  t.is(result, sources)
  const visible = scopeMeterSource({metadata: {calculationStrategy: 'METER', periodStart: '2026-01-01Z'}, chunks: sources[0].chunks})
  t.false(Object.hasOwn(visible.metadata, 'periodStart'))
})
