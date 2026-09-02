import test from 'ava'

import {ZONE_AGENT_MANAGEMENT_PERMISSIONS} from '../../constants/zone-permissions.js'
import {
  ADMIN_AGENT_ACCOUNT_NOTIFICATION_TYPES,
  deactivateAdminAgent,
  replaceAdminAgentEmail,
  restoreAdminAgent,
  serializeAdminAgentAccount,
  updateAdminAgentProfile
} from '../admin-agent-account.js'

const NOW = new Date('2026-09-02T10:00:00.000Z')
const UPDATED_AT = new Date('2026-08-30T08:00:00.000Z')
const NEXT_UPDATED_AT = new Date('2026-09-02T10:00:01.000Z')
const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const ZONE_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ZONE_B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function date(value) {
  return value ? new Date(`${value}T00:00:00.000Z`) : null
}

function zone(id, name) {
  return {
    id,
    type: 'SAGE',
    code: id === ZONE_A_ID ? 'ZONE-A' : 'ZONE-B',
    name
  }
}

function right({
  endDate = null,
  id = 'right-a',
  management = true,
  startDate = '2026-01-01',
  zone: rightZone = zone(ZONE_A_ID, 'Zone A')
} = {}) {
  return {
    id,
    zoneId: rightZone.id,
    zone: rightZone,
    permissions: (management ? ZONE_AGENT_MANAGEMENT_PERMISSIONS : ['zone.read'])
      .map(permission => ({permission})),
    startDate: date(startDate),
    endDate: date(endDate),
    zoneAttachmentMailSentAt: null,
    createdAt: date('2026-01-01'),
    updatedAt: date('2026-01-02')
  }
}

function agent({
  authVersion = 3,
  deletedAt = null,
  email = 'ada@example.test',
  instructorZones = [right()]
} = {}) {
  return {
    id: AGENT_ID,
    email,
    role: 'INSTRUCTOR',
    firstName: 'Ada',
    lastName: 'Lovelace',
    authVersion,
    createdAt: date('2026-01-01'),
    updatedAt: UPDATED_AT,
    deletedAt,
    lastLoginAt: date('2026-08-31'),
    accountCreationMailSentAt: date('2026-02-01'),
    instructor: {
      phoneNumber: '0102030405',
      jobTitle: 'Chargée de mission',
      instructorZones
    }
  }
}

function stateMatchesWhere(currentAgent, where) {
  if (where.deletedAt === null && currentAgent.deletedAt) {
    return false
  }

  if (where.deletedAt && Object.hasOwn(where.deletedAt, 'not') && !currentAgent.deletedAt) {
    return false
  }

  return true
}

function updatedAgent(currentAgent, data) {
  const instructorChanges = data.instructor?.update?.data ?? {}
  const authVersion = data.authVersion?.increment
    ? currentAgent.authVersion + data.authVersion.increment
    : currentAgent.authVersion
  const scalarData = {...data}
  delete scalarData.instructor
  delete scalarData.authVersion

  return {
    ...currentAgent,
    ...scalarData,
    authVersion,
    updatedAt: NEXT_UPDATED_AT,
    instructor: {
      ...currentAgent.instructor,
      ...instructorChanges
    }
  }
}

