import test from 'ava'

import {
  buildAdminAgentWhere,
  createAdminAgent,
  getAdminAgent,
  listAdminAgents,
  parseAdminAgentsQuery,
  validateAdminAgentCreationPayload
} from '../admin-agents.js'

const NOW = new Date('2026-09-02T10:00:00.000Z')
const AGENT_A_ID = '11111111-1111-4111-8111-111111111111'
const AGENT_B_ID = '22222222-2222-4222-8222-222222222222'
const AGENT_C_ID = '33333333-3333-4333-8333-333333333333'
const ZONE_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ZONE_B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ZONE_C_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const zones = {
  a: {id: ZONE_A_ID, type: 'DEPARTEMENT', code: '01', name: 'Ain'},
  b: {id: ZONE_B_ID, type: 'SAGE', code: 'LOIRE', name: 'Loire amont'},
  c: {id: ZONE_C_ID, type: 'REGION', code: '84', name: 'Auvergne-Rhône-Alpes'}
}

function date(value) {
  return value ? new Date(`${value}T00:00:00.000Z`) : null
}

function right({
  endDate = null,
  id = 'right-id',
  permissions,
  startDate = '2026-01-01',
  zone = zones.a
} = {}) {
  return {
    id,
    zoneId: zone.id,
    zone,
    startDate: date(startDate),
    endDate: date(endDate),
    zoneAttachmentMailSentAt: null,
    createdAt: date('2026-01-01'),
    updatedAt: date('2026-01-02'),
    ...(permissions
      ? {permissions: permissions.map(permission => ({permission}))}
      : {})
  }
}

function agent({
  deletedAt = null,
  email = 'ada@example.test',
  firstName = 'Ada',
  id = AGENT_A_ID,
  instructorZones = [],
  jobTitle = 'Chargée de mission',
  lastName = 'Alpha',
  phoneNumber = '0102030405'
} = {}) {
  return {
    id,
    email,
    firstName,
    lastName,
    createdAt: date('2026-01-01'),
    updatedAt: date('2026-02-01'),
    deletedAt,
    lastLoginAt: date('2026-08-31'),
    accountCreationMailSentAt: null,
    instructor: {
      phoneNumber,
      jobTitle,
      instructorZones
    }
  }
}

test('parseAdminAgentsQuery normalise pagination, listes et codes', t => {
  t.deepEqual(parseAdminAgentsQuery({
    query: '  Ada Loire  ',
    page: '2',
    pageSize: '50',
    accountStatus: 'disabled',
    zoneIds: [`${ZONE_A_ID},${ZONE_B_ID}`, ZONE_A_ID],
    accessStatuses: ['active,future', 'ACTIVE'],
    sort: 'created_at',
    order: 'desc',
    ignored: 'value'
  }), {
    query: 'Ada Loire',
    page: 2,
    pageSize: 50,
    accountStatus: 'DISABLED',
    zoneIds: [ZONE_A_ID, ZONE_B_ID],
    accessStatuses: ['ACTIVE', 'FUTURE'],
    sort: 'CREATED_AT',
    order: 'DESC'
  })

  t.deepEqual(parseAdminAgentsQuery(), {
    query: '',
    page: 1,
    pageSize: 25,
    accountStatus: 'ACTIVE',
    zoneIds: [],
    accessStatuses: [],
    sort: 'NAME',
    order: 'ASC'
  })

  t.is(parseAdminAgentsQuery({query: '  ada  '}).sort, 'RELEVANCE')
  t.is(parseAdminAgentsQuery({sort: 'RELEVANCE'}).sort, 'NAME')
})

test('parseAdminAgentsQuery refuse les filtres inconnus ou mal formés', t => {
  for (const query of [
    {zoneIds: 'zone-invalide'},
    {accessStatuses: 'UNKNOWN'},
    {accountStatus: 'UNKNOWN'},
    {pageSize: 101},
    {sort: 'password'}
  ]) {
    const error = t.throws(() => parseAdminAgentsQuery(query))
    t.is(error.statusCode, 400)
  }
})

