function getDeclarant(value) {
  return value?.declarant ?? value
}

function getUser(value) {
  const declarant = getDeclarant(value)
  return declarant?.user ?? (value?.declarant ? value : null)
}

export function isSyntheticImportEmail(email) {
  return typeof email === 'string'
    && email.trim().toLowerCase().endsWith('@import.local')
}

export function getDeclarantContactEmailRecords(value) {
  const declarant = getDeclarant(value)

  return [...(declarant?.contactEmails ?? [])]
    .filter(contact => contact?.email && !isSyntheticImportEmail(contact.email))
    .sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary)
      || String(left.email).localeCompare(String(right.email), 'fr'))
}

export function getEffectiveDeclarantContactEmails(value) {
  const contacts = getDeclarantContactEmailRecords(value)

  if (contacts.length > 0) {
    return [...new Set(contacts.map(contact => contact.email))]
  }

  const loginEmail = getUser(value)?.email

  return loginEmail && !isSyntheticImportEmail(loginEmail)
    ? [loginEmail]
    : []
}

export function getPrimaryDeclarantContactEmail(value) {
  return getEffectiveDeclarantContactEmails(value)[0] ?? null
}

export function hasDeclarantContactEmail(value) {
  return getEffectiveDeclarantContactEmails(value).length > 0
}

export function serializeDeclarantContactEmails(value) {
  return getDeclarantContactEmailRecords(value).map(contact => ({
    id: contact.id,
    email: contact.email,
    isPrimary: contact.isPrimary === true
  }))
}