function createHarness({
  initialAgent = agent(),
  managerCounts = {},
  transactionErrors = []
} = {}) {
  let currentAgent = initialAgent
  const pendingTransactionErrors = [...transactionErrors]
  const calls = {
    authTokenDeletes: [],
    emailVerificationUpdates: [],
    passwordActivationDeletes: [],
    passwordCredentialDeletes: [],
    queryRaw: [],
    sessionDeletes: [],
    transactionOptions: [],
    userAliasDeletes: [],
    userFinds: [],
    userUpdates: [],
    zoneCounts: [],
    zoneLocks: []
  }

  const transaction = {
    async $queryRaw(query) {
      calls.queryRaw.push(query)
      return [{id: AGENT_ID}]
    },
    async $executeRaw(query) {
      calls.zoneLocks.push(query.values[0])
      return 1
    },
    user: {
      async findFirst(arguments_) {
        calls.userFinds.push(arguments_)
        return stateMatchesWhere(currentAgent, arguments_.where) ? currentAgent : null
      },
      async update(arguments_) {
        calls.userUpdates.push(arguments_)
        currentAgent = updatedAgent(currentAgent, arguments_.data)
        return currentAgent
      }
    },
    userEmailVerification: {
      async updateMany(arguments_) {
        calls.emailVerificationUpdates.push(arguments_)
        return {count: 2}
      }
    },
    userEmailAlias: {
      async deleteMany(arguments_) {
        calls.userAliasDeletes.push(arguments_)
        return {count: 2}
      }
    },
    authToken: {
      async deleteMany(arguments_) {
        calls.authTokenDeletes.push(arguments_)
        return {count: 3}
      }
    },
    passwordActivation: {
      async deleteMany(arguments_) {
        calls.passwordActivationDeletes.push(arguments_)
        return {count: 1}
      }
    },
    passwordCredential: {
      async deleteMany(arguments_) {
        calls.passwordCredentialDeletes.push(arguments_)
        return {count: 1}
      }
    },
    sessionToken: {
      async deleteMany(arguments_) {
        calls.sessionDeletes.push(arguments_)
        return {count: 4}
      }
    },
    instructorZone: {
      async count(arguments_) {
        calls.zoneCounts.push(arguments_)
        return managerCounts[arguments_.where.zoneId] ?? 1
      }
    }
  }

  const client = {
    async $transaction(operation, options) {
      calls.transactionOptions.push(options)
      const error = pendingTransactionErrors.shift()

      if (error) {
        throw error
      }

      return operation(transaction)
    }
  }

  return {
    calls,
    client,
    get agent() {
      return currentAgent
    }
  }
}

test('serializeAdminAgentAccount reste compatible AgentDetail pour un compte désactivé', t => {
  const serialized = serializeAdminAgentAccount(agent({
    deletedAt: NOW,
    instructorZones: [
      right(),
      right({
        id: 'right-b',
        startDate: '2026-10-01',
        zone: zone(ZONE_B_ID, 'Zone B')
      }),
      right({id: 'right-ended', endDate: '2026-08-01', management: false})
    ]
  }), {now: NOW})

  t.is(serialized.accountStatus, 'DISABLED')
  t.is(serialized.accessStatus, 'ACTIVE')
  t.is(serialized.habilitations.length, 3)
  t.is(serialized.activeHabilitationsCount, 1)
  t.is(serialized.futureHabilitationsCount, 1)
  t.is(serialized.endedHabilitationsCount, 1)
  t.false(Object.hasOwn(serialized, 'status'))
})

test('updateAdminAgentProfile modifie uniquement le profil avec contrôle de version', async t => {
  const harness = createHarness()

  const result = await updateAdminAgentProfile(AGENT_ID, {
    firstName: '  Grace ',
    phoneNumber: '0607080910',
    expectedUpdatedAt: UPDATED_AT.toISOString()
  }, {
    client: harness.client,
    now: NOW
  })

  t.is(harness.calls.transactionOptions[0].isolationLevel, 'Serializable')
  t.deepEqual(harness.calls.userUpdates[0].where, {
    id: AGENT_ID,
    role: 'INSTRUCTOR',
    deletedAt: null,
    updatedAt: UPDATED_AT
  })
  t.deepEqual(harness.calls.userUpdates[0].data, {
    firstName: 'Grace',
    instructor: {
      update: {data: {phoneNumber: '0607080910'}}
    }
  })
  t.is(result.agent.firstName, 'Grace')
  t.is(result.agent.phoneNumber, '0607080910')
  t.deepEqual(result.warnings, [])
})

