import test from 'ava'

import {
  buildAuditMutations,
  captureInitialAuditMutation,
  stageAuditMutation
} from '../mutations.js'

const POINT_ID = '11111111-1111-4111-8111-111111111111'
const ZONE_ID = '22222222-2222-4222-8222-222222222222'

function pointUpdateRequest({before, after, body = {}}) {
  return {
    auditAction: {params: {pointId: POINT_ID}},
    auditContext: {
      mutationBefore: before,
      mutationAfter: after
    },
    body,
    params: {}
  }
}

test('buildAuditMutations conserve uniquement le diff métier utile', t => {
  const request = pointUpdateRequest({
    before: {
      id: POINT_ID,
      name: 'Ancien nom',
      locationDescription: 'Ancienne description libre',
      usageName: null,
      updatedAt: new Date('2026-08-10T10:00:00.000Z')
    },
    after: {
      id: POINT_ID,
      name: 'Nouveau nom',
      locationDescription: 'Nouvelle description libre',
      usageName: null,
      updatedAt: new Date('2026-08-10T11:00:00.000Z')
    },
    body: {
      name: 'Nouveau nom',
      comment: 'Cette valeur ne doit jamais être conservée.',
      locationDescription: 'Nouvelle description libre'
    }
  })

  const [mutation] = buildAuditMutations(request, {type: 'POINT.UPDATED'})

  t.is(mutation.entityType, 'POINT')
  t.is(mutation.entityId, POINT_ID)
  t.deepEqual(mutation.changedFields, ['name'])
  t.deepEqual(mutation.before, {name: 'Ancien nom'})
  t.deepEqual(mutation.after, {name: 'Nouveau nom'})
  t.deepEqual(mutation.redactedFields, ['comment', 'locationDescription'])
  t.false(JSON.stringify(mutation).includes('Cette valeur'))
  t.deepEqual(mutation.scopes, [{
    resourceType: 'POINT',
    resourceId: POINT_ID,
    resourceLabel: 'Nouveau nom'
  }])
})

test('buildAuditMutations ignore une mise à jour sans différence', t => {
  const point = {id: POINT_ID, name: 'Même nom', flowType: 'WITHDRAWAL'}
  const request = pointUpdateRequest({before: point, after: {...point}})

  t.deepEqual(buildAuditMutations(request, {type: 'POINT.UPDATED'}), [])
})

test('buildAuditMutations n’invente pas un diff si un snapshot manque', t => {
  const request = pointUpdateRequest({
    before: {id: POINT_ID, name: 'Nom existant'},
    after: null,
    body: {name: 'Nom demandé'}
  })

  t.deepEqual(buildAuditMutations(request, {type: 'POINT.UPDATED'}), [])
})

test('buildAuditMutations historise une création et ses rattachements', t => {
  const request = {
    auditAction: {params: {zoneId: ZONE_ID}},
    auditContext: {metadata: {}},
    auditEventId: '33333333-3333-4333-8333-333333333333',
    body: {},
    params: {}
  }

  stageAuditMutation(request, {
    operation: 'CREATE',
    entityType: 'POINT',
    entityId: POINT_ID,
    entityLabel: 'Forage principal',
    after: {
      id: POINT_ID,
      name: 'Forage principal',
      flowType: 'WITHDRAWAL'
    }
  })

  const [mutation] = buildAuditMutations(request, {type: 'POINT.CREATED_IN_ZONE'})

  t.is(mutation.operation, 'CREATE')
  t.is(mutation.before, null)
  t.deepEqual(mutation.after, {
    name: 'Forage principal',
    flowType: 'WITHDRAWAL'
  })
  t.deepEqual(mutation.changedFields, ['flowType', 'name'])
  t.true(mutation.scopes.some(item => item.resourceType === 'ZONE' && item.resourceId === ZONE_ID))
})

test('captureInitialAuditMutation utilise les paramètres reconnus avant le routeur Express', async t => {
  let receivedId
  const request = {
    auditAction: {params: {pointId: POINT_ID}},
    auditContext: {metadata: {}},
    body: {},
    params: {}
  }
  const client = {
    pointPrelevement: {
      async findUnique({where}) {
        receivedId = where.id
        return {id: where.id, name: 'Point existant'}
      }
    }
  }

  await captureInitialAuditMutation(request, {type: 'POINT.UPDATED'}, client)

  t.is(receivedId, POINT_ID)
  t.is(request.auditContext.mutationBefore.name, 'Point existant')
})
