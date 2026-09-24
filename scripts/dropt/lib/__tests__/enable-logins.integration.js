import test from 'ava'
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import {prisma} from '../../../../db/prisma.js'
import {getAuthUserByEmail} from '../../../../lib/models/user.js'
import {requireDisposableDatabase} from '../../../../lib/util/test-helpers/disposable-database.js'
import {applyManifest} from '../apply-epidropt.js'
import {enableManifestLogins} from '../enable-logins.js'
import {digest, stableId} from '../epidropt.js'

const integration = process.env.DROPT_INTEGRATION_TESTS === '1' ? test.serial : test.skip
const owned = {users: new Set(), points: new Set(), exploitations: new Set()}
let databaseValidated = false

test.before(() => {
  if (process.env.DROPT_INTEGRATION_TESTS !== '1') return
  requireDisposableDatabase()
  databaseValidated = true
})

test.after.always(async () => {
  try {
    if (databaseValidated) {
      await prisma.$transaction(async tx => {
        const userId = {in: [...owned.users]}
        await tx.externalReference.deleteMany({where: {OR: [
          {declarantUserId: userId}, {pointPrelevementId: {in: [...owned.points]}}
        ]}})
        await tx.declarantPointPrelevement.deleteMany({where: {id: {in: [...owned.exploitations]}}})
        await tx.pointPrelevement.deleteMany({where: {id: {in: [...owned.points]}}})
        await tx.authToken.deleteMany({where: {userId}})
        await tx.sessionToken.deleteMany({where: {userId}})
        await tx.user.deleteMany({where: {id: userId}})
      })
    }
  } finally {
    await prisma.$disconnect()
    await globalThis.pgPool?.end()
  }
})

function sign(manifest) {
  const {manifestHash, ...payload} = manifest
  return {...payload, manifestHash: digest(payload)}
}

function fixture({cacg = false, emails} = {}) {
  const key = randomUUID()
  const pointId = stableId(`login-test-point:${key}`)
  const ownerId = stableId(`login-test-owner:${key}`)
  const exploitationId = stableId(`login-test-exploitation:${key}`)
  owned.points.add(pointId)
  owned.users.add(ownerId)
  owned.exploitations.add(exploitationId)
  return sign({formatVersion: 1, scope: 'epidropt', issues: [],
    points: [{id: pointId, key, sourceId: `dropt-epidropt:point:${key}`, coordinates: [0.4, 44.6],
      references: [{provider: 'epidropt', externalId: key}],
      data: {name: `${cacg ? 'CACG_' : 'NON_ALIMENTE_'}${key}`, flowType: 'PRELEVEMENT', waterBodyType: 'SUPERFICIELLE'}}],
    declarants: [{id: ownerId, key, sourceId: `dropt-epidropt:preleveur:${key}`,
      references: [{provider: 'epidropt', externalId: key}], emails: emails ?? [`${key}@example.test`],
      user: {role: 'DECLARANT', email: null},
      data: {socialReason: `Ferme test ${key}`, preleveurType: 'IRRIGANT', declarationNotificationsEnabled: false}}],
    exploitations: [{id: exploitationId, sourceId: `dropt-epidropt:exploitation:${key}`,
      pointId, declarantId: ownerId, usageCode: '2', aliases: []}],
    meters: [], allocations: []})
}

function merge(...manifests) {
  const merged = {...manifests[0]}
  for (const key of ['points', 'declarants', 'exploitations', 'meters', 'allocations']) {
    merged[key] = manifests.flatMap(manifest => manifest[key])
  }
  return sign(merged)
}

async function imported(t, manifest) {
  const result = await applyManifest(prisma, manifest, {apply: true})
  t.true(result.complete, JSON.stringify(result.executionIssues))
  return manifest
}

async function preview(manifest, options = {}) {
  return enableManifestLogins(prisma, manifest, {scope: 'non-realimente', ...options})
}