test('listAdminAgents filtre, compte et pagine côté base sans N+1', async t => {
  const users = [
    agent({
      instructorZones: [
        right({id: 'active', zone: zones.a}),
        right({id: 'future', startDate: '2026-10-01', zone: zones.b}),
        right({id: 'ended', endDate: '2026-08-31', zone: zones.c})
      ]
    }),
    agent({
      email: 'zoe@example.test',
      firstName: 'Zoé',
      id: AGENT_C_ID,
      instructorZones: [],
      jobTitle: null,
      lastName: 'Zulu',
      phoneNumber: null
    })
  ]
  const findManyQueries = []
  const countQueries = []
  const countResults = [2, 2, 1, 1, 0, 1, 1]
  const client = {
    user: {
      async count(query) {
        countQueries.push(query)
        return countResults[countQueries.length - 1]
      },
      async findMany(query) {
        findManyQueries.push(query)
        return users
      }
    },
    instructorZone: {
      async groupBy() {
        return [
          {zoneId: ZONE_A_ID, _count: {_all: 1}},
          {zoneId: ZONE_B_ID, _count: {_all: 2}},
          {zoneId: ZONE_C_ID, _count: {_all: 1}}
        ]
      }
    },
    zone: {
      async findMany() {
        return [zones.b, zones.c, zones.a]
      }
    }
  }

  const result = await listAdminAgents({pageSize: 10}, {client, now: NOW})

  t.is(findManyQueries.length, 1)
  t.is(countQueries.length, 7)
  t.is(findManyQueries[0].skip, 0)
  t.is(findManyQueries[0].take, 10)
  t.is(findManyQueries[0].where.role, 'INSTRUCTOR')
  t.deepEqual(findManyQueries[0].where.AND, [{deletedAt: null}])
  t.falsy(findManyQueries[0].select.instructor.select.instructorZones.select.permissions)
  t.is(result.page, 1)
  t.is(result.pageSize, 10)
  t.is(result.total, 2)
  t.is(result.totalPages, 1)
  t.is(result.items.length, 2)
  t.is(result.items[0].id, AGENT_A_ID)
  t.like(result.items[0], {
    accountStatus: 'ACTIVE',
    accessStatus: 'ACTIVE',
    activeHabilitationsCount: 1,
    futureHabilitationsCount: 1,
    endedHabilitationsCount: 1,
    habilitationsCount: 3
  })
  t.deepEqual(result.items[0].zones.map(zone => zone.status), ['ACTIVE', 'FUTURE', 'ENDED'])
  t.false(Object.hasOwn(result.items[0].zones[0], 'permissions'))
  t.deepEqual(result.facets.accountStatuses, {ACTIVE: 2, DISABLED: 1})
  t.deepEqual(result.facets.accessStatuses, {ACTIVE: 1, FUTURE: 0, ENDED: 1, NONE: 1})
  t.deepEqual(result.facets.zones.map(zone => [zone.id, zone.count]), [
    [ZONE_A_ID, 1],
    [ZONE_C_ID, 1],
    [ZONE_B_ID, 2]
  ])
})

test('buildAdminAgentWhere applique recherche, compte, zones et statuts d’accès côté base', t => {
  const filters = parseAdminAgentsQuery({
    query: 'mission loire',
    accountStatus: 'ALL',
    zoneIds: [ZONE_B_ID],
    accessStatuses: ['FUTURE', 'NONE']
  })
  const where = buildAdminAgentWhere(filters, {now: NOW})
  const serialized = JSON.stringify(where)

  t.is(where.role, 'INSTRUCTOR')
  t.is(where.AND.length, 4)
  t.true(serialized.includes('mission'))
  t.true(serialized.includes('loire'))
  t.true(serialized.includes(ZONE_B_ID))
  t.true(serialized.includes('startDate'))
  t.true(serialized.includes('instructorZones'))
  t.false(serialized.includes('deletedAt'))
})

test('listAdminAgents trie les zones actives et sélectionne la page en SQL avant hydratation', async t => {
  const users = [
    agent({instructorZones: [right({zone: zones.a})]}),
    agent({
      email: 'brune@example.test',
      firstName: 'Brune',
      id: AGENT_B_ID,
      instructorZones: [right({zone: zones.b})],
      lastName: 'Beta'
    })
  ]
  const rawQueries = []
  const findManyQueries = []
  let countCalls = 0
  const client = {
    async $queryRaw(query) {
      rawQueries.push(query)
      return [{id: AGENT_B_ID}, {id: AGENT_A_ID}]
    },
    user: {
      async count() {
        countCalls++
        return countCalls === 1 ? 12 : 0
      },
      async findMany(query) {
        findManyQueries.push(query)
        return users
      }
    },
    instructorZone: {
      async groupBy() {
        return []
      }
    }
  }

  const result = await listAdminAgents({
    query: 'mission loire',
    accountStatus: 'ACTIVE',
    zoneIds: [ZONE_B_ID],
    accessStatuses: ['ACTIVE'],
    page: 2,
    pageSize: 10,
    sort: 'ACTIVE_ZONES',
    order: 'DESC'
  }, {client, now: NOW})

  t.is(rawQueries.length, 1)
  t.is(findManyQueries.length, 1)
  t.deepEqual(findManyQueries[0].where, {id: {in: [AGENT_B_ID, AGENT_A_ID]}})
  t.false(Object.hasOwn(findManyQueries[0], 'skip'))
  t.false(Object.hasOwn(findManyQueries[0], 'take'))
  t.true(rawQueries[0].text.includes('FROM "User" u'))
  t.true(rawQueries[0].text.includes('SELECT count(*)'))
  t.true(rawQueries[0].text.includes('LIMIT'))
  t.true(rawQueries[0].text.includes('OFFSET'))
  t.true(rawQueries[0].values.includes(ZONE_B_ID))
  t.deepEqual(result.items.map(item => item.id), [AGENT_B_ID, AGENT_A_ID])
  t.is(result.total, 12)
  t.is(result.totalPages, 2)
})

