import {createHash} from 'node:crypto'

import {normalizeEmail} from '../../../lib/util/email.js'

import {
  getMissingPermissionDependencies,
  ZONE_PERMISSION_CODE_SET
} from '../../../lib/constants/zone-permissions.js'

const ACCESS_PREFIX = 'access:DEP-974'
const ACTIVE_VERIFICATIONS = ['PENDING', 'SEND_FAILED']
const RETIREMENT_REASONS = new Set(['REPLACED', 'CLOSED', 'ABSENT_FROM_REGISTER'])
const BUSINESS_DEPENDENCIES = ['dataExports', 'meterIngestions', 'collectionCampaignsCreated']
const USER_SELECT = {
  id: true, email: true, role: true, firstName: true, lastName: true,
  deletedAt: true, authVersion: true, updatedAt: true,
  emailAliases: {select: {id: true, email: true}, orderBy: {email: 'asc'}},
  emailVerifications: {
    where: {status: {in: ACTIVE_VERIFICATIONS}},
    select: {id: true, email: true, status: true}, orderBy: {id: 'asc'}
  },
  instructor: {select: {
    sourceId: true, jobTitle: true, phoneNumber: true,
    instructorZones: {orderBy: {zoneId: 'asc'}, select: {
      id: true, zoneId: true, isAdmin: true, startDate: true, endDate: true,
      permissions: {select: {permission: true}, orderBy: {permission: 'asc'}}
    }},
    _count: {select: {instructedChunks: true}}
  }},
  declarant: {select: {
    sourceId: true, declarantRole: true,
    contactEmails: {select: {id: true, email: true, isPrimary: true, sourceId: true}, orderBy: {email: 'asc'}}
  }},
  passwordCredential: {select: {userId: true}},
  passwordActivation: {select: {userId: true}},
  _count: {select: {
    dataExports: true, meterIngestions: true, collectionCampaignsCreated: true,
    monthlyActivities: true, passwordActivationsIssued: true,
    authTokens: true, sessionTokens: true, emailVerifications: true,
    auditEventsAsActor: true, auditEventsEffective: true, auditEventsAsSubject: true
  }}
}

function canonical(value) {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  }

  return value
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function same(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function emailKey(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : null
}

function dateKey(value) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('Date d’habilitation invalide.')
  return date.toISOString().slice(0, 10)
}

function agentSourceId(email) {
  return `${ACCESS_PREFIX}:agent:${digest(email)}`
}

function validateMappings(mappings, sourceHash) {
  if (mappings.version !== 1 || mappings.sourceHash !== sourceHash
    || typeof mappings.writersAreZoneAdmins !== 'boolean' || !Array.isArray(mappings.declarants)
    || (mappings.preserveGlobalAdmins !== undefined && typeof mappings.preserveGlobalAdmins !== 'boolean')) {
    throw new Error('Mapping d’accès invalide ou associé à une autre source.')
  }

  const declarants = new Map()
  for (const mapping of mappings.declarants) {
    if (!mapping.structure?.trim() || !mapping.sourceId?.trim() || declarants.has(mapping.structure)) {
      throw new Error('Chaque structure doit avoir un mapping sourceId unique et explicite.')
    }

    declarants.set(mapping.structure, mapping.sourceId)
  }

  return declarants
}

function normalizeRetirements(mappings) {
  if (mappings.retireAccounts === undefined) return []
  if (!Array.isArray(mappings.retireAccounts)) throw new Error('La liste de comptes à supprimer doit être explicite.')
  const sourceIds = new Set()
  return mappings.retireAccounts.map(item => {
    if (!/^reunion:DEP-974:agent:[a-zA-Z\d_-]+$/.test(item?.sourceId ?? '')
      || !RETIREMENT_REASONS.has(item.reason) || sourceIds.has(item.sourceId)
      || (item.row !== undefined && (!Number.isInteger(item.row) || item.row < 1))) {
      throw new Error('Retrait de compte invalide : identité source Réunion unique et motif explicite requis.')
    }

    sourceIds.add(item.sourceId)
    return {...item, email: item.email == null ? null : normalizeEmail(item.email)}
  }).sort((a, b) => a.sourceId.localeCompare(b.sourceId))
}

