import test from 'ava'

import {
  listDashboardPoints
} from '../dashboard.js'
import {getDashboardPointActorsHandler} from '../dashboard-point-actors.js'
import {
  getDashboardMapCapabilities,
  getDashboardMapPointScope
} from '../../services/dashboard-map-access.js'
import {
  canReadDashboardPointActors,
  getDashboardPointActors
} from '../../services/dashboard-point-actors.js'

const POINT_ID = '11111111-1111-4111-8111-111111111111'
const INSTRUCTOR_ID = '22222222-2222-4222-8222-222222222222'
const PRELEVEUR_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_PRELEVEUR_ID = '44444444-4444-4444-8444-444444444444'
const COLLECTEUR_ID = '55555555-5555-4555-8555-555555555555'
const OTHER_COLLECTEUR_ID = '66666666-6666-4666-8666-666666666666'
const NOW = new Date('2026-09-01T08:00:00.000Z')
const ACTOR_PERMISSIONS = [
  'zone.dashboard.read',
  'exploitation.list',
  'declarant.list'
]

function createInstructorPoint(permissionGroups) {
  return {
    id: POINT_ID,
    deletedAt: null,
    zones: permissionGroups.map(permissions => ({
      zone: {
        instructorZones: [{
          permissions: permissions.map(permission => ({permission}))
        }]
      }
    }))
  }
}

function createActor(userId, {firstName = null, lastName = null, socialReason = null} = {}) {
  return {
    userId,
    socialReason,
    user: {id: userId, firstName, lastName}
  }
}

test('le scope cartographique distingue préleveur et collecteur', t => {
  t.deepEqual(getDashboardMapPointScope({
    id: COLLECTEUR_ID,
    role: 'DECLARANT',
    declarant: {declarantRole: 'COLLECTEUR'}
  }), {
    collecteurUserId: COLLECTEUR_ID,
    declarantUserIds: null
  })
  t.deepEqual(getDashboardMapPointScope({
    id: PRELEVEUR_ID,
    role: 'DECLARANT',
    declarant: {declarantRole: 'PRELEVEUR'}
  }), {
    collecteurUserId: null,
    declarantUserIds: [PRELEVEUR_ID]
  })
  t.deepEqual(getDashboardMapPointScope({id: INSTRUCTOR_ID, role: 'INSTRUCTOR'}), {
    collecteurUserId: null,
    declarantUserIds: null
  })
})

test('la carte collecteur filtre les points et exploitations sur le lien direct sans N+1', async t => {
  let pointQuery
  let coordinateIds
  let pointQueries = 0
  let coordinateQueries = 0
  const coordinates = {type: 'Point', coordinates: [2.3, 48.8]}
  const client = {
    pointPrelevement: {
      async findMany(query) {
        pointQueries++
        pointQuery = query

        return [{
          id: POINT_ID,
          name: 'Forage direct',
          usageName: null,
          flowType: 'PRELEVEMENT',
          nature: 'NAPPE',
          withdrawalType: 'SOUTERRAIN',
          declarants: []
        }]
      }
    }
  }

  const points = await listDashboardPoints(['zone-1'], {
    client,
    collecteurUserId: COLLECTEUR_ID,
    async getCoordinatesByPointIds(ids) {
      coordinateQueries++
      coordinateIds = ids
      return new Map([[POINT_ID, coordinates]])
    }
  })

  t.deepEqual(pointQuery.where, {
    deletedAt: null,
    declarants: {
      some: {
        collecteurs: {
          some: {collecteurUserId: COLLECTEUR_ID}
        }
      }
    },
    zones: {
      some: {
        zoneId: {in: ['zone-1']}
      }
    }
  })
  t.deepEqual(pointQuery.select.declarants.where, {
    collecteurs: {
      some: {collecteurUserId: COLLECTEUR_ID}
    },
    declarant: {
      declarantRole: 'PRELEVEUR',
      user: {deletedAt: null}
    }
  })
  t.true(pointQuery.select.flowType)
  t.true(pointQuery.select.nature)
  t.true(pointQuery.select.withdrawalType)
  t.deepEqual(coordinateIds, [POINT_ID])
  t.is(pointQueries, 1)
  t.is(coordinateQueries, 1)
  t.deepEqual(points, [{
    id: POINT_ID,
    name: 'Forage direct',
    usageName: null,
    flowType: 'PRELEVEMENT',
    nature: 'NAPPE',
    withdrawalType: 'SOUTERRAIN',
    coordinates,
    usages: []
  }])
})

