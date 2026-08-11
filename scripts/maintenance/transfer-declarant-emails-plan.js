import {normalizeEmail} from '../../lib/util/email.js'

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[1-5][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i
const VALUE_ARGUMENTS = new Set([
  'source-id',
  'target-id',
  'primary-email'
])
const FLAG_ARGUMENTS = new Set([
  'apply',
  'dry-run',
  'help',
  'rollback'
])

function parseArgument(argument) {
  if (!argument.startsWith('--')) {
    throw new Error(`Argument positionnel non pris en charge : ${argument}`)
  }

  const separatorIndex = argument.indexOf('=')
  if (separatorIndex === -1) {
    return {name: argument.slice(2), value: null}
  }

  return {
    name: argument.slice(2, separatorIndex),
    value: argument.slice(separatorIndex + 1)
  }
}

function requireSingleValue(values, name) {
  const entries = values.get(name) ?? []

  if (entries.length !== 1 || !entries[0]) {
    throw new Error(`L’argument --${name}=... est obligatoire et doit être fourni une seule fois.`)
  }

  return entries[0]
}

function normalizeUuid(value, label) {
  const normalized = value.toLowerCase()

  if (!UUID_PATTERN.test(normalized)) {
    throw new Error(`${label} doit être un UUID valide.`)
  }

  return normalized
}

function normalizeAliases(values, primaryEmail) {
  if (values.length === 0) {
    throw new Error('Au moins un argument --alias=... est obligatoire.')
  }

  const aliases = values.map(value => normalizeEmail(value))
  const uniqueAliases = new Set(aliases)

  if (uniqueAliases.size !== aliases.length) {
    throw new Error('Un alias a été fourni plusieurs fois.')
  }

  if (uniqueAliases.has(primaryEmail)) {
    throw new Error('L’email principal ne peut pas aussi être fourni comme alias.')
  }

  return [...uniqueAliases].sort()
}

export function parseTransferDeclarantEmailsOptions(arguments_) {
  const values = new Map()
  const flags = new Set()

  for (const argument of arguments_) {
    const {name, value} = parseArgument(argument)

    if (name === 'alias') {
      if (value === null) {
        throw new Error('Utiliser --alias=adresse@example.org.')
      }

      values.set(name, [...(values.get(name) ?? []), value])
      continue
    }

    if (VALUE_ARGUMENTS.has(name)) {
      if (value === null) {
        throw new Error(`Utiliser --${name}=valeur.`)
      }

      values.set(name, [...(values.get(name) ?? []), value])
      continue
    }

    if (FLAG_ARGUMENTS.has(name)) {
      if (value !== null) {
        throw new Error(`L’option --${name} ne prend pas de valeur.`)
      }

      if (flags.has(name)) {
        throw new Error(`L’option --${name} a été fournie plusieurs fois.`)
      }

      flags.add(name)
      continue
    }

    throw new Error(`Argument inconnu : --${name}`)
  }

  if (flags.has('help')) {
    if (arguments_.length > 1) {
      throw new Error('L’option --help doit être utilisée seule.')
    }

    return {help: true}
  }

  if (flags.has('apply') && flags.has('dry-run')) {
    throw new Error('Les options --apply et --dry-run sont incompatibles.')
  }

  const sourceId = normalizeUuid(
    requireSingleValue(values, 'source-id'),
    'L’identifiant source'
  )
  const targetId = normalizeUuid(
    requireSingleValue(values, 'target-id'),
    'L’identifiant cible'
  )

  if (sourceId === targetId) {
    throw new Error('Les identifiants source et cible doivent être différents.')
  }

  const primaryEmail = normalizeEmail(requireSingleValue(values, 'primary-email'))
  const aliases = normalizeAliases(values.get('alias') ?? [], primaryEmail)

  return {
    help: false,
    sourceId,
    targetId,
    primaryEmail,
    aliases,
    apply: flags.has('apply'),
    rollback: flags.has('rollback')
  }
}

function normalizedOptionalEmail(value) {
  return value ? normalizeEmail(value) : null
}

function normalizedAliasEmails(user) {
  return (user.emailAliases ?? [])
    .map(({email}) => normalizeEmail(email))
    .sort()
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function rowsForEmail(rows, email) {
  return rows.filter(row => normalizeEmail(row.email) === email)
}

function hasExactPrimaryOwner(snapshot, email, expectedUserId) {
  const owners = rowsForEmail(snapshot.addressUsers, email)
  return owners.length === 1 && owners[0].id === expectedUserId
}

function hasNoPrimaryOwner(snapshot, email) {
  return rowsForEmail(snapshot.addressUsers, email).length === 0
}

function hasExactAliasOwner(snapshot, email, expectedUserId) {
  const owners = rowsForEmail(snapshot.addressAliases, email)
  return owners.length === 1 && owners[0].userId === expectedUserId
}

function hasNoAliasOwner(snapshot, email) {
  return rowsForEmail(snapshot.addressAliases, email).length === 0
}

function addressesAreOwnedBy(snapshot, options, ownerId) {
  if (!hasExactPrimaryOwner(snapshot, options.primaryEmail, ownerId)
    || !hasNoAliasOwner(snapshot, options.primaryEmail)) {
    return false
  }

  return options.aliases.every(alias =>
    hasExactAliasOwner(snapshot, alias, ownerId)
    && hasNoPrimaryOwner(snapshot, alias))
}

function credentialCount(credentials) {
  return credentials.authTokens
    + credentials.sessions
    + credentials.serviceAccountTokens
}

function assertCredentialCounts(credentials) {
  for (const [name, value] of Object.entries(credentials)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Compteur de credentials invalide (${name}).`)
    }
  }
}

function getDeclarantUsers(snapshot, options) {
  const source = snapshot.users.find(user => user.id === options.sourceId)
  const target = snapshot.users.find(user => user.id === options.targetId)

  if (!source) {
    throw new Error(`Déclarant source introuvable : ${options.sourceId}`)
  }

  if (!target) {
    throw new Error(`Déclarant cible introuvable : ${options.targetId}`)
  }

  if (source.role !== 'DECLARANT' || !source.declarant) {
    throw new Error('Le compte source n’est pas un déclarant.')
  }

  if (target.role !== 'DECLARANT' || !target.declarant) {
    throw new Error('Le compte cible n’est pas un déclarant.')
  }

  if (!source.deletedAt) {
    throw new Error('Le déclarant source doit être supprimé logiquement.')
  }

  if (target.deletedAt) {
    throw new Error('Le déclarant cible doit être actif.')
  }

  return {source, target}
}

function getStateDetails(snapshot, source, target, options) {
  const ownership = [options.primaryEmail, ...options.aliases]
    .map(email => {
      const primaryOwners = rowsForEmail(snapshot.addressUsers, email).map(({id}) => id)
      const aliasOwners = rowsForEmail(snapshot.addressAliases, email).map(({userId}) => userId)
      return `${email}: principal=[${primaryOwners.join(',')}], alias=[${aliasOwners.join(',')}]`
    })

  return [
    `source.email=${normalizedOptionalEmail(source.email) ?? 'null'}`,
    `source.aliases=[${normalizedAliasEmails(source).join(',')}]`,
    `target.email=${normalizedOptionalEmail(target.email) ?? 'null'}`,
    `target.aliases=[${normalizedAliasEmails(target).join(',')}]`,
    ...ownership
  ].join(' ; ')
}

export function buildTransferDeclarantEmailsPlan(snapshot, options) {
  assertCredentialCounts(snapshot.credentials)

  const {source, target} = getDeclarantUsers(snapshot, options)
  const sourceAliases = normalizedAliasEmails(source)
  const targetAliases = normalizedAliasEmails(target)
  const sourceEmail = normalizedOptionalEmail(source.email)
  const targetEmail = normalizedOptionalEmail(target.email)
  const addressesOwnedBySource = addressesAreOwnedBy(snapshot, options, source.id)
  const addressesOwnedByTarget = addressesAreOwnedBy(snapshot, options, target.id)
  const beforeTransfer = sourceEmail === options.primaryEmail
    && targetEmail === null
    && sameValues(sourceAliases, options.aliases)
    && targetAliases.length === 0
    && addressesOwnedBySource
  const afterTransfer = sourceEmail === null
    && targetEmail === options.primaryEmail
    && sourceAliases.length === 0
    && sameValues(targetAliases, options.aliases)
    && addressesOwnedByTarget

  if (!beforeTransfer && !afterTransfer) {
    throw new Error(
      'État des adresses incohérent ou partiellement transféré. '
      + getStateDetails(snapshot, source, target, options)
    )
  }

  const credentialsPending = credentialCount(snapshot.credentials) > 0
  let emailAction = 'NONE'
  let credentialsAction = 'NONE'

  if (options.rollback) {
    emailAction = afterTransfer ? 'ROLLBACK' : 'NONE'
  } else {
    emailAction = beforeTransfer ? 'TRANSFER' : 'NONE'
    credentialsAction = credentialsPending ? 'REVOKE' : 'NONE'
  }

  const aliasOwnerId = beforeTransfer ? source.id : target.id
  const aliasIds = snapshot.addressAliases
    .filter(alias => alias.userId === aliasOwnerId && options.aliases.includes(normalizeEmail(alias.email)))
    .map(({id}) => id)
    .sort()

  return {
    detectedState: beforeTransfer ? 'SOURCE' : 'TARGET',
    emailAction,
    credentialsAction,
    aliasIds,
    noOp: emailAction === 'NONE' && credentialsAction === 'NONE'
  }
}

export const TRANSFER_DECLARANT_EMAILS_USAGE = `Usage :
  node scripts/maintenance/transfer-declarant-emails.js \\
    --source-id=<uuid> \\
    --target-id=<uuid> \\
    --primary-email=<email> \\
    --alias=<email> [--alias=<email> ...] [--apply]

Modes :
  aucun drapeau       simulation du transfert, sans écriture
  --apply             applique le transfert et révoque les credentials source
  --rollback          simulation du rollback des adresses
  --rollback --apply  applique le rollback des adresses

Le rollback ne restaure jamais les magic links, sessions ou tokens révoqués.`