function normalizeInputs(source, options) {
  if (!source || !/^[a-f\d]{64}$/i.test(source.sourceHash ?? '') || !Array.isArray(source.entries)) {
    throw new Error('Source d’accès et empreinte SHA-256 obligatoires.')
  }

  if (!['local', 'testing', 'prod'].includes(options.target)) throw new Error('Cible d’accès explicite obligatoire.')
  const zone = options.zone ?? {type: 'REGION', code: 'reg-04'}
  if (zone.type !== 'REGION' || zone.code !== 'reg-04') throw new Error('Ce composant est limité aux accès Réunion reg-04.')
  const effectiveDate = dateKey(source.effectiveDate)
  if (!effectiveDate) throw new Error('Date d’effet stable obligatoire.')
  const mappings = options.mappings ?? {version: 1, sourceHash: source.sourceHash, writersAreZoneAdmins: false, declarants: []}
  const declarants = validateMappings(mappings, source.sourceHash)

  const emails = new Set()
  const entries = source.entries.map(entry => {
    const email = normalizeEmail(entry.email)
    if (emails.has(email)) {
      throw new Error('Adresse source invalide ou répétée dans le périmètre d’accès.')
    }

    emails.add(email)
    if (!['OPEN', 'REMOVE', 'CLOSED'].includes(entry.status)
      || (entry.status === 'OPEN' && !['INSTRUCTOR', 'DECLARANT'].includes(entry.role))) {
      throw new Error('Statut ou rôle source non pris en charge.')
    }

    const permissions = [...new Set(entry.permissions ?? [])].sort()
    if (permissions.some(code => !ZONE_PERMISSION_CODE_SET.has(code)) || getMissingPermissionDependencies(permissions).length) {
      throw new Error('Droits inconnus ou dépendances de permissions manquantes.')
    }

    if (entry.status === 'OPEN' && entry.role === 'INSTRUCTOR' && permissions.length === 0) {
      throw new Error('Un agent ouvert doit recevoir des permissions explicites.')
    }

    const startDate = dateKey(entry.startDate) ?? effectiveDate
    const endDate = dateKey(entry.endDate) ?? (entry.status === 'OPEN' ? null : effectiveDate)
    if (entry.status === 'OPEN' && endDate && endDate < startDate) throw new Error('Période d’habilitation incohérente.')
    return {...entry, email, permissions, startDate, endDate}
  }).sort((a, b) => a.email.localeCompare(b.email))
  return {sourceHash: source.sourceHash, effectiveDate, entries, mappings, mappingsHash: digest(mappings), declarants,
    retireAccounts: normalizeRetirements(mappings), zone, target: options.target}
}

async function snapshotState(transaction, inputs, extraUserIds = []) {
  const emails = [...new Set([...inputs.entries.map(entry => entry.email), ...inputs.retireAccounts.map(item => item.email).filter(Boolean)])]
  const retirementSourceIds = inputs.retireAccounts.map(item => item.sourceId)
  const sourceIds = [...inputs.declarants.values()]
  const zone = await transaction.zone.findUnique({where: {type_code: inputs.zone}, select: {id: true, type: true, code: true}})
  const users = await transaction.user.findMany({where: {OR: [
    {email: {in: emails}}, {emailAliases: {some: {email: {in: emails}}}},
    {instructor: {sourceId: {in: [...emails.map(agentSourceId), ...retirementSourceIds]}}},
    {declarant: {sourceId: {in: sourceIds}}}, {id: {in: extraUserIds}}
  ]}, select: USER_SELECT, orderBy: {id: 'asc'}})
  const retirementUserIds = users.filter(user => retirementSourceIds.includes(user.instructor?.sourceId)).map(user => user.id)
  const nonRelationalDependencies = await snapshotNonRelationalDependencies(transaction, retirementUserIds)
  const verifications = await transaction.userEmailVerification.findMany({where: {email: {in: emails}, status: {in: ACTIVE_VERIFICATIONS}},
    select: {id: true, userId: true, email: true, status: true}, orderBy: {id: 'asc'}})
  const identities = await transaction.userEmailIdentity.findMany({where: {email: {in: emails}},
    select: {email: true, primaryUserId: true, aliasUserId: true, verificationUserId: true}, orderBy: {email: 'asc'}})
  const retirementReceipts = retirementSourceIds.length ? await transaction.instructorZonePermissionAudit.findMany({where: {
    action: 'REMOVED', zoneId: zone?.id,
    AND: [{after: {path: ['operation'], equals: 'retire-access-account'}}, {
      OR: retirementSourceIds.map(sourceId => ({after: {path: ['sourceId'], equals: sourceId}}))
    }]
  }, select: {id: true, instructorUserId: true, after: true}, orderBy: {id: 'asc'}}) : []
  return {zone, users, verifications, identities, retirementReceipts, nonRelationalDependencies}
}