test('updateAdminAgentProfile expose le conflit optimiste dans error.data', async t => {
  const harness = createHarness()
  const error = await t.throwsAsync(updateAdminAgentProfile(AGENT_ID, {
    lastName: 'Hopper',
    expectedUpdatedAt: '2026-01-01T00:00:00.000Z'
  }, {client: harness.client}))

  t.is(error.statusCode, 412)
  t.deepEqual(error.data, {
    code: 'AGENT_STALE',
    currentUpdatedAt: UPDATED_AT
  })
  t.is(harness.calls.userUpdates.length, 0)
})

test('les transactions sérialisables sont rejouées après un conflit P2034', async t => {
  const harness = createHarness({transactionErrors: [{code: 'P2034'}]})

  const result = await updateAdminAgentProfile(AGENT_ID, {
    jobTitle: 'Responsable',
    expectedUpdatedAt: UPDATED_AT
  }, {client: harness.client})

  t.is(result.agent.jobTitle, 'Responsable')
  t.is(harness.calls.transactionOptions.length, 2)
  t.true(harness.calls.transactionOptions.every(options =>
    options.isolationLevel === 'Serializable'))
})

test('un conflit sérialisable persistant est exposé comme erreur métier réessayable', async t => {
  const harness = createHarness({
    transactionErrors: [
      {code: 'P2034'},
      {code: 'P2034'},
      {code: 'P2034'}
    ]
  })

  const error = await t.throwsAsync(updateAdminAgentProfile(AGENT_ID, {
    jobTitle: 'Responsable',
    expectedUpdatedAt: UPDATED_AT
  }, {client: harness.client}))

  t.is(error.statusCode, 503)
  t.deepEqual(error.data, {code: 'AGENT_CONCURRENT_UPDATE'})
  t.is(harness.calls.transactionOptions.length, 3)
})

test('replaceAdminAgentEmail remplace directement l’identité et invalide les accès temporaires', async t => {
  const harness = createHarness()
  const notifications = []

  const result = await replaceAdminAgentEmail(AGENT_ID, {
    email: ' Nouvelle@Example.test ',
    expectedCurrentEmail: 'ADA@example.test'
  }, {
    client: harness.client,
    now: NOW,
    async notify(payload) {
      notifications.push(payload)
    }
  })

  t.true(result.changed)
  t.is(result.agent.email, 'nouvelle@example.test')
  t.is(result.previousEmail, 'ada@example.test')
  t.deepEqual(result.invalidated, {
    authTokens: 3,
    passwordActivations: 1,
    sessions: 4
  })
  t.deepEqual(harness.calls.emailVerificationUpdates[0].data, {
    status: 'SUPERSEDED',
    tokenHash: null
  })
  t.deepEqual(harness.calls.userAliasDeletes[0].where, {
    userId: AGENT_ID,
    email: 'nouvelle@example.test'
  })
  t.is(harness.calls.passwordCredentialDeletes.length, 0)
  t.deepEqual(harness.calls.userUpdates[0].data, {email: 'nouvelle@example.test'})
  t.is(notifications[0].type, ADMIN_AGENT_ACCOUNT_NOTIFICATION_TYPES.EMAIL_CHANGED)
  t.deepEqual(notifications[0].recipients, [
    'ada@example.test',
    'nouvelle@example.test'
  ])
})

test('replaceAdminAgentEmail est idempotent si l’adresse normalisée ne change pas', async t => {
  const harness = createHarness()
  let notified = false

  const result = await replaceAdminAgentEmail(AGENT_ID, {
    email: ' ADA@example.test ',
    expectedCurrentEmail: 'ada@example.test'
  }, {
    client: harness.client,
    async notify() {
      notified = true
    }
  })

  t.false(result.changed)
  t.is(harness.calls.userUpdates.length, 0)
  t.is(harness.calls.authTokenDeletes.length, 0)
  t.false(notified)
})