async function apply(manifest, options = {}) {
  const expectedReport = await preview(manifest, options)
  return enableManifestLogins(prisma, manifest, {scope: 'non-realimente', ...options, apply: true, expectedReport})
}

async function extraUser(data = {}) {
  const id = randomUUID()
  owned.users.add(id)
  return prisma.user.create({data: {id, role: 'DECLARANT', ...data}})
}

async function reserveEmail(userId, email) {
  return prisma.userEmailVerification.create({data: {
    userId, email, purpose: 'ALIAS_ADD', status: 'PENDING', lastAttemptedAt: new Date(),
    tokenHash: digest(randomUUID()), expiresAt: new Date(Date.now() + 86_400_000)
  }})
}

integration('simulation sans écriture, activation par email existant et rejeu sans nouvelle modification', async t => {
  const manifest = await imported(t, fixture())
  const {id, emails: [email]} = manifest.declarants[0]
  const initialUser = await prisma.user.findUnique({where: {id}})
  const initialContacts = await prisma.declarantContactEmail.findMany({where: {declarantUserId: id}})
  t.is(await getAuthUserByEmail(email), null)
  const dry = await preview(manifest)
  t.true(dry.complete)
  t.false(dry.applied)
  t.is(dry.operation, 'enable-logins')
  t.is(dry.scope, 'non-realimente')
  t.is(dry.counts.enabled, 1)
  t.deepEqual(await prisma.user.findUnique({where: {id}}), initialUser)
  const applied = await enableManifestLogins(prisma, manifest, {scope: 'non-realimente', apply: true, expectedReport: dry})
  t.true(applied.applied)
  const authenticated = await getAuthUserByEmail(email.toUpperCase())
  t.is(authenticated.id, id)
  t.is(authenticated.role, 'DECLARANT')
  t.true(authenticated.authVersion > initialUser.authVersion)
  t.deepEqual(await prisma.declarantContactEmail.findMany({where: {declarantUserId: id}}), initialContacts)
  t.false((await prisma.declarant.findUnique({where: {userId: id}})).declarationNotificationsEnabled)
  t.is(await prisma.authToken.count({where: {userId: id}}), 0)
  t.is(await prisma.sessionToken.count({where: {userId: id}}), 0)
  t.is((await prisma.user.findUnique({where: {id}})).accountCreationMailSentAt, null)
  const enabledUser = await prisma.user.findUnique({where: {id}})
  const replay = await apply(manifest)
  t.is(replay.counts.enabled, 0)
  t.is(replay.counts.unchanged, 1)
  t.deepEqual(await prisma.user.findUnique({where: {id}}), enabledUser)
  const referentialReplay = await applyManifest(prisma, manifest, {apply: true})
  t.true(referentialReplay.complete)
  t.deepEqual(await prisma.user.findUnique({where: {id}}), enabledUser)
  t.deepEqual(await prisma.declarantContactEmail.findMany({where: {declarantUserId: id}}), initialContacts)
  t.false((await prisma.declarant.findUnique({where: {userId: id}})).declarationNotificationsEnabled)
})

integration('le périmètre non réalimenté exclut les préleveurs uniquement CACG', async t => {
  const ordinary = fixture()
  const cacg = fixture({cacg: true})
  const manifest = await imported(t, merge(ordinary, cacg))
  const result = await apply(manifest)
  t.is(result.counts.selected, 1)
  t.is(result.counts.enabled, 1)
  t.is((await prisma.user.findUnique({where: {id: cacg.declarants[0].id}})).email, null)
  t.is((await preview(manifest, {scope: 'all'})).counts.selected, 2)
  t.is((await preview(manifest, {scope: 'all'})).counts.enabled, 1)
})

