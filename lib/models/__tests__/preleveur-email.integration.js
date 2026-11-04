/* eslint-disable no-await-in-loop -- The migration and historical identities are checked sequentially in one disposable transaction. */
import test from 'ava'
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {insertDeclarant, getDeclarantById, updateDeclarantById} from '../declarant.js'
import {setPreleveurEmail, getPreleveurPrincipalEmail} from '../preleveur-email.js'
import {issueEmailVerification, consumeEmailVerification} from '../user-email-verification.js'
import {getPrimaryDeclarantContactEmail} from '../../services/declarant-contact-emails.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
const ids = []
const prefix = `Principal ${randomUUID()}`
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => {
  if (enabled) await prisma.user.deleteMany({where: {id: {in: ids}}})
  await prisma.$disconnect()
  await globalThis.pgPool?.end()
})

async function create(email, name = randomUUID()) {
  const result = await insertDeclarant({firstName: prefix, lastName: name, email, preleveurType: 'IRRIGANT'})
  ids.push(result.userId)
  return result
}

integration('migration initializes only real legacy logins, not imported or contact-only identities', async t => {
  const migration = await readFile(new URL('../../../prisma/migrations/20261104143000_add_declarant_principal_email/migration.sql', import.meta.url), 'utf8')
  const backfill = migration.slice(migration.indexOf('UPDATE "Declarant"'), migration.indexOf('CREATE INDEX')).trim()
  const rollback = new Error('Synthetic rollback')
  await t.throwsAsync(prisma.$transaction(async tx => {
    const logins = [`${randomUUID()}@example.test`, `${randomUUID()}@import.local`, null, `${randomUUID()}@example.test`]
    const profiles = []
    for (const [index, email] of logins.entries()) profiles.push(await tx.user.create({data: {role: 'DECLARANT', email,
      declarant: {create: {declarantRole: index === 3 ? 'COLLECTEUR' : 'PRELEVEUR', preleveurType: index === 3 ? null : 'IRRIGANT', contactEmails: {create: {
        email: `${randomUUID()}@example.test`, isPrimary: true
      }}}}}}))
    await tx.$executeRawUnsafe(backfill)
    for (let index = 0; index < profiles.length; index++) {
      const row = await tx.declarant.findUniqueOrThrow({where: {userId: profiles[index].id}})
      t.is(row.email, index === 0 ? logins[0] : null)
    }
    throw rollback
  }), {is: rollback})
})

integration('distinct preleveurs share a principal while legacy login remains unique', async t => {
  const email = `${randomUUID()}@example.test`
  const first = await create(email)
  const second = await create(email)
  t.is(first.email, email)
  t.is(second.email, null)
  t.is(first.principalEmail, email)
  t.is(second.principalEmail, email)
  t.is(first.user.email, email)
  t.is(second.user.email, null)
  t.is(await prisma.user.count({where: {email}}), 1)
  t.is(await prisma.declarant.count({where: {email}}), 2)
})

integration('principal edits preserve legacy login and contacts but revoke previous authentication', async t => {
  const existing = await create(`${randomUUID()}@example.test`)
  const alias = await prisma.userEmailAlias.create({data: {userId: existing.userId, email: `${randomUUID()}@example.test`}})
  const historical = await prisma.declarantContactEmail.create({data: {declarantUserId: existing.userId,
    email: `${randomUUID()}@example.test`, sourceId: `synthetic:${randomUUID()}`}})
  const token = await prisma.authToken.create({data: {userId: existing.userId, token: randomUUID(), expiresAt: new Date('2099-01-01')}})
  const before = await prisma.user.findUniqueOrThrow({where: {id: existing.userId}})
  const email = `${randomUUID()}@example.test`
  await prisma.$transaction(tx => setPreleveurEmail(tx, {userId: existing.userId, email}))
  let result = await getDeclarantById(existing.userId)
  t.is(result.principalEmail, email)
  t.is(result.email, before.email)
  await prisma.$transaction(tx => setPreleveurEmail(tx, {userId: existing.userId, email: null}))
  result = await getDeclarantById(existing.userId)
  t.is(result.principalEmail, null)
  t.is(result.email, before.email)
  t.is(getPrimaryDeclarantContactEmail(result), null)
  t.is(getPreleveurPrincipalEmail(await prisma.declarant.findUniqueOrThrow({where: {userId: existing.userId}})), null)
  t.deepEqual(await prisma.userEmailAlias.findUniqueOrThrow({where: {id: alias.id}}), alias)
  t.deepEqual(await prisma.declarantContactEmail.findUniqueOrThrow({where: {id: historical.id}}), historical)
  t.is(await prisma.authToken.findUnique({where: {id: token.id}}), null)
  const after = await prisma.user.findUniqueOrThrow({where: {id: existing.userId}})
  t.is(after.email, before.email)
  t.is(after.authVersion, before.authVersion + 2)
  t.is(await prisma.declarantContactEmail.count({where: {declarantUserId: existing.userId}}), 3)
  t.is(await prisma.declarantContactEmail.count({where: {declarantUserId: existing.userId, isPrimary: true}}), 0)
})

integration('confirmed canonical email synchronizes principal, preserves contacts and retains login revocation', async t => {
  const existing = await create(`${randomUUID()}@example.test`)
  const oldContact = await prisma.declarantContactEmail.findFirstOrThrow({where: {declarantUserId: existing.userId}})
  await prisma.authToken.create({data: {userId: existing.userId, token: randomUUID(), expiresAt: new Date('2099-01-01')}})
  const email = `${randomUUID()}@example.test`
  const verification = await issueEmailVerification(existing.userId, 'PRIMARY_CHANGE', email)
  const result = await consumeEmailVerification(verification.token)
  t.is(result.outcome, 'VERIFIED')
  t.is((await prisma.user.findUniqueOrThrow({where: {id: existing.userId}})).email, email)
  t.is((await getDeclarantById(existing.userId)).principalEmail, email)
  t.is(await prisma.authToken.count({where: {userId: existing.userId}}), 0)
  t.is((await prisma.declarantContactEmail.findUniqueOrThrow({where: {id: oldContact.id}})).email, oldContact.email)
  await updateDeclarantById(existing.userId, {email: null})
  t.is((await getDeclarantById(existing.userId)).principalEmail, null)
  t.is((await prisma.user.findUniqueOrThrow({where: {id: existing.userId}})).email, null)
})
