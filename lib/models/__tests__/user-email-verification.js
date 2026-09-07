import {Buffer} from 'node:buffer'
import {readFile} from 'node:fs/promises'

import test from 'ava'

import {
  consumeEmailVerification,
  EMAIL_VERIFICATION_PURPOSES,
  EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS,
  EMAIL_VERIFICATION_STATUSES,
  EMAIL_VERIFICATION_TTL_SECONDS,
  hashUserEmailVerificationToken,
  issueEmailVerification,
  recordEmailVerificationDelivery,
  resendEmailVerification,
  serializeUserEmailVerification,
  synchronizeDeclarantPrimaryContactEmail
} from '../user-email-verification.js'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const VERIFICATION_ID = '22222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-08-31T12:00:00.000Z')
const USER = {
  id: USER_ID,
  email: 'ancienne@example.test',
  firstName: 'Camille',
  lastName: 'Rivière',
  role: 'DECLARANT',
  emailAliases: []
}

function buildVerification(overrides = {}) {
  return {
    id: VERIFICATION_ID,
    userId: USER_ID,
    purpose: EMAIL_VERIFICATION_PURPOSES.PRIMARY_CHANGE,
    status: EMAIL_VERIFICATION_STATUSES.PENDING,
    email: 'nouvelle@example.test',
    primaryEmailSnapshot: USER.email,
    tokenHash: 'a'.repeat(64),
    createdAt: NOW,
    updatedAt: NOW,
    lastAttemptedAt: NOW,
    sentAt: null,
    expiresAt: new Date(NOW.getTime() + (24 * 60 * 60 * 1000)),
    verifiedAt: null,
    cancelledAt: null,
    ...overrides
  }
}

function transactionClient(transaction) {
  return {
    async $transaction(callback) {
      return callback(transaction)
    }
  }
}

test('le registre SQL sérialise les adresses sans réserver une demande expirée', async t => {
  const migration = await readFile(new URL(
    '../../../prisma/migrations/20260831170000_add_user_email_verifications/migration.sql',
    import.meta.url
  ), 'utf8')

  t.true(migration.includes('OR NEW."expiresAt" <= CURRENT_TIMESTAMP'))
  t.is(
    migration.match(/AND "expiresAt" > CURRENT_TIMESTAMP/g)?.length,
    2
  )
  const lockPosition = migration.indexOf('LOCK TABLE')
  const backfillPosition = migration.indexOf('INSERT INTO "UserEmailIdentity"')
  t.true(lockPosition !== -1)
  t.true(lockPosition < backfillPosition)
  t.true(migration.includes('CREATE TABLE "UserEmailIdentity"'))
  t.true(migration.includes('UserEmailIdentity_compatible_claims_check'))
  t.true(migration.includes('UserEmailAlias_00_lock_owners'))
  t.true(migration.includes('User_zz_increment_auth_version'))
  t.true(migration.includes('pg_trigger_depth() = 1'))
  t.true(migration.includes('current_session_actor_auth_version_required'))
  t.true(migration.includes('User_sync_primary_email_identity'))
  t.true(migration.includes('UserEmailAlias_sync_identity'))
  t.true(migration.includes('UserEmailVerification_sync_identity'))
})