test('getAdminAgent expose toutes les habilitations et leurs droits, compte désactivé compris', async t => {
  let receivedQuery
  const user = agent({
    deletedAt: date('2026-08-01'),
    instructorZones: [
      right({
        id: 'right-detail',
        permissions: ['zone.geometry.read', 'zone.detail.read'],
        zone: zones.a
      }),
      right({id: 'right-ended', endDate: '2026-06-30', permissions: ['zone.detail.read'], zone: zones.b})
    ]
  })
  const client = {
    user: {
      async findFirst(query) {
        receivedQuery = query
        return user
      }
    }
  }

  const result = await getAdminAgent(AGENT_A_ID, {client, now: NOW})

  t.deepEqual(receivedQuery.where, {
    id: AGENT_A_ID,
    role: 'INSTRUCTOR',
    instructor: {isNot: null}
  })
  t.truthy(receivedQuery.select.instructor.select.instructorZones.select.permissions)
  t.is(result.accountStatus, 'DISABLED')
  t.is(result.habilitations.length, 2)
  t.deepEqual(result.habilitations[0].permissions, ['zone.detail.read', 'zone.geometry.read'])
  t.is(result.habilitations[1].status, 'ENDED')
})

test('getAdminAgent valide l’identifiant et distingue un agent introuvable', async t => {
  let calls = 0
  const client = {
    user: {
      async findFirst() {
        calls++
        return null
      }
    }
  }

  const invalid = await t.throwsAsync(getAdminAgent('invalide', {client}))
  t.is(invalid.statusCode, 400)
  t.is(calls, 0)

  const missing = await t.throwsAsync(getAdminAgent(AGENT_A_ID, {client}))
  t.is(missing.statusCode, 404)
  t.is(calls, 1)
})

test('validateAdminAgentCreationPayload normalise les champs et contrôle la période et les droits', t => {
  const value = validateAdminAgentCreationPayload({
    email: ' ADA@Example.Test ',
    firstName: ' Ada ',
    lastName: ' Lovelace ',
    phoneNumber: '',
    jobTitle: ' Mathématicienne ',
    zoneId: ZONE_A_ID,
    startDate: '2026-09-01',
    endDate: null,
    permissions: ['zone.detail.read'],
    notifyAccountCreation: true
  })

  t.like(value, {
    email: 'ada@example.test',
    firstName: 'Ada',
    lastName: 'Lovelace',
    phoneNumber: null,
    jobTitle: 'Mathématicienne',
    zoneId: ZONE_A_ID,
    permissions: ['zone.detail.read'],
    notifyAccountCreation: true,
    notifyZoneAttachment: false
  })
  t.true(value.startDate instanceof Date)

  for (const payload of [
    {...value, startDate: '2026-09-02', endDate: '2026-09-01'},
    {...value, permissions: ['pp.create']},
    {...value, phoneNumber: '01 02 03 04 05'},
    {...value, unknown: true}
  ]) {
    const error = t.throws(() => validateAdminAgentCreationPayload(payload))
    t.is(error.statusCode, 400)
  }
})

