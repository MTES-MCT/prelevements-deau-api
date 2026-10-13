import process from 'node:process'
import {createHash, randomUUID} from 'node:crypto'

import test from 'ava'

import {prisma} from '../../../db/prisma.js'
import {READ_ONLY_ZONE_PERMISSIONS, ZONE_PERMISSION_CODES} from '../../../lib/constants/zone-permissions.js'
import {requireDisposableDatabase} from '../../../lib/util/test-helpers/disposable-database.js'
import {syncAccess, verifyAccess} from '../lib/access-apply.js'

const enabled = process.env.REUNION_ACCESS_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
const owned = {users: new Set(), emails: new Set(), zones: new Set(), auditEvents: new Set()}
let validated = false
let zoneId

async function createZone(code, type = 'SAGE') {
  const id = randomUUID()
  await prisma.$executeRaw`INSERT INTO "Zone" (id, code, type, name, coordinates, "createdAt", "updatedAt")
    VALUES (${id}::uuid, ${code}, ${type}::"ZoneType", 'Zone synthétique accès',
      ST_GeomFromText('MULTIPOLYGON(((0 44,1 44,1 45,0 45,0 44)))',4326), NOW(), NOW())`
  owned.zones.add(id)
  return id
}

test.before(async () => {
  if (!enabled) return
  requireDisposableDatabase()
  validated = true
  const existing = await prisma.zone.findUnique({where: {type_code: {type: 'REGION', code: 'reg-04'}}})
  zoneId = existing?.id ?? await createZone('reg-04', 'REGION')
})

test.after.always(async () => {
  try {
    if (validated) {
      const users = await prisma.user.findMany({where: {OR: [
        {id: {in: [...owned.users]}}, {email: {in: [...owned.emails]}},
        {emailAliases: {some: {email: {in: [...owned.emails]}}}}
      ]}, select: {id: true}})
      const ids = [...new Set([...owned.users, ...users.map(user => user.id)])]
      await prisma.instructorZonePermissionAudit.deleteMany({where: {instructorUserId: {in: ids}}})
      await prisma.auditEvent.deleteMany({where: {id: {in: [...owned.auditEvents]}}})
      await prisma.user.deleteMany({where: {id: {in: ids}}})
      await prisma.zone.deleteMany({where: {id: {in: [...owned.zones]}}})
    }
  } finally {
    await prisma.$disconnect()
    await globalThis.pgPool?.end()
  }
})

function address() {
  const email = `${randomUUID()}@example.test`
  owned.emails.add(email)
  return email
}

function entry(overrides = {}) {
  return {row: 2, email: address(), firstName: 'Prénom synthétique', lastName: 'Nom synthétique',
    structure: 'Organisme synthétique', jobTitle: 'Agent', status: 'OPEN', role: 'INSTRUCTOR',
    permissions: [...READ_ONLY_ZONE_PERMISSIONS], startDate: '2026-01-01', endDate: null, isAdmin: false,
    ...overrides}
}

function source(entries) {
  return {sourceHash: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), effectiveDate: '2026-10-05', entries}
}

function mappings(input, declarants = [], writersAreZoneAdmins = false) {
  return {version: 1, sourceHash: input.sourceHash, writersAreZoneAdmins, declarants}
}

async function createUser(data) {
  const user = await prisma.user.create({data})
  owned.users.add(user.id)
  if (user.email) owned.emails.add(user.email)
  return user
}

async function instructor(email = address(), {otherZone = false, alias = false} = {}) {
  const user = await createUser({email, role: 'INSTRUCTOR', firstName: 'Ancien prénom',
    instructor: {create: {sourceId: `reunion:DEP-974:agent:${randomUUID()}`, jobTitle: 'Ancienne fonction'}}})
  const assignment = await prisma.instructorZone.create({data: {
    instructorUserId: user.id, zoneId, isAdmin: true, startDate: new Date('2020-01-01'),
    permissions: {create: ZONE_PERMISSION_CODES.map(permission => ({permission}))}
  }})
  if (otherZone) {
    const other = await createZone(randomUUID())
    await prisma.instructorZone.create({data: {instructorUserId: user.id, zoneId: other,
      startDate: new Date('2020-01-01'), permissions: {create: {permission: 'zone.detail.read'}}}})
  }

  if (alias) await prisma.userEmailAlias.create({data: {userId: user.id, email: address()}})
  return {...user, assignment}
}

