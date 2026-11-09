import test from 'ava'
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import express from 'express'
import request from 'supertest'
import {prisma} from '../../../db/prisma.js'
import {createRoutes} from '../../routes.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {issueAuthTokenForLoginEmail} from '../../models/auth-token.js'
import {getSessionByToken, createSessionToken} from '../../models/session-token.js'
import {processAuthTokenVerification} from '../../handlers/auth.js'
import {setPreleveurEmail} from '../../models/preleveur-email.js'
import {resolveMagicLinkUser} from '../../models/preleveur-login.js'
import {issuePasswordActivation, getPasswordActivation, consumePasswordActivation, replacePasswordCredential} from '../../models/password-access.js'
import {selectAuthenticatedPreleveur, listAuthenticatedPreleveurs} from '../preleveur-profiles.js'
import {authenticateWithPassword} from '../password-auth.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
const prefix = `Profile identity ${randomUUID()}`
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => {
  if (enabled) await prisma.user.deleteMany({where: {firstName: prefix}})
  await prisma.$disconnect()
  await globalThis.pgPool?.end()
})

async function fixture() {
  const email = `${randomUUID()}@example.test`
  const person = (name, primary, legacy = null, establishment = {}) => prisma.user.create({data: {
    firstName: prefix, lastName: name, role: 'DECLARANT', email: legacy,
    declarant: {create: {declarantRole: 'PRELEVEUR', preleveurType: 'IRRIGANT', email: primary, ...establishment}}
  }, include: {declarant: true}})
  const anchor = await person('Premier', email, email)
  const second = await person('Deuxième', email, null, {socialReason: 'Ferme des Peupliers', siret: '12345678900013'})
  const outsider = await person('Autre', `${randomUUID()}@example.test`)
  return {email, anchor, second, outsider}
}

async function login(email) {
  const issued = await issueAuthTokenForLoginEmail(email)
  return processAuthTokenVerification(issued.authToken.token, {})
}

function app() {
  const server = express()
  server.use(express.json())
  const routes = createRoutes()
  server.use('/', routes)
  server.use('/api', routes)
  server.use((error, _req, res, _next) => res.status(error.status || error.statusCode || 500).send({message: error.message, data: error.data}))
  return server
}

integration('HTTP login requires a profile, rotates the token and applies only the selected profile rights', async t => {
  const f = await fixture()
  const initial = await login(f.email)
  t.true(initial.profileSelectionRequired)
  const server = app()
  const bearer = `Bearer ${initial.token}`
  const info = await request(server).get('/api/info').set('Authorization', bearer)
  t.is(info.status, 200)
  t.true(info.body.preleveurProfiles.selectionRequired)
  const pending = await request(server).get('/campaigns').set('Authorization', bearer)
  t.is(pending.status, 409)
  t.is(pending.body.data.code, 'PRELEVEUR_SELECTION_REQUIRED')
  const list = await request(server).get('/api/auth/preleveurs').set('Authorization', bearer)
  t.is(list.status, 200)
  t.deepEqual(list.body.preleveurs.map(row => row.id).sort(), [f.anchor.id, f.second.id].sort())
  t.like(list.body.preleveurs.find(row => row.id === f.second.id), {socialReason: 'Ferme des Peupliers', siret: '12345678900013'})
  t.is(list.body.preleveurs.find(row => row.id === f.anchor.id).siret, null)
  t.is(list.body.currentPreleveurId, null)
  const foreign = await request(server).post('/auth/preleveurs/select').set('Authorization', bearer).send({preleveurId: f.outsider.id})
  t.is(foreign.status, 403)
  const chosen = await request(server).post('/api/auth/preleveurs/select').set('Authorization', bearer).send({preleveurId: f.second.id})
  t.is(chosen.status, 200)
  t.not(chosen.body.token, initial.token)
  t.true(new Date(chosen.body.expiresAt) <= new Date(initial.expiresAt))
  t.is(await getSessionByToken(initial.token), null)
  const selectedBearer = `Bearer ${chosen.body.token}`
  const selectedInfo = await request(server).get('/info').set('Authorization', selectedBearer)
  t.is(selectedInfo.body.user.id, f.second.id)
  t.like(selectedInfo.body.user, {socialReason: 'Ferme des Peupliers', siret: '12345678900013'})
  t.false(selectedInfo.body.preleveurProfiles.canManageAccount)
  t.deepEqual(selectedInfo.body.user.emailAliases, [])
  t.is(selectedInfo.body.user.email, f.email)
  t.is((await request(server).get(`/declarants/${f.second.id}`).set('Authorization', selectedBearer)).status, 200)
  t.is((await request(server).get(`/declarants/${f.anchor.id}`).set('Authorization', selectedBearer)).status, 403)
  const security = await request(server).post('/users/me/email-change').set('Authorization', selectedBearer).send({email: 'unrelated@example.test'})
  t.is(security.status, 403)
  t.is(security.body.data.code, 'PRELEVEUR_ACCOUNT_CONTEXT_REQUIRED')
  t.is((await request(server).get('/users/me/email-aliases').set('Authorization', selectedBearer)).status, 403)
  t.is((await request(server).patch('/users/me/profile').set('Authorization', selectedBearer).send({firstName: 'Changed'})).status, 403)
  const restored = await selectAuthenticatedPreleveur(chosen.body.token, {preleveurId: f.anchor.id})
  t.is((await getSessionByToken(restored.token)).userId, f.anchor.id)
  const restoredInfo = await request(server).get('/info').set('Authorization', `Bearer ${restored.token}`)
  t.true(restoredInfo.body.preleveurProfiles.canManageAccount)
})