test('les capabilities instructeur sont conservatrices sur des zones mixtes', t => {
  const user = {id: INSTRUCTOR_ID, role: 'INSTRUCTOR'}

  t.deepEqual(getDashboardMapCapabilities(user, [{
    permissions: [
      'zone.dashboard.read',
      'exploitation.list',
      'declarant.list',
      'pp.detail.read'
    ]
  }]), {
    readPointActors: true,
    readPointDetails: true
  })
  t.deepEqual(getDashboardMapCapabilities(user, [
    {
      permissions: [
        'zone.dashboard.read',
        'exploitation.list',
        'declarant.list',
        'pp.detail.read'
      ]
    },
    {permissions: ['exploitation.list']}
  ]), {
    readPointActors: false,
    readPointDetails: false
  })
  t.deepEqual(getDashboardMapCapabilities(user, [{
    permissions: ['exploitation.list', 'declarant.list', 'pp.detail.read']
  }]), {
    readPointActors: false,
    readPointDetails: false
  })
  t.deepEqual(getDashboardMapCapabilities(user), {
    readPointActors: false,
    readPointDetails: false
  })
  t.deepEqual(getDashboardMapCapabilities({role: 'ADMIN'}), {
    readPointActors: true,
    readPointDetails: true
  })
  t.deepEqual(getDashboardMapCapabilities({role: 'DECLARANT'}), {
    readPointActors: true,
    readPointDetails: true
  })
})

test('les trois droits instructeur doivent être portés par une même zone du point', t => {
  const user = {id: INSTRUCTOR_ID, role: 'INSTRUCTOR'}

  t.true(canReadDashboardPointActors(createInstructorPoint([ACTOR_PERMISSIONS]), user))
  t.false(canReadDashboardPointActors(createInstructorPoint([
    ['zone.dashboard.read', 'exploitation.list'],
    ['declarant.list']
  ]), user))

  for (const missingPermission of ACTOR_PERMISSIONS) {
    t.false(canReadDashboardPointActors(createInstructorPoint([
      ACTOR_PERMISSIONS.filter(permission => permission !== missingPermission)
    ]), user))
  }
})

test('un instructeur autorisé reçoit les acteurs via deux projections minimales', async t => {
  let accessQuery
  let actorQuery
  const client = {
    pointPrelevement: {
      async findUnique(query) {
        accessQuery = query
        return createInstructorPoint([ACTOR_PERMISSIONS])
      }
    },
    declarantPointPrelevement: {
      async findMany(query) {
        actorQuery = query
        return [{
          declarant: createActor(PRELEVEUR_ID, {socialReason: 'EARL des Prés'}),
          collecteurs: [{
            collecteur: createActor(COLLECTEUR_ID, {socialReason: 'Syndicat des eaux'})
          }]
        }]
      }
    }
  }

  const result = await getDashboardPointActors(
    POINT_ID,
    {id: INSTRUCTOR_ID, role: 'INSTRUCTOR'},
    {client, now: NOW}
  )

  t.deepEqual(accessQuery.where, {id: POINT_ID})
  t.deepEqual(
    accessQuery.select.zones.select.zone.select.instructorZones.where,
    {
      instructorUserId: INSTRUCTOR_ID,
      AND: [
        {startDate: {lte: NOW}},
        {OR: [{endDate: null}, {endDate: {gte: NOW}}]}
      ]
    }
  )
  t.deepEqual(actorQuery.where, {
    pointPrelevementId: POINT_ID,
    declarant: {
      declarantRole: 'PRELEVEUR',
      user: {deletedAt: null}
    }
  })
  t.deepEqual(actorQuery.select.collecteurs.where, {
    collecteur: {
      declarantRole: 'COLLECTEUR',
      user: {deletedAt: null}
    }
  })
  t.deepEqual(result, {
    pointId: POINT_ID,
    preleveurs: [{id: PRELEVEUR_ID, label: 'EARL des Prés'}],
    collecteurs: [{id: COLLECTEUR_ID, label: 'Syndicat des eaux'}]
  })

  const projections = JSON.stringify({access: accessQuery.select, actors: actorQuery.select})
  for (const forbiddenField of [
    'email',
    'contactEmails',
    'documents',
    'connectors',
    'siret',
    'pointPrelevement'
  ]) {
    t.false(projections.includes(forbiddenField))
  }
})

