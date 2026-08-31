import test from 'ava'

import {
  buildAuditMutations,
  captureInitialAuditMutation,
  stageAuditMutation
} from '../mutations.js'

const POINT_ID = '11111111-1111-4111-8111-111111111111'
const ZONE_ID = '22222222-2222-4222-8222-222222222222'
const EXPLOITATION_ID = '33333333-3333-4333-8333-333333333333'

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

test('buildAuditMutations historise les champs modifiables de Mon compte', t => {
  const userId = '99999999-9999-4999-8999-999999999999'
  const request = {
    auditAction: {params: {}},
    auditContext: {metadata: {}},
    auditEventId: '88888888-8888-4888-8888-888888888888',
    body: {firstName: 'Camille', jobTitle: 'Hydrologue'},
    params: {}
  }

  stageAuditMutation(request, {
    operation: 'UPDATE',
    entityType: 'USER_PROFILE',
    entityId: userId,
    before: {
      id: userId,
      firstName: 'Camille',
      instructor: {jobTitle: 'Chargée d’études'}
    },
    after: {
      id: userId,
      firstName: 'Camille',
      instructor: {jobTitle: 'Hydrologue'}
    }
  })

  const [mutation] = buildAuditMutations(request, {type: 'ACCOUNT.PROFILE_UPDATED'})

  t.is(mutation.entityType, 'USER_PROFILE')
  t.deepEqual(mutation.changedFields, ['jobTitle'])
  t.deepEqual(mutation.before, {jobTitle: 'Chargée d’études'})
  t.deepEqual(mutation.after, {jobTitle: 'Hydrologue'})
})

test('buildAuditMutations historise les usages secondaires d’une exploitation', t => {
  const industry = {id: 'usage-4', code: '4', label: 'Industrie'}
  const energy = {id: 'usage-6', code: '6', label: 'Énergie'}
  const request = {
    auditAction: {params: {exploitationId: EXPLOITATION_ID}},
    auditContext: {
      mutationBefore: {
        id: EXPLOITATION_ID,
        usageId: industry.id,
        usage: industry,
        secondaryUsageLinks: []
      },
      mutationAfter: {
        id: EXPLOITATION_ID,
        usageId: industry.id,
        usage: industry,
        secondaryUsageLinks: [{usageId: energy.id, usage: energy}]
      }
    },
    body: {secondaryUsageIds: [energy.id]},
    params: {}
  }

  const [mutation] = buildAuditMutations(request, {type: 'EXPLOITATION.UPDATED'})

  t.deepEqual(mutation.changedFields, ['secondaryUsages'])
  t.deepEqual(mutation.before, {secondaryUsages: []})
  t.deepEqual(mutation.after, {secondaryUsages: [energy]})
})

test('buildAuditMutations décrit un changement de principal sans dupliquer usageId', t => {
  const industry = {id: 'usage-4', code: '4', label: 'Industrie'}
  const energy = {id: 'usage-6', code: '6', label: 'Énergie'}
  const request = {
    auditAction: {params: {exploitationId: EXPLOITATION_ID}},
    auditContext: {
      mutationBefore: {
        id: EXPLOITATION_ID,
        usageId: industry.id,
        usage: industry,
        secondaryUsageLinks: []
      },
      mutationAfter: {
        id: EXPLOITATION_ID,
        usageId: energy.id,
        usage: energy,
        secondaryUsageLinks: []
      }
    },
    body: {usageId: energy.id},
    params: {}
  }

  const [mutation] = buildAuditMutations(request, {type: 'EXPLOITATION.UPDATED'})

  t.deepEqual(mutation.changedFields, ['usage'])
  t.deepEqual(mutation.before, {usage: industry})
  t.deepEqual(mutation.after, {usage: energy})
})

test('buildAuditMutations historise les rattachements N-N d’un document', t => {
  const documentId = '44444444-4444-4444-8444-444444444444'
  const otherExploitationId = '55555555-5555-4555-8555-555555555555'
  const request = {
    auditAction: {params: {documentId}},
    auditContext: {
      mutationBefore: {
        id: documentId,
        declarantPointPrelevementId: EXPLOITATION_ID,
        exploitations: [{declarantPointPrelevementId: EXPLOITATION_ID}]
      },
      mutationAfter: {
        id: documentId,
        declarantPointPrelevementId: EXPLOITATION_ID,
        exploitations: [
          {declarantPointPrelevementId: EXPLOITATION_ID},
          {declarantPointPrelevementId: otherExploitationId}
        ]
      }
    },
    body: {declarantPointPrelevementIds: [EXPLOITATION_ID, otherExploitationId]},
    params: {}
  }

  const [mutation] = buildAuditMutations(request, {type: 'DOCUMENT.UPDATED'})

  t.deepEqual(mutation.changedFields, ['declarantPointPrelevementIds'])
  t.deepEqual(mutation.before, {
    declarantPointPrelevementIds: [EXPLOITATION_ID]
  })
  t.deepEqual(mutation.after, {
    declarantPointPrelevementIds: [EXPLOITATION_ID, otherExploitationId].sort()
  })
  t.true(mutation.scopes.some(scope =>
    scope.resourceType === 'EXPLOITATION' && scope.resourceId === otherExploitationId))
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