integration('la référence importée résout l’identité existante sans créer un deuxième compte', async t => {
  const original = await imported(t, fixture())
  const changed = structuredClone(original)
  changed.declarants[0].id = randomUUID()
  changed.exploitations[0].declarantId = changed.declarants[0].id
  const result = await apply(sign(changed))
  t.is(result.counts.enabled, 1)
  t.is((await getAuthUserByEmail(original.declarants[0].emails[0])).id, original.declarants[0].id)
  t.is(await prisma.user.count({where: {id: changed.declarants[0].id}}), 0)
})

integration('une adresse sans preuve de contact importé ne donne aucun accès', async t => {
  const manifest = await imported(t, fixture())
  const {id} = manifest.declarants[0]
  await prisma.declarantContactEmail.updateMany({where: {declarantUserId: id}, data: {sourceId: null}})
  const result = await apply(manifest)
  t.is(result.counts.blocked, 1)
  t.is(result.counts.enabled, 0)
  t.is((await prisma.user.findUnique({where: {id}})).email, null)
})

integration('absence, adresses multiples et adresse synthétique ne sont jamais choisies arbitrairement', async t => {
  const missing = fixture({emails: []})
  const multiple = fixture({emails: [`${randomUUID()}@example.test`, `${randomUUID()}@example.test`]})
  const synthetic = fixture({emails: [`${randomUUID()}@import.local`]})
  const manifest = await imported(t, merge(missing, multiple, synthetic))
  const result = await apply(manifest)
  t.is(result.counts.blocked, 3)
  t.is(result.counts.enabled, 0)
  t.is(await prisma.user.count({where: {id: {in: manifest.declarants.map(row => row.id)}, email: {not: null}}}), 0)
})

integration('les adresses multiples autorisées explicitement donnent accès au même compte, sans effets de simulation', async t => {
  const key = randomUUID()
  const emails = [`b-${key}@example.test`, `c-${key}@example.test`, `a-${key}@example.test`]
  const manifest = await imported(t, fixture({emails}))
  const {id} = manifest.declarants[0]
  const initialUser = await prisma.user.findUnique({where: {id}})
  const initialContacts = await prisma.declarantContactEmail.findMany({where: {declarantUserId: id}, orderBy: {email: 'asc'}})
  const expectedReport = await preview(manifest, {allowEmailAliases: true})
  const sorted = [...emails].sort()
  t.true(expectedReport.allowEmailAliases)
  t.is(expectedReport.counts.enabled, 1)
  t.is(expectedReport.counts.aliases, 2)
  t.is(expectedReport.entries[0].email, sorted[0])
  t.deepEqual(expectedReport.entries[0].emailAliases, sorted.slice(1))
  t.deepEqual(await prisma.user.findUnique({where: {id}}), initialUser)
  t.is(await prisma.userEmailAlias.count({where: {userId: id}}), 0)
  const applied = await enableManifestLogins(prisma, manifest, {
    scope: 'non-realimente', allowEmailAliases: true, apply: true, expectedReport
  })
  t.true(applied.applied)
  t.is((await prisma.user.findUnique({where: {id}})).email, sorted[0])
  const aliases = await prisma.userEmailAlias.findMany({where: {userId: id}, orderBy: {email: 'asc'}})
  t.deepEqual(aliases.map(alias => alias.email), sorted.slice(1))
  for (const email of emails) t.is((await getAuthUserByEmail(email.toUpperCase())).id, id)
  t.deepEqual(await prisma.declarantContactEmail.findMany({where: {declarantUserId: id}, orderBy: {email: 'asc'}}), initialContacts)
  t.is(await prisma.authToken.count({where: {userId: id}}), 0)
  t.is(await prisma.sessionToken.count({where: {userId: id}}), 0)
  t.false((await prisma.declarant.findUnique({where: {userId: id}})).declarationNotificationsEnabled)
  t.is((await prisma.user.findUnique({where: {id}})).accountCreationMailSentAt, null)
  const enabledUser = await prisma.user.findUnique({where: {id}})
  const replay = await apply(manifest, {allowEmailAliases: true})
  t.is(replay.counts.enabled, 0)
  t.is(replay.counts.aliases, 0)
  t.is(replay.counts.unchanged, 1)
  t.deepEqual(await prisma.user.findUnique({where: {id}}), enabledUser)
  t.deepEqual(await prisma.userEmailAlias.findMany({where: {userId: id}, orderBy: {email: 'asc'}}), aliases)
  t.true((await applyManifest(prisma, manifest, {apply: true})).complete)
  t.deepEqual(await prisma.user.findUnique({where: {id}}), enabledUser)
  t.deepEqual(await prisma.userEmailAlias.findMany({where: {userId: id}, orderBy: {email: 'asc'}}), aliases)
})