integration('changing or removing a principal revokes old tokens even if the same email is restored', async t => {
  const f = await fixture()
  const first = await login(f.email)
  const selected = await selectAuthenticatedPreleveur(first.token, {preleveurId: f.second.id})
  const pending = await issueAuthTokenForLoginEmail(f.email)
  await prisma.$transaction(tx => setPreleveurEmail(tx, {userId: f.second.id, email: null}))
  t.is(await getSessionByToken(selected.token), null)
  await prisma.$transaction(tx => setPreleveurEmail(tx, {userId: f.second.id, email: f.email}))
  t.is(await getSessionByToken(selected.token), null)
  await prisma.$transaction(tx => setPreleveurEmail(tx, {userId: f.anchor.id, email: 'changed@example.test'}))
  t.is((await t.throwsAsync(processAuthTokenVerification(pending.authToken.token, {}))).status, 401)
  const next = await login(f.email)
  const list = await listAuthenticatedPreleveurs(next.token)
  t.deepEqual(list.preleveurs.map(row => row.id), [f.second.id])
  t.false(list.selectionRequired)
})

integration('deactivation, foreign SQL targets and role changes never preserve shared access', async t => {
  const f = await fixture()
  const initial = await login(f.email)
  await t.throwsAsync(createSessionToken(f.anchor.id, 'DECLARANT', 3600, {authVersion: f.anchor.authVersion,
    loginEmail: f.email, profileUserId: f.outsider.id, profileAuthVersion: f.outsider.authVersion}))
  const chosen = await selectAuthenticatedPreleveur(initial.token, {preleveurId: f.second.id})
  await prisma.user.update({where: {id: f.second.id}, data: {deletedAt: new Date()}})
  t.is(await getSessionByToken(chosen.token), null)
  const fresh = await login(f.email)
  await prisma.declarant.update({where: {userId: f.anchor.id}, data: {declarantRole: 'COLLECTEUR', preleveurType: null}})
  t.is(await getSessionByToken(fresh.token), null)
})