test('le jeton email contient 256 bits et le serializer ne divulgue aucun secret', async t => {
  const updates = []
  let createdData
  const existing = buildVerification({
    id: '33333333-3333-4333-8333-333333333333',
    email: 'ancienne-cible@example.test'
  })
  const transaction = {
    user: {
      async findFirst({where}) {
        return where.id ? USER : null
      }
    },
    userEmailAlias: {
      async findUnique() {
        return null
      }
    },
    userEmailVerification: {
      async updateMany() {
        return {count: 0}
      },
      async findFirst({where}) {
        return where.userId && where.purpose ? existing : null
      },
      async update(operation) {
        updates.push(operation)
      },
      async create({data}) {
        createdData = data
        return {...data, updatedAt: NOW}
      }
    }
  }

  const result = await issueEmailVerification(
    USER_ID,
    EMAIL_VERIFICATION_PURPOSES.PRIMARY_CHANGE,
    ' Nouvelle@Example.Test ',
    {
      client: transactionClient(transaction),
      now: NOW,
      async lockUser() {
        return true
      }
    }
  )

  t.is(Buffer.from(result.token, 'base64url').length, 32)
  t.is(result.tokenHash, hashUserEmailVerificationToken(result.token))
  t.is(createdData.tokenHash, result.tokenHash)
  t.is(createdData.email, 'nouvelle@example.test')
  t.is(createdData.primaryEmailSnapshot, USER.email)
  t.is(createdData.expiresAt - NOW, EMAIL_VERIFICATION_TTL_SECONDS * 1000)
  t.is(updates[0].where.id, existing.id)
  t.deepEqual(updates[0].data, {
    status: EMAIL_VERIFICATION_STATUSES.SUPERSEDED,
    tokenHash: null
  })
  t.true(result.superseded)
  t.deepEqual(result.securityNotificationRecipients, [USER.email])

  const serialized = serializeUserEmailVerification(result.verification, {now: NOW})
  t.false(Object.hasOwn(serialized, 'tokenHash'))
  t.false(Object.hasOwn(serialized, 'primaryEmailSnapshot'))
  t.false(Object.hasOwn(serialized, 'lastAttemptedAt'))
  t.false(serialized.canResend)
  t.is(
    serialized.nextResendAt - NOW,
    EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS * 1000
  )
})

test('le serializer présente un état expiré persistant pour le client', t => {
  const verification = buildVerification({
    status: EMAIL_VERIFICATION_STATUSES.SEND_FAILED,
    expiresAt: new Date(NOW.getTime() - 1)
  })

  const serialized = serializeUserEmailVerification(verification, {now: NOW})

  t.is(serialized.status, EMAIL_VERIFICATION_STATUSES.EXPIRED)
  t.is(serialized.nextResendAt, null)
  t.true(serialized.canResend)
})

test('une demande refuse une adresse principale déjà utilisée', async t => {
  let created = false
  const transaction = {
    user: {
      async findFirst({where}) {
        return where.id ? USER : {id: USER_ID}
      }
    },
    userEmailAlias: {
      async findUnique() {
        return null
      }
    },
    userEmailVerification: {
      async updateMany() {
        return {count: 0}
      },
      async findFirst() {
        return null
      },
      async create() {
        created = true
      }
    }
  }

  const error = await t.throwsAsync(issueEmailVerification(
    USER_ID,
    EMAIL_VERIFICATION_PURPOSES.ALIAS_ADD,
    USER.email,
    {
      client: transactionClient(transaction),
      now: NOW,
      async lockUser() {
        return true
      }
    }
  ))

  t.is(error.status, 409)
  t.false(created)
})

test('une adresse démesurée est refusée avant toute transaction', async t => {
  let transactionStarted = false
  const client = {
    async $transaction() {
      transactionStarted = true
    }
  }

  const error = await t.throwsAsync(issueEmailVerification(
    USER_ID,
    EMAIL_VERIFICATION_PURPOSES.PRIMARY_CHANGE,
    `${'x'.repeat(310)}@example.test`,
    {client, now: NOW}
  ))

  t.is(error.status, 400)
  t.false(transactionStarted)
})

test('une session révoquée pendant l’attente du verrou ne crée aucune demande', async t => {
  let userRead = false
  const transaction = {
    user: {
      async findFirst() {
        userRead = true
      }
    }
  }

  const error = await t.throwsAsync(issueEmailVerification(
    USER_ID,
    EMAIL_VERIFICATION_PURPOSES.ALIAS_ADD,
    'alias@example.test',
    {
      allowImpersonatedSession: true,
      client: transactionClient(transaction),
      now: NOW,
      sessionToken: 'session-révoquée',
      async lockUser() {
        return true
      },
      async validateSession(userId, token, options) {
        t.is(userId, USER_ID)
        t.is(token, 'session-révoquée')
        t.true(options.allowImpersonated)
        throw Object.assign(new Error('session révoquée'), {status: 401})
      }
    }
  ))

  t.is(error.status, 401)
  t.false(userRead)
})