integration('un alias retiré manuellement n’est pas recréé lors du rejeu', async t => {
  const key = randomUUID()
  const emails = [`a-${key}@example.test`, `b-${key}@example.test`]
  const manifest = await imported(t, fixture({emails}))
  const {id} = manifest.declarants[0]
  await apply(manifest, {allowEmailAliases: true})
  await prisma.userEmailAlias.deleteMany({where: {userId: id}})
  const replay = await apply(manifest, {allowEmailAliases: true})
  t.is(replay.counts.enabled, 0)
  t.is(replay.counts.aliases, 0)
  t.is(await prisma.userEmailAlias.count({where: {userId: id}}), 0)
  t.is((await getAuthUserByEmail(emails[0])).id, id)
  t.is(await getAuthUserByEmail(emails[1]), null)
})

integration('un conflit sur un alias potentiel empêche aussi l’activation de l’adresse principale', async t => {
  const scenarios = ['primary', 'alias', 'verification', 'contact', 'unproven']
  for (const scenario of scenarios) {
    const key = randomUUID()
    const emails = [`a-${key}@example.test`, `b-${key}@example.test`]
    const manifest = await imported(t, fixture({emails}))
    const {id} = manifest.declarants[0]
    if (scenario === 'primary') await extraUser({email: emails[1]})
    if (scenario === 'alias') {
      const owner = await extraUser()
      await prisma.userEmailAlias.create({data: {userId: owner.id, email: emails[1]}})
    }
    if (scenario === 'verification') {
      const owner = await extraUser()
      await reserveEmail(owner.id, emails[1])
    }
    if (scenario === 'contact') {
      await extraUser({declarant: {create: {preleveurType: 'IRRIGANT', contactEmails: {create: {email: emails[1]}}}}})
    }
    if (scenario === 'unproven') {
      await prisma.declarantContactEmail.updateMany({where: {declarantUserId: id, email: emails[1]}, data: {sourceId: null}})
    }
    const result = await apply(manifest, {allowEmailAliases: true})
    t.is(result.counts.blocked, 1, scenario)
    t.is(result.counts.enabled, 0, scenario)
    t.is(result.counts.aliases, 0, scenario)
    t.is((await prisma.user.findUnique({where: {id}})).email, null, scenario)
    t.is(await prisma.userEmailAlias.count({where: {userId: id}}), 0, scenario)
  }
})

integration('l’autorisation des alias ne permet pas de partager un email source entre deux comptes', async t => {
  const key = randomUUID()
  const emails = [`a-${key}@example.test`, `b-${key}@example.test`]
  const manifest = await imported(t, merge(fixture({emails}), fixture({cacg: true, emails: [emails[1]]})))
  const result = await apply(manifest, {allowEmailAliases: true})
  t.is(result.counts.selected, 1)
  t.is(result.counts.blocked, 1)
  t.is(result.counts.enabled, 0)
  t.is(result.counts.aliases, 0)
  t.is(await getAuthUserByEmail(emails[0]), null)
  t.is(await getAuthUserByEmail(emails[1]), null)
})