async function declarant() {
  const sourceId = `reunion:DEP-974:declarant:${randomUUID()}`
  const user = await createUser({role: 'DECLARANT', email: null, declarant: {create: {
    sourceId, socialReason: 'Organisme synthétique', preleveurType: 'AUTRE', declarationNotificationsEnabled: false
  }}})
  return {...user, sourceId}
}

async function apply(input, options = {}) {
  const expectedReport = await syncAccess(prisma, input, {target: 'local', ...options})
  return syncAccess(prisma, input, {target: 'local', ...options, apply: true, expectedReport,
    onBeforeApply: options.onBeforeApply ?? (async () => {})})
}

async function retirement(user, reason = 'ABSENT_FROM_REGISTER', extra = {}) {
  const agent = await prisma.instructor.findUniqueOrThrow({where: {userId: user.id}})
  return {sourceId: agent.sourceId, email: user.email, reason, ...extra}
}

integration('simulation SQL sans effet puis création de droits avec vérification et rejeu immuable', async t => {
  const reader = entry()
  const writer = entry({permissions: [...ZONE_PERMISSION_CODES]})
  const input = source([reader, writer])
  const config = mappings(input, [], true)
  const dry = await syncAccess(prisma, input, {target: 'local', mappings: config})
  t.true(dry.complete)
  t.false(dry.applied)
  t.is(dry.counts.AGENT, 2)
  t.is(await prisma.user.count({where: {email: {in: [reader.email, writer.email]}}}), 0)
  let backup
  const applied = await syncAccess(prisma, input, {target: 'local', mappings: config, apply: true, expectedReport: dry,
    onBeforeApply: async value => {
      backup = value
      t.is(await prisma.user.count({where: {email: {in: [reader.email, writer.email]}}}), 0)
    }})
  t.true(applied.applied)
  t.is(backup.snapshot.users.length, 0)
  const users = await prisma.user.findMany({where: {email: {in: [reader.email, writer.email]}}, include: {
    instructor: {include: {instructorZones: {include: {permissions: true}}}}
  }})
  const read = users.find(user => user.email === reader.email)
  const write = users.find(user => user.email === writer.email)
  t.false(read.instructor.instructorZones[0].isAdmin)
  t.true(write.instructor.instructorZones[0].isAdmin)
  t.is(read.accountCreationMailSentAt, null)
  t.is(read.instructor.instructorZones[0].zoneAttachmentMailSentAt, null)
  t.true((await verifyAccess(prisma, input, {target: 'local', mappings: config, expectedReport: applied})).ok)
  const auditBefore = await prisma.instructorZonePermissionAudit.count({where: {instructorUserId: {in: users.map(user => user.id)}}})
  const replay = await apply(input, {mappings: config})
  t.is(replay.changes, 0)
  t.is(await prisma.instructorZonePermissionAudit.count({where: {instructorUserId: {in: users.map(user => user.id)}}}), auditBefore)
  t.true((await verifyAccess(prisma, input, {target: 'local', mappings: config, expectedReport: applied})).ok)
})

integration('changement de profil et droits dans la même opération sans altérer les autres zones', async t => {
  const user = await instructor(address(), {otherZone: true})
  const previousInstructor = await prisma.instructor.findUnique({where: {userId: user.id}})
  const others = await prisma.instructorZone.findMany({where: {instructorUserId: user.id, zoneId: {not: zoneId}}, include: {permissions: true}})
  const input = source([entry({email: user.email, jobTitle: 'Nouvelle fonction'})])
  const result = await apply(input)
  t.is(result.counts.AGENT, 1)
  const changed = await prisma.user.findUnique({where: {id: user.id}, include: {instructor: true}})
  t.is(changed.firstName, input.entries[0].firstName)
  t.is(changed.instructor.jobTitle, 'Nouvelle fonction')
  t.is(changed.instructor.sourceId, previousInstructor.sourceId)
  t.is(changed.authVersion, user.authVersion + 1)
  const assignment = await prisma.instructorZone.findUnique({where: {id: user.assignment.id}, include: {permissions: true}})
  t.false(assignment.isAdmin)
  t.deepEqual(assignment.permissions.map(item => item.permission).sort(), [...READ_ONLY_ZONE_PERMISSIONS].sort())
  t.deepEqual(await prisma.instructorZone.findMany({where: {instructorUserId: user.id, zoneId: {not: zoneId}}, include: {permissions: true}}), others)
  const blankJobTitle = source([{...input.entries[0], jobTitle: '', structure: 'Autre libellé structure'}])
  t.is((await apply(blankJobTitle)).changes, 0)
  t.is((await prisma.instructor.findUnique({where: {userId: user.id}})).jobTitle, 'Nouvelle fonction')
})