integration('secondary contacts and privileged identities are never added to a shared login', async t => {
  const f = await fixture()
  const contactOnly = await prisma.user.create({data: {firstName: prefix, role: 'DECLARANT',
    declarant: {create: {declarantRole: 'PRELEVEUR', preleveurType: 'IRRIGANT', contactEmails: {create: {email: f.email, isPrimary: true}}}}}})
  const session = await login(f.email)
  const profiles = await listAuthenticatedPreleveurs(session.token)
  t.false(profiles.preleveurs.some(row => row.id === contactOnly.id))
  const privilegedEmail = `${randomUUID()}@example.test`
  const privileged = await prisma.user.create({data: {firstName: prefix, role: 'ADMIN', email: privilegedEmail}})
  await prisma.declarant.update({where: {userId: f.outsider.id}, data: {email: privilegedEmail}})
  const resolved = await resolveMagicLinkUser(privilegedEmail)
  t.is(resolved.id, privileged.id)
  t.falsy(resolved.loginEmail)
  const legacySession = await createSessionToken(privileged.id, 'ADMIN', 3600, {authVersion: privileged.authVersion})
  t.is((await t.throwsAsync(listAuthenticatedPreleveurs(legacySession.token))).status, 403)
})

integration('password login shares only the exact principal; legacy alias keeps one account', async t => {
  const f = await fixture()
  const options = {async findCredential() { return {passwordHash: 'synthetic', pepperVersion: 1} },
    async verify() { return {valid: true, needsRehash: false} }, async lockCredential() { return true }}
  const authenticated = await authenticateWithPassword(f.email, 'synthetic password', options)
  t.true(authenticated.session.profileSelectionRequired)
  const alias = `${randomUUID()}@example.test`
  await prisma.userEmailAlias.create({data: {userId: f.anchor.id, email: alias}})
  const legacy = await authenticateWithPassword(alias, 'synthetic password', options)
  t.falsy(legacy.session.profileSelectionRequired)
  t.is((await t.throwsAsync(listAuthenticatedPreleveurs(legacy.session.token))).status, 403)
})

integration('a single explicit principal without legacy login exposes no switch or account settings', async t => {
  const email = `${randomUUID()}@example.test`
  const owner = await prisma.user.create({data: {firstName: prefix, role: 'DECLARANT', email: null,
    declarant: {create: {declarantRole: 'PRELEVEUR', preleveurType: 'IRRIGANT', email}}}})
  const session = await login(email)
  t.false(session.profileSelectionRequired)
  const server = app()
  const bearer = `Bearer ${session.token}`
  const info = await request(server).get('/info').set('Authorization', bearer)
  t.is(info.status, 200)
  t.is(info.body.user.id, owner.id)
  t.is(info.body.user.email, email)
  t.deepEqual(info.body.preleveurProfiles, {enabled: true, canSwitch: false, selectionRequired: false, canManageAccount: false})
  t.is((await request(server).post('/users/me/email-change').set('Authorization', bearer).send({email: 'unrelated@example.test'})).status, 403)
})

integration('removing the principal prevents fresh login through the old canonical email until restored', async t => {
  const f = await fixture()
  const passwordOptions = {async findCredential() { return {passwordHash: 'synthetic', pepperVersion: 1} },
    async verify() { return {valid: true, needsRehash: false} }, async lockCredential() { return true }}
  const original = await login(f.email)
  await prisma.$transaction(tx => setPreleveurEmail(tx, {userId: f.anchor.id, email: null}))
  const remaining = await issueAuthTokenForLoginEmail(f.email)
  t.is(remaining.user.id, f.second.id)
  t.is((await authenticateWithPassword(f.email, 'synthetic password', passwordOptions)).session, null)
  await prisma.$transaction(tx => setPreleveurEmail(tx, {userId: f.second.id, email: null}))
  t.is(await issueAuthTokenForLoginEmail(f.email), null)
  t.is((await authenticateWithPassword(f.email, 'synthetic password', passwordOptions)).session, null)
  await prisma.$transaction(tx => setPreleveurEmail(tx, {userId: f.anchor.id, email: f.email}))
  const renewed = await login(f.email)
  t.false(renewed.profileSelectionRequired)
  t.is(await getSessionByToken(original.token), null)
  t.truthy((await authenticateWithPassword(f.email, 'synthetic password', passwordOptions)).session)
})