test('un instructeur aux droits répartis entre zones est refusé avant la requête acteurs', async t => {
  let actorQueries = 0
  const client = {
    pointPrelevement: {
      async findUnique() {
        return createInstructorPoint([
          ['zone.dashboard.read', 'exploitation.list'],
          ['declarant.list']
        ])
      }
    },
    declarantPointPrelevement: {
      async findMany() {
        actorQueries++
        return []
      }
    }
  }

  const error = await t.throwsAsync(() => getDashboardPointActors(
    POINT_ID,
    {id: INSTRUCTOR_ID, role: 'INSTRUCTOR'},
    {client, now: NOW}
  ))

  t.is(error.statusCode, 403)
  t.is(actorQueries, 0)
})

test('un collecteur ne reçoit que les préleveurs liés directement au point', async t => {
  let accessQuery
  let actorQuery
  const user = {
    id: COLLECTEUR_ID,
    role: 'DECLARANT',
    declarant: {declarantRole: 'COLLECTEUR'}
  }
  const client = {
    pointPrelevement: {
      async findUnique(query) {
        accessQuery = query
        return {
          id: POINT_ID,
          deletedAt: null,
          declarants: [{
            declarantUserId: PRELEVEUR_ID,
            collecteurs: [{collecteurUserId: COLLECTEUR_ID}]
          }]
        }
      }
    },
    declarantPointPrelevement: {
      async findMany(query) {
        actorQuery = query
        return [{
          declarant: createActor(PRELEVEUR_ID, {socialReason: 'EARL directe'})
        }]
      }
    }
  }

  const result = await getDashboardPointActors(POINT_ID, user, {client})

  t.deepEqual(accessQuery.select.declarants, {
    where: {
      collecteurs: {
        some: {collecteurUserId: COLLECTEUR_ID}
      }
    },
    select: {
      collecteurs: {
        where: {collecteurUserId: COLLECTEUR_ID},
        select: {collecteurUserId: true}
      }
    }
  })
  t.deepEqual(actorQuery.where, {
    pointPrelevementId: POINT_ID,
    declarant: {
      declarantRole: 'PRELEVEUR',
      user: {deletedAt: null}
    },
    collecteurs: {
      some: {collecteurUserId: COLLECTEUR_ID}
    }
  })
  t.false(Object.hasOwn(actorQuery.select, 'collecteurs'))
  t.deepEqual(result, {
    pointId: POINT_ID,
    preleveurs: [{id: PRELEVEUR_ID, label: 'EARL directe'}],
    collecteurs: []
  })
})

test('un lien du collecteur avec le même préleveur sur un autre point ne donne aucun accès', async t => {
  let actorQueries = 0
  const client = {
    pointPrelevement: {
      async findUnique() {
        return {
          id: POINT_ID,
          deletedAt: null,
          declarants: [{
            declarantUserId: PRELEVEUR_ID,
            collecteurs: [{collecteurUserId: OTHER_COLLECTEUR_ID}]
          }]
        }
      }
    },
    declarantPointPrelevement: {
      async findMany() {
        actorQueries++
        return []
      }
    }
  }
  const user = {
    id: COLLECTEUR_ID,
    role: 'DECLARANT',
    declarant: {declarantRole: 'COLLECTEUR'}
  }

  const error = await t.throwsAsync(() => getDashboardPointActors(POINT_ID, user, {client}))

  t.is(error.statusCode, 403)
  t.is(actorQueries, 0)
})

test('un rôle non pris en charge est refusé avant la requête acteurs', async t => {
  let actorQueries = 0
  const client = {
    pointPrelevement: {
      async findUnique() {
        return {id: POINT_ID, deletedAt: null}
      }
    },
    declarantPointPrelevement: {
      async findMany() {
        actorQueries++
        return []
      }
    }
  }

  const error = await t.throwsAsync(() => getDashboardPointActors(
    POINT_ID,
    {id: INSTRUCTOR_ID, role: 'SERVICE_ACCOUNT'},
    {client}
  ))

  t.is(error.statusCode, 403)
  t.is(actorQueries, 0)
})

