import test from 'ava'

import {
  POINT_ASSOCIATION_ORIGINS,
  buildManualChunkPointAssociationParsingInfo,
  canChangeChunkPointAssociation,
  decorateSourcePointAssociations,
  getChunkPointAssociationOrigin,
  isChunkPointAssociationChangeAllowed
} from '../chunk-point-associations.js'

test('getChunkPointAssociationOrigin distingue les associations courantes', t => {
  t.is(getChunkPointAssociationOrigin({pointPrelevementId: null}), null)
  t.is(getChunkPointAssociationOrigin({
    pointPrelevementId: 'point-1',
    parsingInfo: {pointAssociationOrigin: 'MANUAL'}
  }), POINT_ASSOCIATION_ORIGINS.MANUAL)
  t.is(getChunkPointAssociationOrigin({
    pointPrelevementId: 'point-1',
    parsingInfo: {pointAssociationOrigin: 'AUTOMATIC'}
  }), POINT_ASSOCIATION_ORIGINS.AUTOMATIC)
  t.is(getChunkPointAssociationOrigin({
    pointPrelevementId: 'point-1',
    parsingInfo: {reason: 'POINT_FOUND_AND_LINK_ACTIVE_ON_WINDOW'}
  }), POINT_ASSOCIATION_ORIGINS.AUTOMATIC)
})

test('getChunkPointAssociationOrigin reconnaît les rapprochements manuels historiques', t => {
  t.is(getChunkPointAssociationOrigin({
    pointPrelevementId: 'point-1',
    parsingInfo: {reconciledAt: '2026-07-01T10:00:00.000Z'}
  }), POINT_ASSOCIATION_ORIGINS.MANUAL)
  t.is(getChunkPointAssociationOrigin({
    pointPrelevementId: 'point-1',
    parsingInfo: {reason: 'POINT_RECONCILED_BY_INSTRUCTOR'}
  }), POINT_ASSOCIATION_ORIGINS.MANUAL)
})

test('isChunkPointAssociationChangeAllowed verrouille toute modification automatique', t => {
  const automaticChunk = {
    pointPrelevementId: 'point-1',
    parsingInfo: {pointAssociationOrigin: 'AUTOMATIC'}
  }
  const manualChunk = {
    pointPrelevementId: 'point-1',
    parsingInfo: {pointAssociationOrigin: 'MANUAL'}
  }

  t.true(isChunkPointAssociationChangeAllowed(automaticChunk, 'point-1'))
  t.false(isChunkPointAssociationChangeAllowed(automaticChunk, 'point-2'))
  t.false(isChunkPointAssociationChangeAllowed(automaticChunk, null))
  t.true(isChunkPointAssociationChangeAllowed(manualChunk, 'point-2'))
  t.true(isChunkPointAssociationChangeAllowed(manualChunk, null))
  t.true(isChunkPointAssociationChangeAllowed({pointPrelevementId: null}, 'point-1'))
  t.false(canChangeChunkPointAssociation(automaticChunk))
  t.true(canChangeChunkPointAssociation(manualChunk))
})

test('buildManualChunkPointAssociationParsingInfo historise les transitions manuelles', t => {
  const changedAt = new Date('2026-08-10T10:00:00.000Z')
  const attached = buildManualChunkPointAssociationParsingInfo({
    parsingInfo: {case: 4},
    previousPointPrelevementId: null,
    pointPrelevementId: 'point-1',
    changedByUserId: 'user-1',
    changedByRole: 'DECLARANT',
    changedAt,
    details: {exploitationId: 'exploitation-1'}
  })

  t.deepEqual(attached, {
    case: 4,
    exploitationId: 'exploitation-1',
    reason: 'POINT_RECONCILED_BY_DECLARANT',
    changedByUserId: 'user-1',
    changedByRole: 'DECLARANT',
    previousPointPrelevementId: null,
    pointPrelevementId: 'point-1',
    pointAssociationOrigin: 'MANUAL',
    detachedAt: null,
    reconciledAt: '2026-08-10T10:00:00.000Z'
  })

  const detached = buildManualChunkPointAssociationParsingInfo({
    parsingInfo: attached,
    previousPointPrelevementId: 'point-1',
    pointPrelevementId: null,
    changedByUserId: 'user-1',
    changedByRole: 'DECLARANT',
    changedAt
  })

  t.is(detached.reason, 'POINT_DETACHED_BY_DECLARANT')
  t.is(detached.pointAssociationOrigin, null)
  t.is(detached.detachedAt, '2026-08-10T10:00:00.000Z')
  t.is(detached.reconciledAt, null)
})

test('decorateSourcePointAssociations expose une origine calculée sans modifier la source', t => {
  const source = {
    id: 'source-1',
    chunks: [{
      id: 'chunk-1',
      pointPrelevementId: 'point-1',
      parsingInfo: {reconciledAt: '2026-07-01T10:00:00.000Z'}
    }]
  }
  const decorated = decorateSourcePointAssociations(source)

  t.is(decorated.chunks[0].pointAssociationOrigin, 'MANUAL')
  t.is(source.chunks[0].pointAssociationOrigin, undefined)
})