test('sans adresse principale, les alias actifs reçoivent l’alerte de sécurité', async t => {
  const user = {
    ...USER,
    email: null,
    emailAliases: [
      {id: 'alias-1', email: 'ALIAS-1@example.test', createdAt: NOW},
      {id: 'alias-2', email: 'alias-2@example.test', createdAt: NOW}
    ]
  }
  const transaction = {
    user: {
      async findFirst({where}) {
        return where.id ? user : null
      }
    },
    userEmailAlias: {
      async findUnique() {
        return null
      }
    },
    userEmailVerification: {
      async updateMany() {
        return {count: 0}
      },
      async findFirst() {
        return null
      },
      async create({data}) {
        return {...data, updatedAt: NOW}
      }
    }
  }

  const result = await issueEmailVerification(
    USER_ID,
    EMAIL_VERIFICATION_PURPOSES.PRIMARY_CHANGE,
    'nouvelle@example.test',
    {
      client: transactionClient(transaction),
      now: NOW,
      async lockUser() {
        return true
      }
    }
  )

  t.deepEqual(result.securityNotificationRecipients, [
    'alias-1@example.test',
    'alias-2@example.test'
  ])
})

test('une demande identique ne contourne pas le cooldown de renvoi', async t => {
  let mutated = false
  const existing = buildVerification()
  const transaction = {
    user: {
      async findFirst() {
        return USER
      }
    },
    userEmailVerification: {
      async updateMany() {
        return {count: 0}
      },
      async findFirst() {
        return existing
      },
      async update() {
        mutated = true
      },
      async create() {
        mutated = true
      }
    }
  }

  const error = await t.throwsAsync(issueEmailVerification(
    USER_ID,
    EMAIL_VERIFICATION_PURPOSES.PRIMARY_CHANGE,
    existing.email,
    {
      client: transactionClient(transaction),
      now: new Date(NOW.getTime() + 15_000),
      async lockUser() {
        return true
      }
    }
  ))

  t.is(error.status, 429)
  t.is(error.retryAfterSeconds, 45)
  t.false(mutated)
})

test('un renvoi trop rapproché conserve le jeton et indique le délai restant', async t => {
  let updated = false
  const verification = buildVerification()
  const transaction = {
    user: {
      async findFirst() {
        return USER
      }
    },
    userEmailVerification: {
      async findFirst() {
        return verification
      },
      async update() {
        updated = true
      }
    }
  }

  const result = await resendEmailVerification(USER_ID, VERIFICATION_ID, {
    client: transactionClient(transaction),
    now: new Date(NOW.getTime() + 10_000),
    async lockUser() {
      return true
    }
  })

  t.is(result.outcome, 'COOLDOWN')
  t.is(result.retryAfterSeconds, 50)
  t.false(updated)
})

test('un état EXPIRED déjà persisté peut toujours déclencher une nouvelle demande', async t => {
  const verification = buildVerification({
    status: EMAIL_VERIFICATION_STATUSES.EXPIRED,
    tokenHash: null,
    expiresAt: new Date(NOW.getTime() - 1000)
  })
  const transaction = {
    user: {
      async findFirst() {
        return USER
      }
    },
    userEmailVerification: {
      async findFirst() {
        return verification
      }
    }
  }

  const result = await resendEmailVerification(USER_ID, VERIFICATION_ID, {
    client: transactionClient(transaction),
    now: NOW,
    async lockUser() {
      return true
    }
  })

  t.is(result.outcome, 'EXPIRED')
  t.is(result.verification, verification)
  t.is(result.purpose, EMAIL_VERIFICATION_PURPOSES.PRIMARY_CHANGE)
})

