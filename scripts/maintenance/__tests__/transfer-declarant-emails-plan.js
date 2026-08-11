import test from 'ava'

import {
  buildTransferDeclarantEmailsPlan,
  parseTransferDeclarantEmailsOptions
} from '../transfer-declarant-emails-plan.js'

const SOURCE_ID = '11111111-1111-4111-8111-111111111111'
const TARGET_ID = '22222222-2222-4222-8222-222222222222'
const PRIMARY_EMAIL = 'accueil@cc-acvi.com'
const ALIASES = [
  'marion.galaup@cc-acvi.com',
  'melanie.lemesre@cc-acvi.com'
]
const NO_CREDENTIALS = Object.freeze({
  authTokens: 0,
  sessions: 0,
  serviceAccountTokens: 0
})
const SOURCE_CREDENTIALS = Object.freeze({
  authTokens: 1,
  sessions: 2,
  serviceAccountTokens: 3
})

function options(overrides = {}) {
  return {
    help: false,
    sourceId: SOURCE_ID,
    targetId: TARGET_ID,
    primaryEmail: PRIMARY_EMAIL,
    aliases: ALIASES,
    apply: false,
    rollback: false,
    ...overrides
  }
}

function user(id, {email, deletedAt, aliases = []}) {
  return {
    id,
    email,
    deletedAt,
    role: 'DECLARANT',
    declarant: {userId: id, declarantRole: 'PRELEVEUR'},
    emailAliases: aliases.map((alias, index) => ({
      id: `${id}-alias-${index}`,
      email: alias
    }))
  }
}

function snapshotOnSource(credentials = SOURCE_CREDENTIALS) {
  const source = user(SOURCE_ID, {
    email: PRIMARY_EMAIL,
    deletedAt: new Date('2026-08-10T12:00:00Z'),
    aliases: ALIASES
  })
  const target = user(TARGET_ID, {email: null, deletedAt: null})

  return {
    users: [source, target],
    addressUsers: [{id: SOURCE_ID, email: PRIMARY_EMAIL}],
    addressAliases: ALIASES.map((email, index) => ({
      id: source.emailAliases[index].id,
      userId: SOURCE_ID,
      email
    })),
    credentials
  }
}

function snapshotOnTarget(credentials = NO_CREDENTIALS) {
  const source = user(SOURCE_ID, {
    email: null,
    deletedAt: new Date('2026-08-10T12:00:00Z')
  })
  const target = user(TARGET_ID, {
    email: PRIMARY_EMAIL,
    deletedAt: null,
    aliases: ALIASES
  })

  return {
    users: [source, target],
    addressUsers: [{id: TARGET_ID, email: PRIMARY_EMAIL}],
    addressAliases: ALIASES.map((email, index) => ({
      id: target.emailAliases[index].id,
      userId: TARGET_ID,
      email
    })),
    credentials
  }
}

test('parse les arguments, normalise les emails et reste en dry-run par défaut', t => {
  const result = parseTransferDeclarantEmailsOptions([
    `--source-id=${SOURCE_ID}`,
    `--target-id=${TARGET_ID}`,
    '--primary-email= ACCUEIL@CC-ACVI.COM ',
    `--alias=${ALIASES[1]}`,
    `--alias=${ALIASES[0]}`
  ])

  t.deepEqual(result, options())
})

test('exige deux IDs distincts et des adresses sans doublon', t => {
  const base = [
    `--source-id=${SOURCE_ID}`,
    `--target-id=${SOURCE_ID}`,
    `--primary-email=${PRIMARY_EMAIL}`,
    `--alias=${ALIASES[0]}`
  ]

  t.throws(() => parseTransferDeclarantEmailsOptions(base), {
    message: 'Les identifiants source et cible doivent être différents.'
  })

  t.throws(() => parseTransferDeclarantEmailsOptions([
    `--source-id=${SOURCE_ID}`,
    `--target-id=${TARGET_ID}`,
    `--primary-email=${PRIMARY_EMAIL}`,
    `--alias=${ALIASES[0]}`,
    `--alias=${ALIASES[0].toUpperCase()}`
  ]), {message: 'Un alias a été fourni plusieurs fois.'})
})

test('le rollback reste une simulation tant que --apply n’est pas également fourni', t => {
  const arguments_ = [
    `--source-id=${SOURCE_ID}`,
    `--target-id=${TARGET_ID}`,
    `--primary-email=${PRIMARY_EMAIL}`,
    `--alias=${ALIASES[0]}`,
    '--rollback'
  ]
  const dryRun = parseTransferDeclarantEmailsOptions(arguments_)
  const apply = parseTransferDeclarantEmailsOptions([...arguments_, '--apply'])

  t.true(dryRun.rollback)
  t.false(dryRun.apply)
  t.true(apply.rollback)
  t.true(apply.apply)
})

test('planifie le transfert exact et la révocation des credentials', t => {
  const plan = buildTransferDeclarantEmailsPlan(snapshotOnSource(), options())

  t.like(plan, {
    detectedState: 'SOURCE',
    emailAction: 'TRANSFER',
    credentialsAction: 'REVOKE',
    noOp: false
  })
  t.is(plan.aliasIds.length, 2)
})

test('un transfert déjà appliqué reste idempotent et finit les révocations manquantes', t => {
  const pending = buildTransferDeclarantEmailsPlan(
    snapshotOnTarget({authTokens: 0, sessions: 1, serviceAccountTokens: 0}),
    options({apply: true})
  )
  const completed = buildTransferDeclarantEmailsPlan(
    snapshotOnTarget(),
    options({apply: true})
  )

  t.like(pending, {
    detectedState: 'TARGET',
    emailAction: 'NONE',
    credentialsAction: 'REVOKE',
    noOp: false
  })
  t.true(completed.noOp)
})

test('refuse tout état partiellement transféré', t => {
  const snapshot = snapshotOnSource()
  snapshot.addressAliases[0].userId = TARGET_ID
  snapshot.users[0].emailAliases = snapshot.users[0].emailAliases.slice(1)
  snapshot.users[1].emailAliases = [{
    id: snapshot.addressAliases[0].id,
    email: snapshot.addressAliases[0].email
  }]

  t.throws(() => buildTransferDeclarantEmailsPlan(snapshot, options()), {
    message: /État des adresses incohérent ou partiellement transféré/
  })
})

test('refuse de mélanger le transfert avec des alias déjà présents sur la cible', t => {
  const snapshot = snapshotOnSource()
  snapshot.users[1].emailAliases = [{
    id: 'target-existing-alias',
    email: 'autre@example.test'
  }]

  t.throws(() => buildTransferDeclarantEmailsPlan(snapshot, options()), {
    message: /État des adresses incohérent ou partiellement transféré/
  })
})

test('le rollback est symétrique pour les adresses et ne planifie pas de restauration des credentials', t => {
  const rollbackPlan = buildTransferDeclarantEmailsPlan(
    snapshotOnTarget(),
    options({rollback: true, apply: true})
  )
  const alreadyRolledBack = buildTransferDeclarantEmailsPlan(
    snapshotOnSource({authTokens: 0, sessions: 0, serviceAccountTokens: 0}),
    options({rollback: true, apply: true})
  )

  t.like(rollbackPlan, {
    detectedState: 'TARGET',
    emailAction: 'ROLLBACK',
    credentialsAction: 'NONE',
    noOp: false
  })
  t.true(alreadyRolledBack.noOp)
})