integration('l’ajout d’alias exige une simulation portant sur cette même autorisation', async t => {
  const manifest = await imported(t, fixture())
  // A single email makes the account selection identical: the option itself
  // must still belong to the reviewed plan, not only the generated changes.
  const expectedReport = await preview(manifest)
  t.false(expectedReport.allowEmailAliases)
  await t.throwsAsync(() => enableManifestLogins(prisma, manifest, {
    scope: 'non-realimente', allowEmailAliases: true, apply: true, expectedReport
  }))
  t.is((await prisma.user.findUnique({where: {id: manifest.declarants[0].id}})).email, null)
})

integration('une adresse partagée dans le manifeste reste bloquée même si l’autre compte est hors périmètre', async t => {
  const email = `${randomUUID()}@example.test`
  const manifest = await imported(t, merge(fixture({emails: [email]}), fixture({cacg: true, emails: [email]})))
  const result = await apply(manifest)
  t.is(result.counts.selected, 1)
  t.is(result.counts.blocked, 1)
  t.is(result.counts.enabled, 0)
  t.is(await getAuthUserByEmail(email), null)
})

integration('un contact partagé avec un préleveur extérieur au manifeste ne donne aucun accès', async t => {
  const manifest = await imported(t, fixture())
  const email = manifest.declarants[0].emails[0]
  await extraUser({declarant: {create: {preleveurType: 'IRRIGANT', contactEmails: {create: {email}}}}})
  const result = await apply(manifest)
  t.is(result.counts.blocked, 1)
  t.is(result.counts.enabled, 0)
  t.is(await getAuthUserByEmail(email), null)
})

integration('un identifiant existant est inchangé ou préservé, sans remplacement de connexion', async t => {
  const same = fixture()
  const different = fixture()
  const manifest = await imported(t, merge(same, different))
  await prisma.user.update({where: {id: same.declarants[0].id}, data: {email: same.declarants[0].emails[0]}})
  const manualEmail = `${randomUUID()}@example.test`
  await prisma.user.update({where: {id: different.declarants[0].id}, data: {email: manualEmail}})
  const result = await apply(manifest)
  t.is(result.counts.unchanged, 1)
  t.is(result.counts.preserved, 1)
  t.is(result.counts.enabled, 0)
  t.is((await getAuthUserByEmail(manualEmail)).id, different.declarants[0].id)
  t.is(await getAuthUserByEmail(different.declarants[0].emails[0]), null)
})

integration('les identifiants principaux, alias et réservations d’autres comptes ne sont pas récupérés', async t => {
  const primary = fixture()
  const deleted = fixture()
  const alias = fixture()
  const pending = fixture()
  const manifest = await imported(t, merge(primary, deleted, alias, pending))
  await extraUser({email: primary.declarants[0].emails[0]})
  // Deleted declarants release their email through a trigger; deleted agents
  // can still hold a primary identity, which the importer must also respect.
  await extraUser({role: 'INSTRUCTOR', email: deleted.declarants[0].emails[0], deletedAt: new Date()})
  const aliasOwner = await extraUser()
  await prisma.userEmailAlias.create({data: {userId: aliasOwner.id, email: alias.declarants[0].emails[0]}})
  const verificationOwner = await extraUser()
  await reserveEmail(verificationOwner.id, pending.declarants[0].emails[0])
  const result = await apply(manifest)
  t.is(result.counts.blocked, 4, JSON.stringify(result.entries))
  t.is(result.counts.enabled, 0)
  t.is(await prisma.user.count({where: {id: {in: manifest.declarants.map(row => row.id)}, email: {not: null}}}), 0)
})