test('le statut d’envoi ne peut être modifié que par le jeton encore courant', async t => {
  let operation
  const client = {
    userEmailVerification: {
      async updateMany(value) {
        operation = value
        return {count: 1}
      },
      async findUnique() {
        return buildVerification({status: EMAIL_VERIFICATION_STATUSES.SEND_FAILED})
      }
    }
  }

  const result = await recordEmailVerificationDelivery(
    VERIFICATION_ID,
    'b'.repeat(64),
    false,
    {client, now: NOW}
  )

  t.deepEqual(operation.where, {
    id: VERIFICATION_ID,
    tokenHash: 'b'.repeat(64),
    status: EMAIL_VERIFICATION_STATUSES.PENDING
  })
  t.deepEqual(operation.data, {
    status: EMAIL_VERIFICATION_STATUSES.SEND_FAILED
  })
  t.is(result.status, EMAIL_VERIFICATION_STATUSES.SEND_FAILED)
})

test('la confirmation principale promeut un alias puis révoque seulement les connexions humaines', async t => {
  const targetAlias = {
    id: '44444444-4444-4444-8444-444444444444',
    userId: USER_ID,
    email: 'nouvelle@example.test',
    createdAt: NOW
  }
  const user = {...USER, emailAliases: [targetAlias]}
  const verification = buildVerification()
  const calls = []
  let verificationLookupCount = 0
  const transaction = {
    userEmailVerification: {
      async findUnique({select}) {
        verificationLookupCount++
        return select ? {id: VERIFICATION_ID, userId: USER_ID} : verification
      },
      async findFirst() {
        return null
      },
      async updateMany() {
        return {count: 0}
      },
      async update({data}) {
        calls.push(`verification:${data.status}`)
        return {...verification, ...data}
      }
    },
    user: {
      async findFirst({where}) {
        return where.id ? user : null
      },
      async update({data}) {
        calls.push(`user:${data.email}`)
      }
    },
    userEmailAlias: {
      async findUnique() {
        return targetAlias
      },
      async delete({where}) {
        calls.push(`alias:${where.id}`)
      }
    },
    declarant: {
      async findUnique() {
        return null
      }
    },
    authToken: {
      async deleteMany() {
        calls.push('auth-tokens')
        return {count: 2}
      }
    },
    passwordActivation: {
      async deleteMany() {
        calls.push('password-activations')
        return {count: 1}
      }
    },
    sessionToken: {
      async deleteMany({where}) {
        t.deepEqual(where, {
          OR: [
            {userId: USER_ID},
            {impersonatedByUserId: USER_ID}
          ]
        })
        calls.push('sessions')
        return {count: 3}
      }
    }
  }

  const result = await consumeEmailVerification('x'.repeat(43), {
    client: transactionClient(transaction),
    now: NOW,
    async lockUser() {
      return true
    }
  })

  t.is(verificationLookupCount, 2)
  t.is(result.outcome, 'VERIFIED')
  t.is(result.email, 'nouvelle@example.test')
  t.is(result.authTokensRevoked, 2)
  t.is(result.passwordActivationsRevoked, 1)
  t.is(result.sessionsRevoked, 3)
  t.deepEqual(result.securityNotificationRecipients, [USER.email])
  t.deepEqual(calls, [
    'verification:VERIFIED',
    `alias:${targetAlias.id}`,
    'user:nouvelle@example.test',
    'auth-tokens',
    'password-activations',
    'sessions'
  ])
})

test('la confirmation d’un alias ne révoque ni sessions ni magic links', async t => {
  const verification = buildVerification({
    purpose: EMAIL_VERIFICATION_PURPOSES.ALIAS_ADD
  })
  let createdAlias
  const transaction = {
    userEmailVerification: {
      async findUnique({select}) {
        return select ? {id: VERIFICATION_ID, userId: USER_ID} : verification
      },
      async findFirst() {
        return null
      },
      async updateMany() {
        return {count: 0}
      },
      async update({data}) {
        return {...verification, ...data}
      }
    },
    user: {
      async findFirst({where}) {
        return where.id ? USER : null
      }
    },
    userEmailAlias: {
      async findUnique() {
        return null
      },
      async create({data}) {
        createdAlias = data
      }
    }
  }

  const result = await consumeEmailVerification('y'.repeat(43), {
    client: transactionClient(transaction),
    now: NOW,
    async lockUser() {
      return true
    }
  })

  t.is(result.outcome, 'VERIFIED')
  t.like(createdAlias, {
    userId: USER_ID,
    email: 'nouvelle@example.test'
  })
  t.is(result.authTokensRevoked, 0)
  t.is(result.sessionsRevoked, 0)
})