async function snapshotNonRelationalDependencies(transaction, userIds) {
  if (!userIds.length) return []
  const processing = await transaction.declarationProcessingEvent.groupBy({by: ['createdByUserId'],
    where: {createdByUserId: {in: userIds}}, _count: {_all: true}})
  const assignments = await transaction.declarantZone.groupBy({by: ['createdByUserId'],
    where: {createdByUserId: {in: userIds}}, _count: {_all: true}})
  return [...userIds].sort().map(userId => ({userId,
    declarationProcessingEvents: processing.find(item => item.createdByUserId === userId)?._count._all ?? 0,
    declarantZonesCreated: assignments.find(item => item.createdByUserId === userId)?._count._all ?? 0
  }))
}

async function lockRetirementScope(transaction, inputs) {
  if (!inputs.retireAccounts.length) return
  // Ces deux références acteur ne disposent pas de FK. Le verrou empêche
  // une nouvelle référence concurrente entre leur lecture et le DELETE.
  await transaction.$executeRawUnsafe('LOCK TABLE "DeclarationProcessingEvent", "DeclarantZone" IN SHARE MODE')
  const sourceIds = inputs.retireAccounts.map(item => item.sourceId)
  const placeholders = sourceIds.map((_, index) => `$${index + 1}`).join(', ')
  await transaction.$queryRawUnsafe(`SELECT u.id FROM "User" u
    JOIN "Instructor" i ON i."userId" = u.id WHERE i."sourceId" IN (${placeholders})
    ORDER BY u.id FOR UPDATE OF u, i`, ...sourceIds)
}

function expectedZone(entry, inputs, existing) {
  if (entry.status !== 'OPEN') {
    return {
      isAdmin: false,
      startDate: dateKey(existing.startDate),
      endDate: entry.endDate,
      permissions: []
    }
  }

  return {
    isAdmin: inputs.mappings.writersAreZoneAdmins && entry.permissions.includes('pp.update'),
    startDate: entry.startDate,
    endDate: entry.endDate,
    permissions: entry.permissions
  }
}

function zoneState(zone) {
  return zone ? {
    isAdmin: zone.isAdmin,
    startDate: dateKey(zone.startDate),
    endDate: dateKey(zone.endDate),
    permissions: zone.permissions.map(item => item.permission).sort()
  } : null
}

function profileChanges(user, entry) {
  const data = {}
  for (const field of ['firstName', 'lastName']) {
    const value = entry[field]?.trim()
    if (value && user?.[field] !== value) data[field] = value
  }

  const jobTitle = entry.jobTitle?.trim() || (!user ? entry.structure?.trim() : undefined)
  const instructor = jobTitle && user?.instructor?.jobTitle !== jobTitle ? {jobTitle} : {}
  return {user: data, instructor}
}

function ownersForEmail(state, email) {
  return state.users.filter(user => emailKey(user.email) === email || user.emailAliases.some(alias => emailKey(alias.email) === email))
}

function addIssue(plan, entry, code) {
  plan.issues.push({row: entry.row, email: entry.email, code})
}

function checkReservation(plan, state, entry, owner) {
  if (state.verifications.some(item => emailKey(item.email) === entry.email)) {
    addIssue(plan, entry, 'EMAIL_VERIFICATION_PENDING')
    return false
  }

  const identity = state.identities.find(item => emailKey(item.email) === entry.email)
  if (identity && (identity.verificationUserId
    || [identity.primaryUserId, identity.aliasUserId].some(id => id && id !== owner?.id))) {
    addIssue(plan, entry, 'EMAIL_IDENTITY_RESERVED')
    return false
  }

  return true
}

function agentIsIncompatible(user) {
  return user && (user.role !== 'INSTRUCTOR' || user.deletedAt || !user.instructor || user.declarant)
}

function preserveGlobalAdmin(context, entry, user) {
  if (user?.role !== 'ADMIN' || user.deletedAt || !context.inputs.mappings.preserveGlobalAdmins
    || !entry.permissions.includes('pp.update')) return false
  context.plan.preservedGlobalAdmins.push({row: entry.row, userId: user.id})
  return true
}