integration('retrait des seuls droits Réunion et invalidation des artefacts sans supprimer le compte', async t => {
  const user = await instructor(address(), {otherZone: true})
  await prisma.authToken.create({data: {userId: user.id, token: randomUUID(), expiresAt: new Date('2099-01-01')}})
  await prisma.sessionToken.create({data: {userId: user.id, role: 'INSTRUCTOR', token: randomUUID(), expiresAt: new Date('2099-01-01')}})
  const input = source([entry({email: user.email, status: 'REMOVE', role: null, permissions: [], endDate: '2026-09-30'})])
  const result = await apply(input)
  t.is(result.counts.CLOSE, 1)
  const updated = await prisma.user.findUniqueOrThrow({where: {id: user.id}})
  t.is(updated.email, user.email)
  t.is(updated.role, 'INSTRUCTOR')
  t.is(updated.deletedAt, null)
  t.is(updated.authVersion, user.authVersion + 1)
  t.is(await prisma.authToken.count({where: {userId: user.id}}), 0)
  t.is(await prisma.sessionToken.count({where: {userId: user.id}}), 0)
  const assignment = await prisma.instructorZone.findUnique({where: {id: user.assignment.id}, include: {permissions: true}})
  t.deepEqual(assignment.permissions, [])
  t.false(assignment.isAdmin)
  t.is(assignment.endDate.toISOString().slice(0, 10), '2026-09-30')
  t.is(await prisma.instructorZone.count({where: {instructorUserId: user.id}}), 2)
  const absent = source([entry({status: 'CLOSED', role: null, permissions: []})])
  t.is((await apply(absent)).changes, 0)
})

integration('mapping source stable et emails multiples vers un seul déclarant, contacts existants préservés', async t => {
  const user = await declarant()
  const previous = await prisma.declarantContactEmail.create({data: {declarantUserId: user.id,
    email: address(), isPrimary: true, sourceId: `reunion:DEP-974:contact:${randomUUID()}`}})
  const input = source([entry({role: 'DECLARANT', permissions: []}), entry({role: 'DECLARANT', permissions: []})])
  const config = mappings(input, [{structure: 'Organisme synthétique', sourceId: user.sourceId}])
  const dry = await syncAccess(prisma, input, {target: 'local', mappings: config})
  t.is((await prisma.user.findUnique({where: {id: user.id}})).email, null)
  t.is(dry.counts.PRIMARY, 1)
  t.is(dry.counts.ALIAS, 1)
  const applied = await apply(input, {mappings: config})
  const updated = await prisma.user.findUnique({where: {id: user.id}, include: {emailAliases: true, declarant: true}})
  t.is(updated.role, 'DECLARANT')
  t.deepEqual([updated.email, ...updated.emailAliases.map(item => item.email)].sort(), input.entries.map(item => item.email).sort())
  t.deepEqual(await prisma.declarantContactEmail.findUnique({where: {id: previous.id}}), previous)
  t.false(updated.declarant.declarationNotificationsEnabled)
  t.true((await verifyAccess(prisma, input, {target: 'local', mappings: config, expectedReport: applied})).ok)
  t.is((await apply(input, {mappings: config})).changes, 0)
})

integration('transfert explicite d’un ancien agent Réunion vers un alias, historique agent conservé', async t => {
  const donor = await instructor()
  const receiver = await declarant()
  await prisma.user.update({where: {id: receiver.id}, data: {email: address()}})
  const input = source([entry({email: donor.email, role: 'DECLARANT', permissions: []})])
  const config = mappings(input, [{structure: 'Organisme synthétique', sourceId: receiver.sourceId}])
  const applied = await apply(input, {mappings: config})
  t.is(applied.counts.RELEASE, 1)
  t.is(applied.counts.ALIAS, 1)
  const old = await prisma.user.findUniqueOrThrow({where: {id: donor.id}, include: {instructor: true}})
  t.is(old.email, null)
  t.is(old.role, 'INSTRUCTOR')
  t.truthy(old.instructor)
  t.is(old.deletedAt, null)
  const assignment = await prisma.instructorZone.findUnique({where: {id: donor.assignment.id}, include: {permissions: true}})
  t.is(assignment.endDate.toISOString().slice(0, 10), input.effectiveDate)
  t.deepEqual(assignment.permissions, [])
  t.is((await prisma.userEmailAlias.findUnique({where: {email: donor.email}})).userId, receiver.id)
  t.true((await verifyAccess(prisma, input, {target: 'local', mappings: config, expectedReport: applied})).ok)
  await prisma.instructorZone.update({where: {id: donor.assignment.id}, data: {isAdmin: true}})
  t.false((await verifyAccess(prisma, input, {target: 'local', mappings: config, expectedReport: applied})).ok)
})