test('replaceAdminAgentEmail transforme un conflit du registre en 409 métier', async t => {
  const harness = createHarness()
  harness.client.$transaction = async () => {
    const error = new Error('User_email_reserved')
    error.code = 'P2004'
    throw error
  }

  const error = await t.throwsAsync(replaceAdminAgentEmail(AGENT_ID, {
    email: 'reservee@example.test',
    expectedCurrentEmail: 'ada@example.test'
  }, {client: harness.client}))

  t.is(error.statusCode, 409)
  t.deepEqual(error.data, {code: 'AGENT_EMAIL_CONFLICT'})
})

test('un échec de notification email ne remet pas la mutation en cause', async t => {
  const harness = createHarness()

  const result = await replaceAdminAgentEmail(AGENT_ID, {
    email: 'nouvelle@example.test',
    expectedCurrentEmail: 'ada@example.test'
  }, {
    client: harness.client,
    async notify() {
      throw new Error('SMTP indisponible')
    }
  })

  t.is(result.agent.email, 'nouvelle@example.test')
  t.deepEqual(result.warnings, ['AGENT_EMAIL_NOTIFICATION_FAILED'])
})

test('deactivateAdminAgent sans confirmation email verrouille les zones triées, conserve les habilitations et révoque les accès', async t => {
  const rights = [
    right({id: 'right-b', zone: zone(ZONE_B_ID, 'Zone B')}),
    right({id: 'right-a', zone: zone(ZONE_A_ID, 'Zone A')})
  ]
  const harness = createHarness({initialAgent: agent({instructorZones: rights})})
  const notifications = []

  const result = await deactivateAdminAgent(AGENT_ID, {
    expectedUpdatedAt: UPDATED_AT
  }, {
    client: harness.client,
    now: NOW,
    async notify(payload) {
      notifications.push(payload)
    }
  })

  t.deepEqual(harness.calls.zoneLocks, [ZONE_A_ID, ZONE_B_ID])
  t.is(harness.calls.queryRaw.length, 2)
  t.deepEqual(harness.calls.userUpdates[0].data, {
    authVersion: {increment: 1},
    deletedAt: NOW
  })
  t.is(harness.agent.email, 'ada@example.test')
  t.is(harness.agent.instructor.instructorZones.length, 2)
  t.is(result.agent.accountStatus, 'DISABLED')
  t.deepEqual(result.agent.habilitations.map(item => item.id), ['right-a', 'right-b'])
  t.deepEqual(result.invalidated, {
    aliases: 2,
    authTokens: 3,
    emailVerifications: 2,
    passwordActivations: 1,
    passwordCredentials: 1,
    sessions: 4
  })
  t.deepEqual(harness.calls.emailVerificationUpdates[0].data, {
    status: 'CANCELLED',
    tokenHash: null,
    cancelledAt: NOW
  })
  t.is(harness.calls.passwordCredentialDeletes.length, 1)
  t.is(notifications[0].type, ADMIN_AGENT_ACCOUNT_NOTIFICATION_TYPES.DEACTIVATED)
})

test('deactivateAdminAgent refuse le dernier gestionnaire actif et expose les zones', async t => {
  const harness = createHarness({managerCounts: {[ZONE_A_ID]: 0}})

  const error = await t.throwsAsync(deactivateAdminAgent(AGENT_ID, {
    expectedUpdatedAt: UPDATED_AT
  }, {
    client: harness.client,
    now: NOW
  }))

  t.is(error.statusCode, 409)
  t.deepEqual(error.data, {
    code: 'LAST_ACTIVE_ZONE_MANAGER',
    zones: [{
      id: ZONE_A_ID,
      code: 'ZONE-A',
      name: 'Zone A',
      type: 'SAGE'
    }]
  })
  t.is(harness.calls.userUpdates.length, 0)
  t.is(harness.calls.authTokenDeletes.length, 0)

  const managerCountWhere = harness.calls.zoneCounts[0].where
  t.deepEqual(managerCountWhere.AND.slice(0, 2), [
    {startDate: {lte: date('2026-09-02')}},
    {OR: [{endDate: null}, {endDate: {gte: date('2026-09-02')}}]}
  ])
  t.deepEqual(
    managerCountWhere.AND.slice(2),
    ZONE_AGENT_MANAGEMENT_PERMISSIONS.map(permission => ({
      permissions: {some: {permission}}
    }))
  )
})