function planAgent(context, entry, owner) {
  const {plan, state, inputs, seenAgents} = context
  const bySource = state.users.find(user => user.instructor?.sourceId === agentSourceId(entry.email))
  if (owner && bySource && owner.id !== bySource.id) return addIssue(plan, entry, 'AGENT_IDENTITY_AMBIGUOUS')
  const user = owner ?? bySource
  if (user && !owner) return addIssue(plan, entry, 'AGENT_EMAIL_CHANGED_MANUALLY')
  if (preserveGlobalAdmin(context, entry, user)) return
  if (agentIsIncompatible(user)) return addIssue(plan, entry, 'AGENT_ACCOUNT_INCOMPATIBLE')
  if (user && seenAgents.has(user.id)) return addIssue(plan, entry, 'MULTIPLE_ROWS_SAME_AGENT')
  if (user) seenAgents.add(user.id)
  const current = user?.instructor.instructorZones.find(zone => zone.zoneId === state.zone.id)
  const expected = expectedZone(entry, inputs, current)
  const profile = profileChanges(user, entry)
  if (!user || Object.keys(profile.user).length || Object.keys(profile.instructor).length || !same(zoneState(current), expected)) {
    plan.actions.push({kind: 'AGENT', email: entry.email, userId: user ? user.id : null, sourceId: user ? user.instructor.sourceId : agentSourceId(entry.email),
      profile, zoneId: state.zone.id, currentZoneId: current ? current.id : null, beforeZone: zoneState(current), zone: expected})
  }
}

function planClosure(context, entry, owner) {
  const {plan, state, inputs, seenAgents} = context
  if (!owner) return
  if (owner.role !== 'INSTRUCTOR' || owner.deletedAt || !owner.instructor) return addIssue(plan, entry, 'CLOSURE_ACCOUNT_INCOMPATIBLE')
  if (seenAgents.has(owner.id)) return addIssue(plan, entry, 'MULTIPLE_ROWS_SAME_AGENT')
  seenAgents.add(owner.id)
  const current = owner.instructor.instructorZones.find(zone => zone.zoneId === state.zone.id)
  if (!current) return
  const expected = expectedZone(entry, inputs, current)
  if (!same(zoneState(current), expected)) {
    plan.actions.push({kind: 'CLOSE', email: entry.email, userId: owner.id, zoneId: state.zone.id,
      currentZoneId: current.id, beforeZone: zoneState(current), zone: expected})
  }
}

function donorCanBeReleased(user, zoneId, email) {
  return user.role === 'INSTRUCTOR' && !user.deletedAt && user.instructor && !user.declarant
    && emailKey(user.email) === email && user.emailAliases.length === 0 && user.emailVerifications.length === 0
    && (user.instructor.instructorZones.some(zone => zone.zoneId === zoneId)
      || user.instructor.sourceId?.startsWith('reunion:DEP-974:agent:'))
    && user.instructor.instructorZones.every(zone => zone.zoneId === zoneId)
    && user.instructor._count.instructedChunks === 0 && !hasBusinessDependencies(user)
}

function hasBusinessDependencies(user) {
  return BUSINESS_DEPENDENCIES.some(key => user._count[key] > 0)
}

function retirementSourceEntry(inputs, item) {
  return inputs.entries.find(entry => (item.email && entry.email === item.email)
    || (!item.email && item.row !== undefined && entry.row === item.row))
}

function replacementUser(state, inputs, item) {
  const entry = retirementSourceEntry(inputs, item)
  if (entry?.status !== 'OPEN' || entry.role !== 'DECLARANT') return null
  const sourceId = inputs.declarants.get(entry.structure)
  return state.users.find(user => user.role === 'DECLARANT' && !user.deletedAt && user.declarant?.sourceId === sourceId) ?? null
}

function retirementIdentityIssue(state, inputs, item, user) {
  const entry = retirementSourceEntry(inputs, item)
  if (entry?.status === 'OPEN' && entry.role === 'INSTRUCTOR') return 'RETIRE_ACTIVE_SOURCE_AGENT'
  if (item.reason === 'REPLACED' && !replacementUser(state, inputs, item)) return 'RETIRE_REPLACEMENT_UNPROVEN'
  if (item.reason === 'CLOSED' && (!entry || entry.status === 'OPEN')) return 'RETIRE_CLOSURE_UNPROVEN'
  if (item.reason === 'ABSENT_FROM_REGISTER' && entry) return 'RETIRE_ACCOUNT_IN_REGISTER'
  const owners = item.email ? ownersForEmail(state, item.email) : []
  const replacement = item.reason === 'REPLACED' ? replacementUser(state, inputs, item) : null
  if (owners.some(owner => owner.id !== user?.id && owner.id !== replacement?.id)) return 'RETIRE_EMAIL_IDENTITY_COLLISION'
  if (user && item.email && user.email && emailKey(user.email) !== item.email) return 'RETIRE_ACCOUNT_EMAIL_CHANGED'
  return null
}