test('la confirmation revalide le jeton après verrouillage', async t => {
  let lookupCount = 0
  const transaction = {
    userEmailVerification: {
      async findUnique() {
        lookupCount++
        return lookupCount === 1
          ? {id: VERIFICATION_ID, userId: USER_ID}
          : null
      }
    }
  }

  const result = await consumeEmailVerification('z'.repeat(43), {
    client: transactionClient(transaction),
    now: NOW,
    async lockUser() {
      return true
    }
  })

  t.deepEqual(result, {outcome: 'INVALID'})
  t.is(lookupCount, 2)
})

test('une confirmation vérifiée est rejouable sans répéter ses effets', async t => {
  const verification = buildVerification({
    status: EMAIL_VERIFICATION_STATUSES.VERIFIED,
    verifiedAt: NOW
  })
  let updates = 0
  const transaction = {
    user: {
      async findFirst() {
        return {...USER, email: verification.email}
      }
    },
    userEmailVerification: {
      async findUnique() {
        return verification
      },
      async update() {
        updates++
      }
    }
  }

  const result = await consumeEmailVerification('i'.repeat(43), {
    client: transactionClient(transaction),
    now: NOW,
    async lockUser() {
      return true
    }
  })

  t.is(result.outcome, 'VERIFIED')
  t.true(result.replayed)
  t.is(result.purpose, EMAIL_VERIFICATION_PURPOSES.PRIMARY_CHANGE)
  t.is(result.sessionsRevoked, 0)
  t.is(updates, 0)
})

test('une confirmation vérifiée ne rejoue pas un état ensuite remplacé', async t => {
  const verification = buildVerification({
    status: EMAIL_VERIFICATION_STATUSES.VERIFIED,
    verifiedAt: NOW
  })
  const transaction = {
    user: {
      async findFirst() {
        return {...USER, email: 'adresse-bo@example.test'}
      }
    },
    userEmailVerification: {
      async findUnique() {
        return verification
      }
    }
  }

  const result = await consumeEmailVerification('j'.repeat(43), {
    client: transactionClient(transaction),
    now: NOW,
    async lockUser() {
      return true
    }
  })

  t.deepEqual(result, {outcome: 'INVALID'})
})

test('la confirmation retente un conflit de sérialisation sans brûler le jeton', async t => {
  let attempts = 0
  const transaction = {
    userEmailVerification: {
      async findUnique() {
        return null
      }
    }
  }
  const client = {
    async $transaction(callback) {
      attempts++
      if (attempts < 3) {
        throw Object.assign(new Error('serialization'), {code: 'P2034'})
      }

      return callback(transaction)
    }
  }

  const result = await consumeEmailVerification('r'.repeat(43), {
    client,
    now: NOW
  })

  t.deepEqual(result, {outcome: 'INVALID'})
  t.is(attempts, 3)
})

test('la confirmation reste renvoyable après épuisement des retries sérialisables', async t => {
  let attempts = 0
  const client = {
    async $transaction() {
      attempts++
      throw Object.assign(new Error('serialization'), {code: '40001'})
    }
  }

  const error = await t.throwsAsync(consumeEmailVerification('s'.repeat(43), {
    client,
    now: NOW,
    serializationRetries: 1
  }))

  t.is(error.status, 503)
  t.is(attempts, 2)
})