integration('les comptes supprimés et ceux ayant déjà une activité de connexion restent protégés', async t => {
  const items = Array.from({length: 9}, () => fixture())
  const manifest = await imported(t, merge(...items))
  const ids = items.map(item => item.declarants[0].id)
  await prisma.user.update({where: {id: ids[0]}, data: {deletedAt: new Date()}})
  await prisma.user.update({where: {id: ids[1]}, data: {lastLoginAt: new Date()}})
  await prisma.user.update({where: {id: ids[2]}, data: {authVersion: 1}})
  await prisma.userEmailAlias.create({data: {userId: ids[3], email: `${randomUUID()}@example.test`}})
  await reserveEmail(ids[4], `${randomUUID()}@example.test`)
  await prisma.passwordCredential.create({data: {userId: ids[5], passwordHash: 'synthetic-test-password-hash', pepperVersion: 1}})
  await prisma.authToken.create({data: {userId: ids[6], token: randomUUID(), expiresAt: new Date(Date.now() + 60_000)}})
  await prisma.sessionToken.create({data: {userId: ids[7], token: randomUUID(), role: 'DECLARANT', expiresAt: new Date(Date.now() + 60_000)}})
  await prisma.passwordActivation.create({data: {userId: ids[8], tokenHash: digest(randomUUID()), expiresAt: new Date(Date.now() + 60_000)}})
  const result = await apply(manifest)
  t.is(result.counts.blocked, 1)
  t.is(result.counts.preserved, 8)
  t.is(result.counts.enabled, 0)
})

integration('un identifiant supprimé manuellement ne sera pas réactivé au rejeu', async t => {
  const manifest = await imported(t, fixture())
  const {id} = manifest.declarants[0]
  await apply(manifest)
  await prisma.user.update({where: {id}, data: {email: null}})
  const result = await apply(manifest)
  t.is(result.counts.enabled, 0)
  t.is(result.counts.preserved, 1)
  t.is((await prisma.user.findUnique({where: {id}})).email, null)
  t.is(await getAuthUserByEmail(manifest.declarants[0].emails[0]), null)
})

integration('une exploitation ou un point supprimé ne suffit pas à autoriser une connexion', async t => {
  const missing = fixture()
  const deletedPoint = fixture()
  const manifest = await imported(t, merge(missing, deletedPoint))
  await prisma.declarantPointPrelevement.delete({where: {id: missing.exploitations[0].id}})
  await prisma.pointPrelevement.update({where: {id: deletedPoint.points[0].id}, data: {deletedAt: new Date()}})
  const result = await apply(manifest)
  t.is(result.counts.enabled, 0)
  t.is(await prisma.user.count({where: {id: {in: manifest.declarants.map(row => row.id)}, email: {not: null}}}), 0)
})

integration('un manifeste altéré et une application sans simulation sont refusés', async t => {
  const manifest = await imported(t, fixture())
  const altered = structuredClone(manifest)
  altered.declarants[0].emails = [`${randomUUID()}@example.test`]
  await t.throwsAsync(() => preview(altered))
  await t.throwsAsync(() => enableManifestLogins(prisma, manifest, {scope: 'non-realimente', apply: true}))
  t.is((await prisma.user.findUnique({where: {id: manifest.declarants[0].id}})).email, null)
})

integration('la dérive depuis la simulation annule tout le lot, même pour les autres comptes éligibles', async t => {
  const first = fixture()
  const second = fixture()
  const manifest = await imported(t, merge(first, second))
  const expectedReport = await preview(manifest)
  await prisma.user.update({where: {id: second.declarants[0].id}, data: {email: `${randomUUID()}@example.test`}})
  await t.throwsAsync(() => enableManifestLogins(prisma, manifest, {scope: 'non-realimente', apply: true, expectedReport}), {message: /DRY_RUN_STATE_CHANGED/})
  t.is((await prisma.user.findUnique({where: {id: first.declarants[0].id}})).email, null)
})

integration('une simulation d’un autre périmètre ne permet pas d’élargir implicitement l’application', async t => {
  const manifest = await imported(t, merge(fixture(), fixture({cacg: true})))
  const expectedReport = await preview(manifest)
  await t.throwsAsync(() => enableManifestLogins(prisma, manifest, {scope: 'all', apply: true, expectedReport}))
  t.is(await prisma.user.count({where: {id: {in: manifest.declarants.map(row => row.id)}, email: {not: null}}}), 0)
})