test('un préleveur ne reçoit que sa propre identité et aucun collecteur', async t => {
  let accessQuery
  let actorQuery
  const user = {
    id: PRELEVEUR_ID,
    role: 'DECLARANT',
    declarant: {declarantRole: 'PRELEVEUR'}
  }
  const client = {
    pointPrelevement: {
      async findUnique(query) {
        accessQuery = query
        return {
          id: POINT_ID,
          deletedAt: null,
          declarants: [
            {declarantUserId: PRELEVEUR_ID, collecteurs: []},
            {declarantUserId: OTHER_PRELEVEUR_ID, collecteurs: []}
          ]
        }
      }
    },
    declarantPointPrelevement: {
      async findMany(query) {
        actorQuery = query
        return [{
          declarant: createActor(PRELEVEUR_ID, {firstName: 'Jean', lastName: 'Martin'})
        }]
      }
    }
  }

  const result = await getDashboardPointActors(POINT_ID, user, {client})

  t.deepEqual(accessQuery.select.declarants, {
    where: {declarantUserId: PRELEVEUR_ID},
    select: {declarantUserId: true}
  })
  t.deepEqual(actorQuery.where, {
    pointPrelevementId: POINT_ID,
    declarant: {
      declarantRole: 'PRELEVEUR',
      user: {deletedAt: null}
    },
    declarantUserId: PRELEVEUR_ID
  })
  t.false(Object.hasOwn(actorQuery.select, 'collecteurs'))
  t.deepEqual(result, {
    pointId: POINT_ID,
    preleveurs: [{id: PRELEVEUR_ID, label: 'Jean Martin'}],
    collecteurs: []
  })
})

test('un admin reçoit les acteurs dédupliqués, triés et sans utilisateur supprimé', async t => {
  let actorQuery
  const client = {
    pointPrelevement: {
      async findUnique() {
        return {id: POINT_ID, deletedAt: null}
      }
    },
    declarantPointPrelevement: {
      async findMany(query) {
        actorQuery = query
        return [
          {
            declarant: createActor(OTHER_PRELEVEUR_ID, {socialReason: 'Zeta'}),
            collecteurs: [{
              collecteur: createActor(COLLECTEUR_ID, {firstName: 'Alain', lastName: 'Durand'})
            }]
          },
          {
            declarant: createActor(PRELEVEUR_ID),
            collecteurs: [{
              collecteur: createActor(COLLECTEUR_ID, {socialReason: 'Doublon ignoré'})
            }]
          },
          {
            declarant: createActor(OTHER_PRELEVEUR_ID, {socialReason: 'Doublon ignoré'}),
            collecteurs: []
          }
        ]
      }
    }
  }

  const result = await getDashboardPointActors(POINT_ID, {role: 'ADMIN'}, {client})

  t.deepEqual(actorQuery.select.collecteurs.where, {
    collecteur: {
      declarantRole: 'COLLECTEUR',
      user: {deletedAt: null}
    }
  })
  t.deepEqual(result, {
    pointId: POINT_ID,
    preleveurs: [
      {id: PRELEVEUR_ID, label: 'Non renseigné'},
      {id: OTHER_PRELEVEUR_ID, label: 'Zeta'}
    ],
    collecteurs: [{id: COLLECTEUR_ID, label: 'Alain Durand'}]
  })
})

for (const [label, point] of [
  ['absent', null],
  ['supprimé', {id: POINT_ID, deletedAt: NOW}]
]) {
  test(`un point ${label} retourne 404 sans charger les acteurs`, async t => {
    let actorQueries = 0
    const client = {
      pointPrelevement: {
        async findUnique() {
          return point
        }
      },
      declarantPointPrelevement: {
        async findMany() {
          actorQueries++
          return []
        }
      }
    }

    const error = await t.throwsAsync(() => getDashboardPointActors(
      POINT_ID,
      {role: 'ADMIN'},
      {client}
    ))

    t.is(error.statusCode, 404)
    t.is(actorQueries, 0)
  })
}

test('le handler refuse un UUID invalide avant le service', async t => {
  let serviceCalls = 0
  const error = await t.throwsAsync(() => getDashboardPointActorsHandler({
    params: {dashboardPointId: 'pas-un-uuid'},
    user: {role: 'ADMIN'}
  }, {
    json() {}
  }, {
    async getPointActors() {
      serviceCalls++
      return {}
    }
  }))

  t.is(error.statusCode, 400)
  t.is(serviceCalls, 0)
})

test('le handler transmet le point validé et l’utilisateur au service', async t => {
  const user = {role: 'ADMIN'}
  const payload = {pointId: POINT_ID, preleveurs: [], collecteurs: []}
  let responsePayload

  await getDashboardPointActorsHandler({
    params: {dashboardPointId: POINT_ID},
    user
  }, {
    json(value) {
      responsePayload = value
    }
  }, {
    async getPointActors(pointId, serviceUser) {
      t.is(pointId, POINT_ID)
      t.is(serviceUser, user)
      return payload
    }
  })

  t.is(responsePayload, payload)
})
