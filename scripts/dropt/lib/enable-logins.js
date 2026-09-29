import {normalizeEmail} from '../../../lib/util/email.js'
import {getAuthUserByEmail} from '../../../lib/models/user.js'
import {referenceIdentity, validateManifest} from './apply-epidropt.js'
import {digest, SCOPE} from './epidropt.js'
import {getTransactionTimeoutMs} from './import-options.js'

const activeVerification = {status: {in: ['PENDING', 'SEND_FAILED']}}

function hasExistingAccess(user) {
  return user.authVersion !== 0 || user.lastLoginAt || user.emailAliases.length || user.emailVerifications.length
    || user.passwordCredential || user.passwordActivation || user._count.authTokens || user._count.sessionTokens
}

function sourceEmails(record) {
  try {
    const emails = [...new Set(record.emails.map(email => normalizeEmail(email)))].sort()
    if (emails.some(email => email.endsWith('@import.local') || email.endsWith('@email.fr'))) return []
    return emails
  } catch {
    return []
  }
}

async function inspectAccount(tx, record, id, {sharedSourceEmails, allowEmailAliases}) {
  // The primary-email trigger serializes claims across primary/alias/verification
  // tables and invalidates old tokens. Never bypass it or write its registry.
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${id}::uuid FOR UPDATE`
  const user = await tx.user.findUnique({where: {id}, select: {
    email: true, role: true, deletedAt: true, authVersion: true, lastLoginAt: true,
    emailAliases: {select: {email: true}, orderBy: {email: 'asc'}},
    emailVerifications: {where: activeVerification, select: {id: true}, orderBy: {id: 'asc'}},
    passwordCredential: {select: {userId: true}},
    passwordActivation: {select: {userId: true}},
    _count: {select: {authTokens: true, sessionTokens: true}},
    declarant: {select: {declarantRole: true, contactEmails: {orderBy: {email: 'asc'}}}}
  }})
  const emails = sourceEmails(record)
  const entry = {id, stateHash: digest(user)}
  const outcome = (status, reason, email) => ({...entry, status, reason, ...(email ? {email} : {})})
  if (!user || user.deletedAt || user.role !== 'DECLARANT' || user.declarant?.declarantRole !== 'PRELEVEUR') return outcome('BLOCKED', 'COMPTE_INACTIF_OU_INCOMPATIBLE')
  if (user.email) {
    const existing = new Set([user.email, ...user.emailAliases.map(alias => alias.email)].map(email => email.toLowerCase()))
    const confirmed = emails.includes(user.email.toLowerCase()) && (!allowEmailAliases || emails.every(email => existing.has(email)))
    return outcome(confirmed ? 'UNCHANGED' : 'PRESERVED', 'CONNEXION_EXISTANTE')
  }
  if (hasExistingAccess(user)) return outcome('PRESERVED', 'COMPTE_DEJA_CONFIGURE')
  if (!emails.length || (emails.length > 1 && !allowEmailAliases)) return outcome('BLOCKED', emails.length ? 'PLUSIEURS_EMAILS_SOURCE' : 'EMAIL_SOURCE_ABSENT_OU_INVALIDE')
  const [email, ...emailAliases] = emails
  const contacts = user.declarant.contactEmails
  if (!emails.every(address => contacts.some(contact => contact.email.toLowerCase() === address
    && contact.sourceId === `dropt-epidropt:contact:${digest([record.key, address])}`))) return outcome('BLOCKED', 'CONTACT_IMPORTE_NON_CONFIRME')
  if (contacts.some(contact => contact.isPrimary && contact.email.toLowerCase() !== email)) return outcome('PRESERVED', 'CONTACT_PRINCIPAL_MODIFIE')
  if (emails.some(address => sharedSourceEmails.has(address))) return outcome('BLOCKED', 'EMAIL_SOURCE_PARTAGE')
  const emailWhere = {in: emails}
  const [otherContact, primary, alias, verification, identity] = await Promise.all([
    tx.declarantContactEmail.findFirst({where: {email: emailWhere, declarantUserId: {not: id}}, select: {id: true}}),
    tx.user.findFirst({where: {email: emailWhere}, select: {id: true}}),
    tx.userEmailAlias.findFirst({where: {email: emailWhere}, select: {id: true}}),
    tx.userEmailVerification.findFirst({where: {email: emailWhere, ...activeVerification}, select: {id: true}}),
    tx.userEmailIdentity.findFirst({where: {email: emailWhere, OR: [{primaryUserId: {not: null}}, {aliasUserId: {not: null}}, {verificationUserId: {not: null}}]}, select: {email: true}})
  ])
  if (otherContact) return outcome('BLOCKED', 'CONTACT_PARTAGE')
  if (primary || alias || verification || identity) return outcome('BLOCKED', 'EMAIL_DEJA_ATTRIBUE_OU_RESERVE')
  return {...outcome('ENABLE', emailAliases.length ? 'EMAILS_SOURCE_VALIDES' : 'EMAIL_SOURCE_UNIQUE', email), emailAliases}
}

// Explicit second import step: grant login only, never recreate the referential,
// generate credentials/tokens, subscribe notifications or send invitations.
export async function enableManifestLogins(client, manifest, {scope, allowEmailAliases = false, apply = false, expectedReport, transactionTimeoutSeconds} = {}) {
  validateManifest(manifest)
  if (!['non-realimente', 'all'].includes(scope)) throw new Error('Périmètre de connexion explicite obligatoire : non-realimente ou all.')
  if (typeof allowEmailAliases !== 'boolean') throw new Error('Autorisation des alias invalide.')
  if ((apply && !expectedReport) || (expectedReport && (expectedReport.operation !== 'enable-logins'
    || expectedReport.scope !== scope || expectedReport.allowEmailAliases !== allowEmailAliases || expectedReport.manifestHash !== manifest.manifestHash
    || !expectedReport.complete || expectedReport.applied || !expectedReport.planHash))) throw new Error('Simulation de référence compatible obligatoire avant activation des connexions.')

  const points = new Map(manifest.points.map(point => [point.id, point]))
  const exploitations = manifest.exploitations.filter(record => {
    const name = points.get(record.pointId)?.data.name
    return typeof name === 'string' && (scope === 'all' || !/CACG/i.test(name))
  })
  const selected = new Set(exploitations.map(record => record.declarantId))
  const records = manifest.declarants.filter(record => selected.has(record.id)).sort((a, b) => a.id.localeCompare(b.id))
  if (records.length !== selected.size || new Set(records.map(record => record.id)).size !== records.length) throw new Error('Identités du périmètre de connexion incohérentes.')
  const emailOwners = new Map()
  for (const record of manifest.declarants) {
    for (const email of sourceEmails(record)) {
      if (!emailOwners.has(email)) emailOwners.set(email, new Set())
      emailOwners.get(email).add(record.id)
    }
  }
  const shared = new Set([...emailOwners].filter(([, ids]) => ids.size > 1).map(([email]) => email))
  let result
  const rollback = new Error('LOGIN_DRY_RUN_ROLLBACK')
  try {
    return await client.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('dropt-referential'), hashtext(${SCOPE}))`
      const entries = []
      const resolvedIds = new Set()
      const pointIdentities = new Map()
      for (const record of records) {
        const {id} = await referenceIdentity(tx, record, 'DECLARANT')
        if (resolvedIds.has(id)) throw new Error('Plusieurs identités source désignent le même compte ; rapprochement à vérifier.')
        resolvedIds.add(id)
        // Resolve the actual imported links as well: a stale manifest must not
        // grant access to a reassigned or deleted exploitation/point.
        const links = []
        for (const exploitation of exploitations.filter(item => item.declarantId === record.id)) {
          if (!pointIdentities.has(exploitation.pointId)) pointIdentities.set(exploitation.pointId,
            (await referenceIdentity(tx, points.get(exploitation.pointId), 'POINT')).id)
          const pointId = pointIdentities.get(exploitation.pointId)
          const matches = await tx.declarantPointPrelevement.findMany({where: {
            OR: [{id: exploitation.id}, ...(exploitation.sourceId ? [{sourceId: exploitation.sourceId}] : [])]
          }, select: {id: true, declarantUserId: true, pointPrelevementId: true, endDate: true,
            pointPrelevement: {select: {deletedAt: true, name: true}}}})
          if (matches.length === 1 && matches[0].declarantUserId === id && matches[0].pointPrelevementId === pointId
            && !matches[0].pointPrelevement.deletedAt && !matches[0].endDate
            && (scope === 'all' || !/CACG/i.test(matches[0].pointPrelevement.name))) links.push(matches[0].id)
        }
        const entry = links.length ? await inspectAccount(tx, record, id, {sharedSourceEmails: shared, allowEmailAliases})
          : {id, status: 'BLOCKED', reason: 'EXPLOITATION_IMPORTEE_ACTIVE_NON_CONFIRMEE'}
        entries.push({...entry, sourceId: record.id, exploitationIds: links.sort()})
      }
      const counts = {selected: entries.length, enabled: 0, unchanged: 0, preserved: 0, blocked: 0, aliases: 0}
      const countKeys = {ENABLE: 'enabled', UNCHANGED: 'unchanged', PRESERVED: 'preserved', BLOCKED: 'blocked'}
      for (const entry of entries) {
        counts[countKeys[entry.status]]++
        if (entry.status === 'ENABLE') counts.aliases += entry.emailAliases.length
      }
      result = {operation: 'enable-logins', scope, allowEmailAliases, manifestHash: manifest.manifestHash, complete: true, applied: false, counts, entries}
      result.planHash = digest({operation: result.operation, scope, allowEmailAliases, manifestHash: result.manifestHash, entries})
      if (expectedReport && result.planHash !== expectedReport.planHash) throw new Error('DRY_RUN_STATE_CHANGED : refaire la simulation des connexions.')
      for (const entry of entries.filter(item => item.status === 'ENABLE')) {
        const updated = await tx.user.updateMany({where: {id: entry.id, email: null, authVersion: 0, deletedAt: null}, data: {email: entry.email}})
        if (updated.count !== 1) throw new Error('Compte modifié ; activation annulée.')
        if (entry.emailAliases.length) await tx.userEmailAlias.createMany({data: entry.emailAliases.map(email => ({userId: entry.id, email}))})
        for (const email of [entry.email, ...entry.emailAliases]) {
          if ((await getAuthUserByEmail(email, {client: tx}))?.id !== entry.id) throw new Error('Connexion non confirmée ; activation annulée.')
        }
      }
      if (!apply) throw rollback
      return {...result, applied: true}
    }, {isolationLevel: 'Serializable', maxWait: 10_000, timeout: getTransactionTimeoutMs(transactionTimeoutSeconds)})
  } catch (error) {
    if (error === rollback) return result
    throw error
  }
}