function retirementAccountIssue(state, inputs, item, user) {
  const identityIssue = retirementIdentityIssue(state, inputs, item, user)
  if (identityIssue || !user) return identityIssue
  if (user.role !== 'INSTRUCTOR' || !user.instructor || user.declarant) return 'RETIRE_ACCOUNT_ROLE_PROTECTED'
  if (user.instructor.sourceId !== item.sourceId) return 'RETIRE_SOURCE_IDENTITY_CHANGED'
  if (user.instructor.instructorZones.some(zone => zone.zoneId !== state.zone.id)) return 'RETIRE_OTHER_ZONE'
  const userEmails = [user.email, ...user.emailAliases.map(alias => alias.email)].map(emailKey).filter(Boolean)
  if (inputs.entries.some(entry => entry.status === 'OPEN' && entry.role === 'INSTRUCTOR' && userEmails.includes(entry.email))) {
    return 'RETIRE_ACTIVE_SOURCE_AGENT'
  }

  if (inputs.entries.some(entry => entry.status === 'OPEN' && entry.role === 'DECLARANT' && userEmails.includes(entry.email))
    && item.reason !== 'REPLACED') return 'RETIRE_DECLARANT_ACCESS_PROTECTED'
  if (item.reason === 'ABSENT_FROM_REGISTER' && inputs.entries.some(entry => userEmails.includes(entry.email))) return 'RETIRE_ACCOUNT_IN_REGISTER'
  if (user.instructor._count.instructedChunks || hasBusinessDependencies(user)) return 'RETIRE_BUSINESS_DEPENDENCY'
  if (user._count.passwordActivationsIssued) return 'RETIRE_PASSWORD_ACTIVATION_ISSUER'
  const extra = state.nonRelationalDependencies.find(value => value.userId === user.id)
  if (extra?.declarationProcessingEvents || extra?.declarantZonesCreated) return 'RETIRE_BUSINESS_ACTOR_DEPENDENCY'
  return null
}

function planRetirements(plan, state, inputs) {
  for (const item of inputs.retireAccounts) {
    const user = state.users.find(candidate => candidate.instructor?.sourceId === item.sourceId)
    const issue = retirementAccountIssue(state, inputs, item, user)
    if (issue) {
      plan.issues.push({sourceId: item.sourceId, row: item.row, code: issue})
      continue
    }

    if (!user) continue
    plan.actions.push({kind: 'DELETE_ACCOUNT', sourceId: item.sourceId, userId: user.id,
      email: item.email, row: item.row, reason: item.reason, zoneId: state.zone.id,
      monthlyActivities: user._count.monthlyActivities,
      dependencyCounts: {...user._count, instructedChunks: user.instructor._count.instructedChunks}})
  }
}

function planDeclarant(context, entry, owner) {
  const {plan, state, inputs, proposedPrimaries} = context
  const sourceId = inputs.declarants.get(entry.structure)
  if (!sourceId) return addIssue(plan, entry, 'DECLARANT_MAPPING_MISSING')
  const matches = state.users.filter(user => user.declarant?.sourceId === sourceId)
  if (matches.length !== 1) return addIssue(plan, entry, 'DECLARANT_SOURCE_NOT_FOUND')
  const user = matches[0]
  if (user.role !== 'DECLARANT' || user.deletedAt || user.instructor) return addIssue(plan, entry, 'DECLARANT_ACCOUNT_INCOMPATIBLE')
  if (owner && owner.id !== user.id) {
    if (!donorCanBeReleased(owner, state.zone.id, entry.email)) return addIssue(plan, entry, 'EMAIL_OTHER_ACCOUNT_OR_DEPENDENCIES')
    const current = owner.instructor.instructorZones.find(zone => zone.zoneId === state.zone.id)
    const closed = current ? expectedZone({...entry, status: 'CLOSED', endDate: inputs.effectiveDate}, inputs, current) : null
    plan.actions.push({kind: 'RELEASE', email: entry.email, userId: owner.id, zoneId: state.zone.id,
      currentZoneId: current?.id ?? null, beforeZone: zoneState(current), zone: closed})
  }

  const existingEmails = [user.email, ...user.emailAliases.map(alias => alias.email)].map(emailKey)
  if (!existingEmails.includes(entry.email)) {
    const isPrimary = !user.email && !proposedPrimaries.has(user.id)
    if (isPrimary) proposedPrimaries.add(user.id)
    plan.actions.push({kind: isPrimary ? 'PRIMARY' : 'ALIAS', email: entry.email, userId: user.id, declarantSourceId: sourceId})
  }

  if (!user.declarant.contactEmails.some(contact => emailKey(contact.email) === entry.email)) {
    plan.actions.push({kind: 'CONTACT', email: entry.email, userId: user.id,
      sourceId: `${ACCESS_PREFIX}:contact:${digest([sourceId, entry.email])}`})
  }
}

