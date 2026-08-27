import test from 'ava'

import {
  normalizeDeclarantContactEmails,
  replaceDeclarantContactEmails
} from '../declarant-contact-email.js'

const DECLARANT_ID = '11111111-1111-4111-8111-111111111111'

test('normalizeDeclarantContactEmails normalise et borne le principal', t => {
  t.deepEqual(normalizeDeclarantContactEmails([
    {email: ' PRINCIPAL@EXAMPLE.TEST ', isPrimary: true},
    {email: 'secondaire@example.test'}
  ]), [
    {email: 'principal@example.test', isPrimary: true},
    {email: 'secondaire@example.test', isPrimary: false}
  ])

  const error = t.throws(() => normalizeDeclarantContactEmails([
    {email: 'un@example.test', isPrimary: true},
    {email: 'deux@example.test', isPrimary: true}
  ]))

  t.is(error.status, 400)
})

test('normalizeDeclarantContactEmails refuse les doublons insensibles à la casse', t => {
  const error = t.throws(() => normalizeDeclarantContactEmails([
    {email: 'contact@example.test'},
    {email: 'CONTACT@example.test'}
  ]))

  t.is(error.status, 409)
})

test('normalizeDeclarantContactEmails refuse les adresses techniques d’import', t => {
  const error = t.throws(() => normalizeDeclarantContactEmails([
    {email: 'reunion-42@import.local', isPrimary: true}
  ]))

  t.is(error.status, 400)
  t.regex(error.message, /technique d’import/)
})

test('replaceDeclarantContactEmails crée seulement les nouveaux contacts dans une transaction', async t => {
  const operations = []
  const stored = []
  const tx = {
    async $queryRaw(query) {
      t.regex(query.strings.join(' '), /FOR UPDATE OF declarant/)
      return [{userId: DECLARANT_ID}]
    },
    declarantContactEmail: {
      async createMany({data}) {
        operations.push(['create', data])
        stored.push(...data)
      },
      async findMany() {
        operations.push(['read'])
        return stored.map(({id, email, isPrimary}) => ({id, email, isPrimary}))
      }
    }
  }
  const client = {
    async $transaction(callback, options) {
      t.is(options.isolationLevel, 'Serializable')
      return callback(tx)
    }
  }

  const result = await replaceDeclarantContactEmails(DECLARANT_ID, [
    {email: ' Contact@Example.test ', isPrimary: true}
  ], {client})

  t.deepEqual(operations.map(([operation]) => operation), ['read', 'create', 'read'])
  t.like(operations[1][1][0], {
    declarantUserId: DECLARANT_ID,
    email: 'contact@example.test',
    isPrimary: true
  })
  t.regex(operations[1][1][0].id, /^[\da-f-]{36}$/)
  t.is(result[0].email, 'contact@example.test')
})

test('replaceDeclarantContactEmails conserve les ids et sourceId lors d’un replay', async t => {
  const stored = [{
    id: 'contact-existing',
    declarantUserId: DECLARANT_ID,
    email: 'contact@example.test',
    isPrimary: true,
    sourceId: 'reunion:contact:42'
  }]
  let writeCount = 0
  const tx = {
    async $queryRaw() {
      return [{userId: DECLARANT_ID}]
    },
    declarantContactEmail: {
      async findMany() {
        return stored
      },
      async update() {
        writeCount += 1
      },
      async deleteMany() {
        writeCount += 1
      },
      async createMany() {
        writeCount += 1
      }
    }
  }
  const client = {
    async $transaction(callback) {
      return callback(tx)
    }
  }

  const result = await replaceDeclarantContactEmails(DECLARANT_ID, [{
    email: 'contact@example.test',
    isPrimary: true
  }], {client})

  t.is(writeCount, 0)
  t.is(result[0].id, 'contact-existing')
  t.is(stored[0].sourceId, 'reunion:contact:42')
})

test('replaceDeclarantContactEmails ne supprime rien si le déclarant est absent', async t => {
  let deleted = false
  const tx = {
    async $queryRaw() {
      return []
    },
    declarantContactEmail: {
      async deleteMany() {
        deleted = true
      }
    }
  }
  const client = {
    async $transaction(callback) {
      return callback(tx)
    }
  }

  const error = await t.throwsAsync(replaceDeclarantContactEmails(
    DECLARANT_ID,
    [],
    {client}
  ))

  t.is(error.status, 404)
  t.false(deleted)
})