integration('rollout revokes only detached legacy tokens and preserves fresh explicit alias access', async t => {
  const f = await fixture()
  await prisma.$transaction(tx => setPreleveurEmail(tx, {userId: f.anchor.id, email: null}))
  await prisma.$transaction(tx => setPreleveurEmail(tx, {userId: f.second.id, email: null}))
  const owner = await prisma.user.findUniqueOrThrow({where: {id: f.anchor.id}})
  const oldSession = await createSessionToken(owner.id, 'DECLARANT', 3600, {authVersion: owner.authVersion})
  const oldLink = await prisma.authToken.create({data: {userId: owner.id, authVersion: owner.authVersion,
    token: randomUUID(), expiresAt: new Date('2099-01-01')}})
  const activation = await prisma.passwordActivation.create({data: {userId: owner.id, authVersion: owner.authVersion,
    tokenHash: randomUUID().replaceAll('-', '').repeat(2), expiresAt: new Date('2099-01-01')}})
  const alias = `${randomUUID()}@example.test`
  await prisma.userEmailAlias.create({data: {userId: owner.id, email: alias}})
  const aligned = await fixture()
  const alignedSession = await createSessionToken(aligned.anchor.id, 'DECLARANT', 3600, {authVersion: aligned.anchor.authVersion})
  const admin = await prisma.user.create({data: {firstName: prefix, role: 'ADMIN', email: `${randomUUID()}@example.test`}})
  const adminSession = await createSessionToken(admin.id, 'ADMIN', 3600, {authVersion: admin.authVersion})
  const sql = await readFile(new URL('../../../prisma/migrations/20261104153000_revoke_detached_preleveur_legacy_tokens/migration.sql', import.meta.url), 'utf8')
  await prisma.$transaction(async tx => {
    for (const statement of sql.split(';').filter(value => value.trim())) {
      // eslint-disable-next-line no-await-in-loop
      await tx.$executeRawUnsafe(statement)
    }
  })
  t.is(await getSessionByToken(oldSession.token), null)
  t.is(await prisma.authToken.findUnique({where: {id: oldLink.id}}), null)
  t.is(await prisma.passwordActivation.findUnique({where: {id: activation.id}}), null)
  t.truthy(await getSessionByToken(alignedSession.token))
  t.truthy(await getSessionByToken(adminSession.token))
  t.is(await issueAuthTokenForLoginEmail(f.email), null)
  const aliasLogin = await login(alias)
  t.is((await getSessionByToken(aliasLogin.token)).userId, owner.id)
  t.falsy(aliasLogin.profileSelectionRequired)
})

integration('password activation rejects detached canonicals and preserves profile scope on password change', async t => {
  const f = await fixture()
  const activation = await issuePasswordActivation(f.anchor.id)
  const credential = {passwordHash: 'synthetic credential', pepperVersion: 1}
  await prisma.$transaction(tx => setPreleveurEmail(tx, {userId: f.anchor.id, email: null}))
  t.is(await issuePasswordActivation(f.anchor.id), null)
  t.is(await getPasswordActivation(activation.token), null)
  t.is(await consumePasswordActivation(activation.token, credential), null)
  await prisma.$transaction(tx => setPreleveurEmail(tx, {userId: f.anchor.id, email: f.email}))
  t.is(await getPasswordActivation(activation.token), null)
  t.is(await consumePasswordActivation(activation.token, credential), null)
  const freshActivation = await issuePasswordActivation(f.anchor.id)
  const activated = await consumePasswordActivation(freshActivation.token, credential)
  t.true(activated.profileSelectionRequired)
  const selected = await selectAuthenticatedPreleveur(activated.token, {preleveurId: f.anchor.id})
  const replacementCredential = {passwordHash: 'synthetic replacement', pepperVersion: 1}
  const changed = await replacePasswordCredential(f.anchor, replacementCredential,
    {expectedCredential: credential, sessionToken: selected.token})
  const current = await getSessionByToken(changed.token)
  t.is(current.loginEmail, f.email)
  t.is(current.profileUserId, f.anchor.id)
  t.false(current.profileSelectionRequired)
  t.is(await getSessionByToken(selected.token), null)
})