function buildPlan(state, inputs) {
  const plan = {actions: [], issues: [], preservedGlobalAdmins: []}
  if (!state.zone) {
    plan.issues.push({code: 'ZONE_NOT_FOUND'})
    return plan
  }

  const seenAgents = new Set()
  const proposedPrimaries = new Set()
  const context = {plan, state, inputs, seenAgents, proposedPrimaries}
  for (const entry of inputs.entries) {
    const owners = ownersForEmail(state, entry.email)
    if (owners.length > 1) {
      addIssue(plan, entry, 'EMAIL_MULTIPLE_OWNERS')
      continue
    }

    const [owner] = owners
    if (!checkReservation(plan, state, entry, owner)) continue
    if (entry.status !== 'OPEN') planClosure(context, entry, owner)
    else if (entry.role === 'INSTRUCTOR') planAgent(context, entry, owner)
    else planDeclarant(context, entry, owner)
  }

  planRetirements(plan, state, inputs)
  return plan
}

async function synchronizeZone(transaction, action, userId) {
  if (same(action.beforeZone, action.zone)) return
  const data = {
    isAdmin: action.zone.isAdmin,
    startDate: new Date(`${action.zone.startDate}T00:00:00Z`),
    endDate: action.zone.endDate ? new Date(`${action.zone.endDate}T00:00:00Z`) : null
  }
  const assignment = action.currentZoneId
    ? await transaction.instructorZone.update({where: {id: action.currentZoneId}, data})
    : await transaction.instructorZone.create({data: {...data, instructorUserId: userId, zoneId: action.zoneId}})
  await transaction.instructorZonePermission.deleteMany({where: {instructorZoneId: assignment.id}})
  if (action.zone.permissions.length) {
    await transaction.instructorZonePermission.createMany({data: action.zone.permissions.map(permission => ({instructorZoneId: assignment.id, permission}))})
  }

  await transaction.instructorZonePermissionAudit.create({data: {
    instructorZoneId: assignment.id, zoneId: action.zoneId, instructorUserId: userId,
    action: 'MIGRATED', before: action.beforeZone ?? undefined, after: action.zone
  }})
}

async function invalidateAccess(transaction, userId) {
  await transaction.authToken.deleteMany({where: {userId}})
  await transaction.passwordActivation.deleteMany({where: {userId}})
  await transaction.sessionToken.deleteMany({where: {OR: [{userId}, {impersonatedByUserId: userId}]}})
}