integration('collision ADMIN bloque tout le lot y compris ses lignes valides', async t => {
  const admin = await createUser({email: address(), role: 'ADMIN'})
  const valid = entry()
  const input = source([valid, entry({email: admin.email})])
  const result = await syncAccess(prisma, input, {target: 'local'})
  t.true(result.blocked)
  t.true(result.issues.some(issue => issue.code === 'AGENT_ACCOUNT_INCOMPATIBLE'))
  t.is(await prisma.user.count({where: {email: valid.email}}), 0)
  t.is((await prisma.user.findUnique({where: {id: admin.id}})).role, 'ADMIN')
  const applied = await syncAccess(prisma, input, {target: 'local', apply: true, expectedReport: result, onBeforeApply: () => t.fail()})
  t.false(applied.applied)
  t.true(applied.blocked)
})

integration('conservation explicite d’un ADMIN écrivain et refus pour un ADMIN lecteur', async t => {
  const admin = await createUser({email: address(), role: 'ADMIN', firstName: 'Administrateur existant'})
  const input = source([entry({email: admin.email, permissions: [...ZONE_PERMISSION_CODES]})])
  const config = {...mappings(input), preserveGlobalAdmins: true}
  const applied = await apply(input, {mappings: config})
  t.false(applied.blocked)
  t.is(applied.changes, 0)
  t.deepEqual(applied.preservedGlobalAdmins, [{row: 2, userId: admin.id}])
  t.deepEqual(await prisma.user.findUnique({where: {id: admin.id}}), admin)
  t.is(await prisma.instructorZone.count({where: {instructorUserId: admin.id}}), 0)
  t.true((await verifyAccess(prisma, input, {target: 'local', mappings: config, expectedReport: applied})).ok)
  const reader = source([entry({email: admin.email})])
  const blocked = await syncAccess(prisma, reader, {target: 'local', mappings: {...mappings(reader), preserveGlobalAdmins: true}})
  t.true(blocked.blocked)
  t.true(blocked.issues.some(issue => issue.code === 'AGENT_ACCOUNT_INCOMPATIBLE'))
})

integration('un ancien agent Réunion sans zone peut libérer son email en conservant son historique', async t => {
  const donor = await instructor()
  await prisma.instructorZone.delete({where: {id: donor.assignment.id}})
  const recipient = await declarant()
  const input = source([entry({email: donor.email, role: 'DECLARANT', permissions: []})])
  const config = mappings(input, [{structure: 'Organisme synthétique', sourceId: recipient.sourceId}])
  const applied = await apply(input, {mappings: config})
  t.false(applied.blocked)
  t.is(applied.counts.RELEASE, 1)
  t.is((await prisma.user.findUnique({where: {id: donor.id}})).email, null)
  t.is((await prisma.user.findUnique({where: {id: recipient.id}})).email, donor.email)
  t.is(await prisma.instructorZone.count({where: {instructorUserId: donor.id}}), 0)
  t.is(await prisma.instructorZonePermissionAudit.count({where: {instructorUserId: donor.id}}), 0)
  t.true((await verifyAccess(prisma, input, {target: 'local', mappings: config, expectedReport: applied})).ok)
  const unrelated = await instructor()
  await prisma.instructorZone.delete({where: {id: unrelated.assignment.id}})
  await prisma.instructor.update({where: {userId: unrelated.id}, data: {sourceId: 'other:' + randomUUID()}})
  const deniedSource = source([entry({email: unrelated.email, role: 'DECLARANT', permissions: []})])
  const denied = await syncAccess(prisma, deniedSource, {target: 'local', mappings: mappings(deniedSource,
    [{structure: 'Organisme synthétique', sourceId: recipient.sourceId}])})
  t.true(denied.blocked)
  t.is((await prisma.user.findUnique({where: {id: unrelated.id}})).email, unrelated.email)
})