test('une modification principale concurrente termine la demande en conflit', async t => {
  const verification = buildVerification()
  let userUpdated = false
  const transaction = {
    userEmailVerification: {
      async findUnique({select}) {
        return select ? {id: VERIFICATION_ID, userId: USER_ID} : verification
      },
      async update({data}) {
        return {...verification, ...data}
      }
    },
    user: {
      async findFirst() {
        return {...USER, email: 'admin@example.test'}
      },
      async update() {
        userUpdated = true
      }
    }
  }

  const result = await consumeEmailVerification('q'.repeat(43), {
    client: transactionClient(transaction),
    now: NOW,
    async lockUser() {
      return true
    }
  })

  t.is(result.outcome, 'CONFLICT')
  t.is(result.verification.status, EMAIL_VERIFICATION_STATUSES.CONFLICT)
  t.is(result.verification.tokenHash, null)
  t.false(userUpdated)
})

test('la synchronisation des contacts retire l’ancienne adresse et promeut la nouvelle', async t => {
  const operations = []
  const contacts = [
    {id: 'old', email: USER.email, isPrimary: true, createdAt: NOW},
    {id: 'target', email: 'nouvelle@example.test', isPrimary: false, createdAt: NOW},
    {id: 'other', email: 'autre@example.test', isPrimary: false, createdAt: NOW}
  ]
  const client = {
    declarant: {
      async findUnique() {
        return {userId: USER_ID}
      }
    },
    declarantContactEmail: {
      async findMany() {
        return contacts
      },
      async updateMany() {
        operations.push('demote')
      },
      async delete({where}) {
        operations.push(`delete:${where.id}`)
      },
      async update({where}) {
        operations.push(`promote:${where.id}`)
      }
    }
  }

  await synchronizeDeclarantPrimaryContactEmail(client, {
    userId: USER_ID,
    previousEmail: USER.email,
    newEmail: 'nouvelle@example.test'
  })

  t.deepEqual(operations, ['demote', 'delete:old', 'promote:target'])
})

test('la suppression du login retire son contact et conserve un destinataire principal', async t => {
  const operations = []
  const contacts = [
    {id: 'old', email: USER.email, isPrimary: true, createdAt: NOW},
    {
      id: 'other',
      email: 'autre@example.test',
      isPrimary: false,
      createdAt: new Date(NOW.getTime() + 1)
    }
  ]
  const client = {
    declarant: {
      async findUnique() {
        return {userId: USER_ID}
      }
    },
    declarantContactEmail: {
      async findMany() {
        return contacts
      },
      async updateMany() {
        operations.push('demote')
      },
      async delete({where}) {
        operations.push(`delete:${where.id}`)
      },
      async update({where}) {
        operations.push(`promote:${where.id}`)
      }
    }
  }

  await synchronizeDeclarantPrimaryContactEmail(client, {
    userId: USER_ID,
    previousEmail: USER.email,
    newEmail: null
  })

  t.deepEqual(operations, ['demote', 'delete:old', 'promote:other'])
})

test('à vingt contacts, la nouvelle adresse remplace l’ancien contact principal', async t => {
  const contacts = Array.from({length: 20}, (_, index) => ({
    id: `contact-${index}`,
    email: `contact-${index}@example.test`,
    isPrimary: index === 0,
    createdAt: new Date(NOW.getTime() + index)
  }))
  let deletedIds
  let createdData
  const client = {
    declarant: {
      async findUnique() {
        return {userId: USER_ID}
      }
    },
    declarantContactEmail: {
      async findMany() {
        return contacts
      },
      async updateMany() {},
      async deleteMany({where}) {
        deletedIds = where.id.in
      },
      async create({data}) {
        createdData = data
      }
    }
  }

  await synchronizeDeclarantPrimaryContactEmail(client, {
    userId: USER_ID,
    previousEmail: 'absente@example.test',
    newEmail: 'nouvelle@example.test'
  })

  t.deepEqual(deletedIds, ['contact-0'])
  t.like(createdData, {
    declarantUserId: USER_ID,
    email: 'nouvelle@example.test',
    isPrimary: true
  })
})