test('deactivateAdminAgent considère une habilitation comme active pendant tout son dernier jour', async t => {
  const harness = createHarness({
    initialAgent: agent({
      instructorZones: [right({endDate: '2026-09-02'})]
    }),
    managerCounts: {[ZONE_A_ID]: 0}
  })

  const error = await t.throwsAsync(deactivateAdminAgent(AGENT_ID, {
    expectedUpdatedAt: UPDATED_AT
  }, {
    client: harness.client,
    now: NOW
  }))

  t.is(error.statusCode, 409)
  t.is(error.data.code, 'LAST_ACTIVE_ZONE_MANAGER')
  t.is(harness.calls.zoneCounts.length, 1)
  t.is(harness.calls.userUpdates.length, 0)
})

test('deactivateAdminAgent exige toujours la version attendue', async t => {
  const harness = createHarness()

  const error = await t.throwsAsync(deactivateAdminAgent(AGENT_ID, {}, {
    client: harness.client
  }))

  t.is(error.statusCode, 400)
  t.deepEqual(error.data, {code: 'EXPECTED_UPDATED_AT_REQUIRED'})
  t.is(harness.calls.zoneLocks.length, 0)
})

test('restoreAdminAgent conserve les habilitations mais ne recrée aucun moyen de connexion', async t => {
  const rights = [right(), right({
    id: 'right-future',
    startDate: '2026-10-01',
    zone: zone(ZONE_B_ID, 'Zone B')
  })]
  const harness = createHarness({
    initialAgent: agent({deletedAt: date('2026-08-01'), instructorZones: rights})
  })
  const notifications = []

  const result = await restoreAdminAgent(AGENT_ID, {
    expectedUpdatedAt: UPDATED_AT.toISOString()
  }, {
    client: harness.client,
    now: NOW,
    async notify(payload) {
      notifications.push(payload)
    }
  })

  t.deepEqual(harness.calls.userUpdates[0].data, {
    authVersion: {increment: 1},
    deletedAt: null
  })
  t.is(result.agent.accountStatus, 'ACTIVE')
  t.deepEqual(result.agent.habilitations.map(item => item.id), ['right-a', 'right-future'])
  t.is(result.agent.activeHabilitationsCount, 1)
  t.is(result.agent.futureHabilitationsCount, 1)
  t.is(harness.calls.userAliasDeletes.length, 1)
  t.is(harness.calls.passwordCredentialDeletes.length, 1)
  t.is(harness.calls.passwordActivationDeletes.length, 1)
  t.is(harness.calls.sessionDeletes.length, 1)
  t.is(harness.calls.authTokenDeletes.length, 1)
  t.deepEqual(result.invalidated, {
    aliases: 2,
    authTokens: 3,
    emailVerifications: 2,
    passwordActivations: 1,
    passwordCredentials: 1,
    sessions: 4
  })
  t.is(notifications[0].type, ADMIN_AGENT_ACCOUNT_NOTIFICATION_TYPES.RESTORED)
})

test('restoreAdminAgent refuse un compte déjà actif', async t => {
  const harness = createHarness()

  const error = await t.throwsAsync(restoreAdminAgent(AGENT_ID, {
    expectedUpdatedAt: UPDATED_AT
  }, {client: harness.client}))

  t.is(error.statusCode, 409)
  t.deepEqual(error.data, {code: 'AGENT_ALREADY_ACTIVE'})
  t.is(harness.calls.userUpdates.length, 0)
})