integration('la conservation ADMIN ne masque pas un email source modifié manuellement', async t => {
  const row = entry({permissions: [...ZONE_PERMISSION_CODES]})
  const input = source([row])
  await apply(input)
  const user = await prisma.user.findUniqueOrThrow({where: {email: row.email}})
  owned.users.add(user.id)
  const changedEmail = address()
  const changed = await prisma.user.update({where: {id: user.id}, data: {email: changedEmail, role: 'ADMIN'}})
  const config = {...mappings(input), preserveGlobalAdmins: true}
  const result = await syncAccess(prisma, input, {target: 'local', mappings: config})
  t.true(result.blocked)
  t.deepEqual(result.preservedGlobalAdmins, [])
  t.true(result.issues.some(issue => issue.code === 'AGENT_EMAIL_CHANGED_MANUALLY'))
  t.deepEqual(await prisma.user.findUnique({where: {id: user.id}}), changed)
  t.is(await prisma.user.count({where: {email: row.email}}), 0)
})

integration('mapping absent et réservation de vérification bloquent sans voler une adresse', async t => {
  const account = await declarant()
  const row = entry({role: 'DECLARANT', permissions: []})
  const input = source([row])
  const missing = await syncAccess(prisma, input, {target: 'local'})
  t.true(missing.issues.some(issue => issue.code === 'DECLARANT_MAPPING_MISSING'))
  const requester = await createUser({email: address(), role: 'DECLARANT', declarant: {create: {preleveurType: 'AUTRE'}}})
  await prisma.userEmailVerification.create({data: {userId: requester.id, purpose: 'ALIAS_ADD', status: 'PENDING',
    email: row.email, tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
    expiresAt: new Date('2099-01-01'), lastAttemptedAt: new Date('2026-10-01')}})
  const config = mappings(input, [{structure: row.structure, sourceId: account.sourceId}])
  const pending = await syncAccess(prisma, input, {target: 'local', mappings: config})
  t.true(pending.issues.some(issue => issue.code === 'EMAIL_VERIFICATION_PENDING'))
  t.is((await prisma.user.findUnique({where: {id: account.id}})).email, null)
  t.is((await prisma.userEmailVerification.findFirst({where: {email: row.email}})).status, 'PENDING')
})

integration('un autre territoire ou alias protège l’ancien agent contre un transfert', async t => {
  const recipient = await declarant()
  for (const restrictions of [{otherZone: true}, {alias: true}]) {
    const donor = await instructor(address(), restrictions)
    const input = source([entry({email: donor.email, role: 'DECLARANT', permissions: []})])
    const config = mappings(input, [{structure: 'Organisme synthétique', sourceId: recipient.sourceId}])
    const result = await syncAccess(prisma, input, {target: 'local', mappings: config})
    t.true(result.issues.some(issue => issue.code === 'EMAIL_OTHER_ACCOUNT_OR_DEPENDENCIES'))
    t.is((await prisma.user.findUnique({where: {id: donor.id}})).email, donor.email)
  }
})

integration('dérive d’état, source, mapping ou cible depuis la simulation empêche toute application', async t => {
  const user = await instructor()
  const input = source([entry({email: user.email})])
  const options = {target: 'local'}
  const expectedReport = await syncAccess(prisma, input, options)
  await prisma.user.update({where: {id: user.id}, data: {firstName: 'Modification concurrente'}})
  await t.throwsAsync(syncAccess(prisma, input, {...options, apply: true, expectedReport, onBeforeApply: () => t.fail()}), {message: /état ont changé/})
  t.is((await prisma.user.findUnique({where: {id: user.id}})).firstName, 'Modification concurrente')
  const fresh = await syncAccess(prisma, input, options)
  await t.throwsAsync(syncAccess(prisma, input, {...options, apply: true, expectedReport: {...fresh, target: 'testing'}, onBeforeApply: () => t.fail()}), {message: /Simulation compatible/})
  await t.throwsAsync(syncAccess(prisma, input, {...options, apply: true, mappings: mappings(input, [], true), expectedReport: fresh, onBeforeApply: () => t.fail()}), {message: /Simulation compatible/})
  await t.throwsAsync(syncAccess(prisma, input, {...options, apply: true, expectedReport: fresh}), {message: /Sauvegarde privée/})
})

