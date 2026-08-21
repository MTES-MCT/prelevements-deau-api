import test from 'ava'

import {
  createPasswordActivationForOperator,
  getDatabaseTarget,
  getFrontUrl
} from '../create-password-activation.js'

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'personne@example.test',
  role: 'DECLARANT'
}
const ENVIRONMENT = {
  AUTH_METHODS: 'password,magic_link',
  DATABASE_URL: 'postgresql://db-user:mot-de-passe@db.example.test:5433/base_demo?sslmode=verify-full',
  FRONT_URL: 'https://app.example.test/'
}

test('getDatabaseTarget n’expose jamais le mot de passe PostgreSQL', t => {
  const target = getDatabaseTarget(ENVIRONMENT.DATABASE_URL)

  t.deepEqual(target, {
    confirmation: 'db.example.test:5433/base_demo',
    host: 'db.example.test',
    port: '5433',
    database: 'base_demo',
    user: 'db-user'
  })
  t.false(JSON.stringify(target).includes('mot-de-passe'))
})

test('getFrontUrl exige une URL HTTP(S) explicite', t => {
  t.is(getFrontUrl('https://app.example.test/'), 'https://app.example.test')
  t.throws(() => getFrontUrl(undefined))
  t.throws(() => getFrontUrl('file:///tmp/demo'))
  t.throws(() => getFrontUrl('https://user:secret@app.example.test/'))
  t.throws(() => getFrontUrl('https://app.example.test/?token=secret'))
})

test('le premier passage affiche les deux cibles sans aucune mutation', async t => {
  const messages = []
  let issueCalls = 0

  const error = await t.throwsAsync(() => createPasswordActivationForOperator({
    args: ['--email=alias@example.test'],
    environment: ENVIRONMENT,
    async findUser() {
      return USER
    },
    async issueActivation() {
      issueCalls++
    },
    log(message) {
      messages.push(message)
    }
  }))

  t.is(issueCalls, 0)
  t.regex(error.message, /--confirm-target=db\.example\.test:5433\/base_demo/)
  t.true(error.message.includes(`--confirm-user=${USER.id}`))
  t.true(messages.some(message => message.includes(USER.id)))
  t.true(messages.some(message => message.includes(USER.email)))
  t.false(messages.join('\n').includes('mot-de-passe'))
})

test('le second passage ne crée le lien qu’avec les deux confirmations exactes', async t => {
  let issueCalls = 0
  const expiresAt = new Date('2026-08-24T12:00:00.000Z')
  const result = await createPasswordActivationForOperator({
    args: [
      '--email=personne@example.test',
      '--confirm-target=db.example.test:5433/base_demo',
      `--confirm-user=${USER.id}`
    ],
    environment: ENVIRONMENT,
    async findUser() {
      return USER
    },
    async issueActivation(userId) {
      issueCalls++
      t.is(userId, USER.id)
      return {
        token: 'activation-token',
        activation: {expiresAt}
      }
    },
    log() {}
  })

  t.is(issueCalls, 1)
  t.is(result.userId, USER.id)
  t.is(
    result.activationUrl,
    'https://app.example.test/activation-mot-de-passe#token=activation-token'
  )
  t.is(result.expiresAt, expiresAt)
})
