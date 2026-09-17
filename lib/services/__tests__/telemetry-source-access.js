import test from 'ava'
import {
  getMeterChunkAccessWhere, getReadableTelemetrySourceWhere, getVisibleTelemetryChunksWhere, scopeMeterSource
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