async function executeRetirements(transaction, plan, inputs) {
  const actions = plan.actions.filter(item => item.kind === 'DELETE_ACCOUNT')
  if (!actions.length) return {retiredAccounts: [], deletedAccountMonthlyActivities: 0}
  // Nouvelle lecture après les transferts d’identifiants ; les comptes et les
  // références sans FK restent verrouillés depuis le début de la transaction.
  const state = await snapshotState(transaction, inputs)
  const retiredAccounts = []
  let deletedAccountMonthlyActivities = 0
  for (const action of actions) {
    const user = state.users.find(candidate => candidate.instructor?.sourceId === action.sourceId)
    const issue = retirementAccountIssue(state, inputs, action, user)
    if (issue || user?.id !== action.userId) throw new Error(`Suppression refusée après revalidation : ${issue ?? 'identité modifiée'}.`)
    if (action.reason === 'REPLACED') {
      const recipient = replacementUser(state, inputs, action)
      const entry = retirementSourceEntry(inputs, action)
      const owners = ownersForEmail(state, entry.email)
      if (owners.length !== 1 || owners[0].id !== recipient?.id || user.email || user.emailAliases.length) {
        throw new Error('Suppression refusée : accès de remplacement non vérifié.')
      }
    }

    const currentZone = user.instructor.instructorZones.find(zone => zone.zoneId === state.zone.id)
    const receipt = await transaction.instructorZonePermissionAudit.create({data: {
      instructorZoneId: currentZone?.id ?? null, instructorUserId: user.id, zoneId: state.zone.id,
      action: 'REMOVED', before: canonical({sourceId: action.sourceId, user}),
      after: {operation: 'retire-access-account', sourceId: action.sourceId, reason: action.reason,
        sourceHash: inputs.sourceHash, mappingsHash: inputs.mappingsHash, deleted: true}
    }})
    await invalidateAccess(transaction, user.id)
    const deleted = await transaction.user.deleteMany({where: {
      id: user.id, role: 'INSTRUCTOR', declarant: {is: null}, instructor: {is: {sourceId: action.sourceId}}
    }})
    if (deleted.count !== 1) throw new Error('Suppression refusée : un seul compte attendu.')
    const claims = await transaction.userEmailIdentity.count({where: {OR: [
      {primaryUserId: user.id}, {aliasUserId: user.id}, {verificationUserId: user.id}
    ]}})
    if (claims) throw new Error('Suppression annulée : une réservation d’identité subsiste.')
    retiredAccounts.push({sourceId: action.sourceId, userId: user.id, reason: action.reason, receiptId: receipt.id})
    deletedAccountMonthlyActivities += user._count.monthlyActivities
  }

  return {retiredAccounts, deletedAccountMonthlyActivities}
}

async function executePlan(transaction, plan, inputs) {
  const changedUsers = new Set()
  const invalidatedUsers = new Set()
  const createdUsers = []
  // Libérer les anciennes identités avant toute attribution, sous le même verrou.
  for (const action of plan.actions.filter(item => item.kind === 'RELEASE')) {
    await transaction.user.update({where: {id: action.userId}, data: {email: null, authVersion: {increment: 1}}})
    await synchronizeZone(transaction, action, action.userId)
    invalidatedUsers.add(action.userId)
  }

  for (const action of plan.actions.filter(item => !['RELEASE', 'DELETE_ACCOUNT'].includes(item.kind))) {
    let userId = action.userId
    if (action.kind === 'AGENT') {
      if (!userId) {
        const user = await transaction.user.create({data: {
          email: action.email, role: 'INSTRUCTOR', ...action.profile.user,
          instructor: {create: {sourceId: action.sourceId, ...action.profile.instructor}}
        }})
        userId = user.id
        createdUsers.push(userId)
      } else {
        if (Object.keys(action.profile.user).length) await transaction.user.update({where: {id: userId}, data: action.profile.user})
        if (Object.keys(action.profile.instructor).length) await transaction.instructor.update({where: {userId}, data: action.profile.instructor})
        changedUsers.add(userId)
      }

      await synchronizeZone(transaction, action, userId)
    } else if (action.kind === 'CLOSE') {
      await synchronizeZone(transaction, action, userId)
      changedUsers.add(userId)
    } else if (action.kind === 'PRIMARY') {
      await transaction.user.update({where: {id: userId}, data: {email: action.email, authVersion: {increment: 1}}})
      invalidatedUsers.add(userId)
    } else if (action.kind === 'ALIAS') {
      await transaction.userEmailAlias.create({data: {userId, email: action.email}})
      changedUsers.add(userId)
    } else if (action.kind === 'CONTACT') {
      await transaction.declarantContactEmail.create({data: {declarantUserId: userId, email: action.email, sourceId: action.sourceId, isPrimary: false}})
    }
  }

  for (const userId of changedUsers) {
    if (!invalidatedUsers.has(userId)) await transaction.user.update({where: {id: userId}, data: {authVersion: {increment: 1}}})
    invalidatedUsers.add(userId)
  }

  for (const userId of invalidatedUsers) await invalidateAccess(transaction, userId)
  const retirement = await executeRetirements(transaction, plan, inputs)
  return {createdUsers, invalidatedUsers: [...invalidatedUsers].sort(), ...retirement}
}