integration('une erreur après libération d’email annule toute la transaction', async t => {
  const donor = await instructor()
  const recipient = await declarant()
  const input = source([entry({email: donor.email, role: 'DECLARANT', permissions: []})])
  const config = mappings(input, [{structure: 'Organisme synthétique', sourceId: recipient.sourceId}])
  const dry = await syncAccess(prisma, input, {target: 'local', mappings: config})
  const wrapped = {$transaction: (callback, options) => prisma.$transaction(transaction => callback(new Proxy(transaction, {
    get(target, key) {
      if (key === 'declarantContactEmail') return new Proxy(target[key], {get(delegate, operation) {
        if (operation === 'create') return async () => { throw new Error('Panne SQL synthétique') }
        return delegate[operation]
      }})
      return target[key]
    }
  })), options)}
  await t.throwsAsync(syncAccess(wrapped, input, {target: 'local', mappings: config, apply: true, expectedReport: dry, onBeforeApply: async () => {}}), {message: 'Panne SQL synthétique'})
  t.is((await prisma.user.findUnique({where: {id: donor.id}})).email, donor.email)
  t.is((await prisma.user.findUnique({where: {id: recipient.id}})).email, null)
  t.is((await prisma.instructorZone.findUnique({where: {id: donor.assignment.id}})).endDate, null)
})

integration('suppression physique bornée : simulation, audits conservés, activité comptée et rejeu sans nouvel audit', async t => {
  const user = await instructor()
  const untouched = await instructor()
  const input = source([])
  const config = {...mappings(input), retireAccounts: [await retirement(user)]}
  const alias = address()
  await prisma.userEmailAlias.create({data: {userId: user.id, email: alias}})
  await prisma.userMonthlyActivity.create({data: {userId: user.id, month: '2026-10', role: 'INSTRUCTOR'}})
  const token = randomUUID()
  await prisma.authToken.create({data: {userId: user.id, token, expiresAt: new Date('2099-01-01')}})
  await prisma.passwordCredential.create({data: {userId: user.id, passwordHash: 'synthetic-password-hash', pepperVersion: 1}})
  await prisma.sessionToken.create({data: {userId: untouched.id, role: 'INSTRUCTOR', token: randomUUID(),
    impersonatedByUserId: user.id, impersonatedByRole: 'INSTRUCTOR', expiresAt: new Date('2099-01-01')}})
  const previousAudit = await prisma.instructorZonePermissionAudit.create({data: {
    instructorZoneId: user.assignment.id, instructorUserId: user.id, zoneId, action: 'CREATED', after: {synthetic: true}
  }})
  const event = await prisma.auditEvent.create({data: {actorUserId: user.id, actorType: 'USER',
    actorLabel: 'Acteur synthétique', actionType: 'TEST', actionCategory: 'TEST', requestId: randomUUID(), httpMethod: 'POST', route: '/synthetic'}})
  owned.auditEvents.add(event.id)
  const dry = await syncAccess(prisma, input, {target: 'local', mappings: config})
  t.is(dry.counts.DELETE_ACCOUNT, 1)
  t.is(dry.plannedDeletedAccountMonthlyActivities, 1)
  t.is(dry.deletedAccountMonthlyActivities, 1)
  t.truthy(await prisma.user.findUnique({where: {id: user.id}}))
  t.is(await prisma.userMonthlyActivity.count({where: {userId: user.id}}), 1)
  t.is(await prisma.instructorZonePermissionAudit.count({where: {instructorUserId: user.id}}), 1)
  t.false(JSON.stringify(dry).includes(token))
  t.false(JSON.stringify(dry).includes('synthetic-password-hash'))
  const applied = await apply(input, {mappings: config})
  t.is(applied.retiredAccounts.length, 1)
  t.is(applied.deletedAccountMonthlyActivities, 1)
  t.is(await prisma.user.findUnique({where: {id: user.id}}), null)
  t.is(await prisma.instructor.findUnique({where: {userId: user.id}}), null)
  t.is(await prisma.instructorZone.findUnique({where: {id: user.assignment.id}}), null)
  t.is(await prisma.userMonthlyActivity.count({where: {userId: user.id}}), 0)
  t.is(await prisma.sessionToken.count({where: {impersonatedByUserId: user.id}}), 0)
  t.is(await prisma.userEmailIdentity.count({where: {OR: [{primaryUserId: user.id}, {aliasUserId: user.id}, {verificationUserId: user.id}]}}), 0)
  t.is((await prisma.instructorZonePermissionAudit.findUnique({where: {id: previousAudit.id}})).instructorZoneId, null)
  const receipt = await prisma.instructorZonePermissionAudit.findUnique({where: {id: applied.retiredAccounts[0].receiptId}})
  t.is(receipt.action, 'REMOVED')
  t.is(receipt.instructorZoneId, null)
  t.is(receipt.after.sourceId, config.retireAccounts[0].sourceId)
  t.is((await prisma.auditEvent.findUnique({where: {id: event.id}})).actorUserId, null)
  t.truthy(await prisma.user.findUnique({where: {id: untouched.id}}))
  t.true((await verifyAccess(prisma, input, {target: 'local', mappings: config, expectedReport: applied})).ok)
  const replay = await apply(input, {mappings: config})
  t.is(replay.changes, 0)
  t.is(replay.retiredAccounts.length, 0)
  t.is(await prisma.instructorZonePermissionAudit.count({where: {instructorUserId: user.id}}), 2)
})