test('createAdminAgent crée atomiquement le profil, la zone et les droits puis notifie', async t => {
  const calls = []
  const createdUser = agent({
    email: 'ada@example.test',
    firstName: 'Ada',
    instructorZones: [right({permissions: ['zone.detail.read'], zone: zones.a})],
    lastName: 'Lovelace'
  })
  const transaction = {
    zone: {
      async findUnique(query) {
        calls.push(['zone.findUnique', query])
        return zones.a
      }
    },
    user: {
      async findUnique(query) {
        calls.push(['user.findUnique', query])
        return null
      },
      async create(query) {
        calls.push(['user.create', query])
        return createdUser
      }
    },
    instructorZone: {
      async create(query) {
        calls.push(['instructorZone.create', query])
        return {id: 'right-created'}
      }
    }
  }
  const client = {
    async $transaction(callback) {
      calls.push(['transaction'])
      return callback(transaction)
    },
    user: {
      async findFirst(query) {
        calls.push(['user.findFirst', query])
        return createdUser
      }
    }
  }
  const notifications = []

  const result = await createAdminAgent({
    email: 'ADA@example.test',
    firstName: 'Ada',
    lastName: 'Lovelace',
    phoneNumber: '0102030405',
    jobTitle: 'Mathématicienne',
    zoneId: ZONE_A_ID,
    startDate: '2026-09-01',
    endDate: null,
    permissions: ['zone.detail.read'],
    notifyAccountCreation: true,
    notifyZoneAttachment: true
  }, {
    client,
    now: NOW,
    async notifyAccountCreation(user, options) {
      notifications.push(['account', user.id, options])
    },
    async notifyZoneAttachment({instructor, zone}) {
      notifications.push(['zone', instructor.id, zone.id])
    }
  })

  const userCreate = calls.find(([name]) => name === 'user.create')[1]
  const rightCreate = calls.find(([name]) => name === 'instructorZone.create')[1]

  t.is(calls[0][0], 'transaction')
  t.deepEqual(userCreate.data, {
    email: 'ada@example.test',
    role: 'INSTRUCTOR',
    firstName: 'Ada',
    lastName: 'Lovelace',
    instructor: {
      create: {
        phoneNumber: '0102030405',
        jobTitle: 'Mathématicienne'
      }
    }
  })
  t.is(rightCreate.data.instructorUserId, AGENT_A_ID)
  t.is(rightCreate.data.zoneId, ZONE_A_ID)
  t.true(rightCreate.data.startDate instanceof Date)
  t.deepEqual(rightCreate.data.permissions.createMany.data, [{permission: 'zone.detail.read'}])
  t.deepEqual(notifications, [
    ['account', AGENT_A_ID, {role: 'INSTRUCTOR'}],
    ['zone', AGENT_A_ID, ZONE_A_ID]
  ])
  t.is(result.id, AGENT_A_ID)
  t.is(result.habilitations.length, 1)
  t.false(Object.hasOwn(result, 'warnings'))
})

test('createAdminAgent conserve la création et retourne les avertissements si les notifications échouent', async t => {
  const createdUser = agent({
    instructorZones: [right({permissions: ['zone.detail.read'], zone: zones.a})]
  })
  const transaction = {
    zone: {
      async findUnique() {
        return zones.a
      }
    },
    user: {
      async findUnique() {
        return null
      },
      async create() {
        return createdUser
      }
    },
    instructorZone: {
      async create() {
        return {id: 'right-created'}
      }
    }
  }
  const client = {
    async $transaction(callback) {
      return callback(transaction)
    },
    user: {
      async findFirst() {
        return createdUser
      }
    }
  }
  let zoneNotificationCalls = 0

  const result = await createAdminAgent({
    email: 'ada@example.test',
    firstName: 'Ada',
    lastName: 'Alpha',
    zoneId: ZONE_A_ID,
    startDate: '2026-09-01',
    permissions: ['zone.detail.read'],
    notifyAccountCreation: true,
    notifyZoneAttachment: true
  }, {
    client,
    now: NOW,
    async notifyAccountCreation() {
      throw new Error('service mail indisponible')
    },
    async notifyZoneAttachment() {
      zoneNotificationCalls++
      throw new Error('service mail indisponible')
    }
  })

  t.is(result.id, AGENT_A_ID)
  t.is(zoneNotificationCalls, 1)
  t.deepEqual(result.warnings, [
    'La notification de création du compte n’a pas pu être envoyée.',
    'La notification de rattachement à la zone n’a pas pu être envoyée.'
  ])
})

test('createAdminAgent refuse un email existant sans altérer ses habilitations', async t => {
  let writes = 0
  const transaction = {
    zone: {
      async findUnique() {
        return zones.a
      }
    },
    user: {
      async findUnique() {
        return {id: AGENT_B_ID, deletedAt: date('2026-08-01')}
      },
      async create() {
        writes++
      }
    },
    instructorZone: {
      async create() {
        writes++
      }
    }
  }
  const client = {
    async $transaction(callback) {
      return callback(transaction)
    }
  }

  const error = await t.throwsAsync(createAdminAgent({
    email: 'ada@example.test',
    firstName: 'Ada',
    lastName: 'Lovelace',
    zoneId: ZONE_A_ID,
    startDate: '2026-09-01',
    permissions: ['zone.detail.read']
  }, {client}))

  t.is(error.statusCode, 409)
  t.is(writes, 0)
})

test('createAdminAgent traduit aussi un conflit email concurrent', async t => {
  const client = {
    async $transaction(callback) {
      return callback({
        zone: {
          async findUnique() {
            return zones.a
          }
        },
        user: {
          async findUnique() {
            return null
          },
          async create() {
            throw Object.assign(new Error('unique'), {code: 'P2002'})
          }
        }
      })
    }
  }

  const error = await t.throwsAsync(createAdminAgent({
    email: 'ada@example.test',
    firstName: 'Ada',
    lastName: 'Lovelace',
    zoneId: ZONE_A_ID,
    startDate: '2026-09-01',
    permissions: ['zone.detail.read']
  }, {client}))

  t.is(error.statusCode, 409)
})