function makeReport(inputs, state, plan) {
  return {
    operation: 'sync-access', version: 1, target: inputs.target, sourceHash: inputs.sourceHash,
    mappingsHash: inputs.mappingsHash, zone: inputs.zone,
    planHash: digest({inputs: {...inputs, declarants: undefined}, state, plan}),
    stateHash: digest(state), blocked: plan.issues.length > 0, issues: plan.issues,
    preservedGlobalAdmins: plan.preservedGlobalAdmins,
    changes: plan.actions.length, actions: plan.actions,
    complete: plan.issues.length === 0, applied: false, dryRun: true,
    plannedDeletedAccountMonthlyActivities: plan.actions.filter(item => item.kind === 'DELETE_ACCOUNT').reduce((total, item) => total + item.monthlyActivities, 0),
    counts: Object.fromEntries(['AGENT', 'CLOSE', 'RELEASE', 'PRIMARY', 'ALIAS', 'CONTACT', 'DELETE_ACCOUNT'].map(kind => [kind, plan.actions.filter(item => item.kind === kind).length]))
  }
}

function assertExpectedReport(report, expected) {
  if (!expected || expected.operation !== report.operation || expected.version !== report.version
    || expected.target !== report.target || expected.sourceHash !== report.sourceHash
    || expected.mappingsHash !== report.mappingsHash || expected.planHash !== report.planHash
    || !expected.complete || expected.blocked || expected.applied || !expected.dryRun) {
    throw new Error('Simulation compatible obligatoire : source, mapping, cible ou état ont changé.')
  }
}

/** Aucune notification ni création de secret : les écritures restent transactionnelles. */
export async function syncAccess(prisma, source, options = {}) {
  const inputs = normalizeInputs(source, options)
  if (inputs.target !== 'local' && typeof options.assertTarget !== 'function') throw new Error('Attestation SQL de la cible distante obligatoire.')
  let report
  const rollback = new Error('ACCESS_SIMULATION_ROLLBACK')
  try {
    return await prisma.$transaction(async transaction => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('reunion-access'), hashtext(${inputs.zone.code}))`
      await options.assertTarget?.(transaction)
      await lockRetirementScope(transaction, inputs)
      const state = await snapshotState(transaction, inputs)
      const plan = buildPlan(state, inputs)
      report = makeReport(inputs, state, plan)
      if (report.blocked) return report
      if (options.apply) {
        assertExpectedReport(report, options.expectedReport)
        if (plan.actions.length) {
          if (typeof options.onBeforeApply !== 'function') throw new Error('Sauvegarde privée avant écriture obligatoire.')
          await options.onBeforeApply({report, snapshot: canonical(state)})
        }
      }

      const execution = await executePlan(transaction, plan, inputs)
      const extraUserIds = [...state.users.map(user => user.id), ...execution.createdUsers]
      const after = await snapshotState(transaction, inputs, extraUserIds)
      const remaining = buildPlan(after, inputs)
      if (remaining.issues.length || remaining.actions.length) throw new Error('Les accès simulés ne correspondent pas au plan attendu.')
      report = {...report, ...execution, stateAfter: canonical(after), stateAfterHash: digest(after), applied: Boolean(options.apply), dryRun: !options.apply}
      if (!options.apply) throw rollback
      return report
    }, {isolationLevel: 'Serializable', timeout: 120_000, maxWait: 15_000})
  } catch (error) {
    if (error === rollback) return report
    throw error
  }
}

/** Relit les droits et identités ; le rapport appliqué contrôle aussi les anciens agents. */
export async function verifyAccess(prisma, source, options = {}) {
  const inputs = normalizeInputs(source, options)
  if (inputs.target !== 'local' && typeof options.assertTarget !== 'function') throw new Error('Attestation SQL de la cible distante obligatoire.')
  const expected = options.expectedReport
  if (expected && (!expected.applied || expected.target !== inputs.target || expected.sourceHash !== inputs.sourceHash
    || expected.mappingsHash !== inputs.mappingsHash || !expected.stateAfter)) throw new Error('Rapport d’application incompatible pour vérifier les accès.')
  return prisma.$transaction(async transaction => {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('reunion-access'), hashtext(${inputs.zone.code}))`
    await options.assertTarget?.(transaction)
    const state = await snapshotState(transaction, inputs, expected?.stateAfter.users.map(user => user.id) ?? [])
    const plan = buildPlan(state, inputs)
    const preserved = !expected || digest(state) === expected.stateAfterHash
    return {...makeReport(inputs, state, plan), operation: 'verify-access',
      ok: plan.issues.length === 0 && plan.actions.length === 0 && preserved,
      preserved, stateAfterHash: digest(state)}
  }, {isolationLevel: 'Serializable', timeout: 120_000, maxWait: 15_000})
}
