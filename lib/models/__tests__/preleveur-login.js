import test from 'ava'
import {isPreleveurEmailIdentity, listPreleveurEmailProfiles, resolveMagicLinkUser, preleveurSessionOptions} from '../preleveur-login.js'

const email = 'shared@example.test'
const owner = {id: 'owner', email, role: 'DECLARANT', authVersion: 1,
  declarant: {declarantRole: 'PRELEVEUR', email}}
const second = {...owner, id: 'second', email: null}
function fixture(legacy = owner, profiles = [owner, second]) {
  const queries = []
  return {queries, client: {
    user: {async findFirst() { return legacy }, async findMany(query) { queries.push(query); return profiles }},
    userEmailAlias: {async findFirst() { return null }}
  }}
}

test('l’identité email exige un principal explicite et un préleveur actif', t => {
  t.true(isPreleveurEmailIdentity(owner, email))
  for (const user of [null, {...owner, deletedAt: new Date()}, {...owner, role: 'ADMIN'},
    {...owner, declarant: {declarantRole: 'COLLECTEUR', email}},
    {...owner, declarant: {declarantRole: 'PRELEVEUR', email: null, contactEmails: [{email, isPrimary: true}]}}]) {
    t.false(isPreleveurEmailIdentity(user, email))
  }
})

test('le lien sécurisé donne accès aux principaux partagés sans compte de connexion préalable', async t => {
  const {client, queries} = fixture(null)
  const candidate = await resolveMagicLinkUser(' SHARED@example.test ', {client})
  t.is(candidate.id, owner.id)
  t.is(candidate.loginEmail, email)
  t.deepEqual(queries[0].where, {role: 'DECLARANT', deletedAt: null, declarant: {declarantRole: 'PRELEVEUR', email}})
  t.deepEqual(await preleveurSessionOptions(owner, email, {client}), {
    loginEmail: email, profileUserId: owner.id, profileAuthVersion: 1, profileSelectionRequired: true
  })
})

test('les comptes privilégiés et alias restent monoprofil sans élargissement par email', async t => {
  const identities = [{...owner, role: 'ADMIN'}, {...owner, role: 'INSTRUCTOR'},
    {...owner, declarant: {declarantRole: 'COLLECTEUR', email}}, {...owner, email: 'primary@example.test'}]
  await Promise.all(identities.map(async legacy => {
    const {client, queries} = fixture(legacy)
    t.is(await resolveMagicLinkUser(email, {client}), legacy)
    t.is(queries.length, 0)
  }))
})

test('aucun secondaire ni adresse technique ne devient une identité de connexion', async t => {
  const {client, queries} = fixture(null, [])
  t.is(await resolveMagicLinkUser(email, {client}), null)
  t.deepEqual(await listPreleveurEmailProfiles('placeholder@import.local', {client}), [])
  t.is(queries.length, 1)
  t.deepEqual(await preleveurSessionOptions({...owner, declarant: {declarantRole: 'PRELEVEUR', email: null}}, email, {client}), {})
})

test('l’ancien email canonique ne permet pas de reprendre une fiche dont le principal a changé', async t => {
  const detached = {...owner, declarant: {...owner.declarant, email: null}}
  t.is(await resolveMagicLinkUser(email, {client: fixture(detached, []).client}), null)
  const resolved = await resolveMagicLinkUser(email, {client: fixture(detached, [second]).client})
  t.is(resolved.id, second.id)
  t.is(resolved.loginEmail, email)
})