integration('première application : transfert déclaré puis suppression du seul ancien agent sans zone', async t => {
  const donor = await instructor()
  await prisma.instructorZone.delete({where: {id: donor.assignment.id}})
  const recipient = await declarant()
  const row = entry({email: donor.email, role: 'DECLARANT', permissions: []})
  const input = source([row])
  const config = {...mappings(input, [{structure: row.structure, sourceId: recipient.sourceId}]),
    retireAccounts: [await retirement(donor, 'REPLACED', {row: row.row})]}
  const result = await apply(input, {mappings: config})
  t.is(result.counts.RELEASE, 1)
  t.is(result.counts.DELETE_ACCOUNT, 1)
  t.is(await prisma.user.findUnique({where: {id: donor.id}}), null)
  t.is((await prisma.user.findUnique({where: {id: recipient.id}})).email, donor.email)
  const receipts = await prisma.instructorZonePermissionAudit.findMany({where: {instructorUserId: donor.id}})
  t.is(receipts.length, 1)
  t.is(receipts[0].action, 'REMOVED')
  t.is(receipts[0].instructorZoneId, null)
  t.true((await verifyAccess(prisma, input, {target: 'local', mappings: config, expectedReport: result})).ok)
  t.is((await apply(input, {mappings: config})).changes, 0)
})

integration('retrait explicite fermé suivi d’une suppression sans recréation au rejeu', async t => {
  const user = await instructor()
  const row = entry({email: user.email, status: 'CLOSED', role: null, permissions: []})
  const input = source([row])
  const config = {...mappings(input), retireAccounts: [await retirement(user, 'CLOSED', {row: row.row})]}
  const result = await apply(input, {mappings: config})
  t.is(result.counts.DELETE_ACCOUNT, 1)
  t.is(await prisma.user.findUnique({where: {id: user.id}}), null)
  t.true((await verifyAccess(prisma, input, {target: 'local', mappings: config, expectedReport: result})).ok)
  t.is((await apply(input, {mappings: config})).changes, 0)
})

integration('suppression refuse ADMIN, déclarant, autre zone, export métier et agent source actif', async t => {
  for (const type of ['ADMIN', 'DECLARANT', 'OTHER_ZONE', 'EXPORT', 'ACTIVE_ALIAS']) {
    const user = await instructor(address(), {otherZone: type === 'OTHER_ZONE'})
    const item = await retirement(user)
    let entries = []
    if (type === 'ADMIN') await prisma.user.update({where: {id: user.id}, data: {role: 'ADMIN'}})
    if (type === 'DECLARANT') await prisma.user.update({where: {id: user.id}, data: {
      role: 'DECLARANT', declarant: {create: {preleveurType: 'AUTRE', sourceId: `reunion:DEP-974:declarant:${randomUUID()}`}}
    }})
    if (type === 'EXPORT') await prisma.dataExport.create({data: {requestedByUserId: user.id, requestedByRole: 'INSTRUCTOR'}})
    if (type === 'ACTIVE_ALIAS') {
      const alias = address()
      await prisma.userEmailAlias.create({data: {userId: user.id, email: alias}})
      entries = [entry({email: alias})]
    }

    const input = source(entries)
    const result = await syncAccess(prisma, input, {target: 'local', mappings: {...mappings(input), retireAccounts: [item]}})
    t.true(result.blocked, type)
    t.truthy(await prisma.user.findUnique({where: {id: user.id}}), type)
  }
})

integration('suppression refuse les acteurs métier sans FK et les activations émises pour autrui', async t => {
  const recipient = await declarant()
  for (const type of ['ZONE_ACTOR', 'PROCESSING_ACTOR', 'ACTIVATION_ISSUER']) {
    const user = await instructor()
    if (type === 'ZONE_ACTOR') await prisma.declarantZone.create({data: {declarantUserId: recipient.id, zoneId,
      source: 'MANUAL', createdByUserId: user.id}})
    if (type === 'PROCESSING_ACTOR') {
      await prisma.declaration.create({data: {code: randomUUID().slice(0, 6), type: 'TEST', waterWithdrawalType: 'TEST', declarantUserId: recipient.id,
        processingEvents: {create: {createdByUserId: user.id, status: 'CREATED'}}}})
    }

    if (type === 'ACTIVATION_ISSUER') await prisma.passwordActivation.create({data: {userId: recipient.id, createdByUserId: user.id,
      tokenHash: createHash('sha256').update(randomUUID()).digest('hex'), expiresAt: new Date('2099-01-01')}})
    const input = source([])
    const result = await syncAccess(prisma, input, {target: 'local', mappings: {...mappings(input), retireAccounts: [await retirement(user)]}})
    t.true(result.blocked)
    t.true(result.issues.some(issue => ['RETIRE_BUSINESS_ACTOR_DEPENDENCY', 'RETIRE_PASSWORD_ACTIVATION_ISSUER'].includes(issue.code)), type)
    t.truthy(await prisma.user.findUnique({where: {id: user.id}}))
  }
})

integration('identité absente ne supprime jamais un nouvel utilisateur portant son ancien email', async t => {
  const user = await instructor()
  const item = await retirement(user)
  await prisma.user.delete({where: {id: user.id}})
  const replacement = await instructor(user.email)
  const input = source([])
  const result = await syncAccess(prisma, input, {target: 'local', mappings: {...mappings(input), retireAccounts: [item]}})
  t.true(result.blocked)
  t.true(result.issues.some(issue => issue.code === 'RETIRE_EMAIL_IDENTITY_COLLISION'))
  t.truthy(await prisma.user.findUnique({where: {id: replacement.id}}))
})

integration('suppression garde état activité et périmètre exact de la simulation, puis annule toute erreur SQL', async t => {
  const user = await instructor()
  const input = source([])
  const config = {...mappings(input), retireAccounts: [await retirement(user)]}
  const dry = await syncAccess(prisma, input, {target: 'local', mappings: config})
  await prisma.userMonthlyActivity.create({data: {userId: user.id, month: '2026-10', role: 'INSTRUCTOR'}})
  await t.throwsAsync(syncAccess(prisma, input, {target: 'local', mappings: config, apply: true, expectedReport: dry, onBeforeApply: () => t.fail()}), {message: /état ont changé/})
  const fresh = await syncAccess(prisma, input, {target: 'local', mappings: config})
  const wrapped = {$transaction: (callback, options) => prisma.$transaction(transaction => callback(new Proxy(transaction, {
    get(target, key) {
      if (key === 'user') return new Proxy(target[key], {get(delegate, operation) {
        if (operation === 'deleteMany') return async () => { throw new Error('Panne suppression synthétique') }
        return delegate[operation]
      }})
      return target[key]
    }
  })), options)}
  await t.throwsAsync(syncAccess(wrapped, input, {target: 'local', mappings: config, apply: true, expectedReport: fresh, onBeforeApply: async () => {}}), {message: 'Panne suppression synthétique'})
  t.truthy(await prisma.user.findUnique({where: {id: user.id}}))
  t.is(await prisma.userMonthlyActivity.count({where: {userId: user.id}}), 1)
  t.is(await prisma.instructorZonePermissionAudit.count({where: {instructorUserId: user.id}}), 0)
  await t.throwsAsync(syncAccess(prisma, input, {target: 'local', mappings: {...config,
    retireAccounts: [{sourceId: 'access:DEP-974:agent:arbitrary', reason: 'ABSENT_FROM_REGISTER'}]}}), {message: /identité source Réunion/})
})
