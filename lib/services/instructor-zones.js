function dateKey(value) {
  if (!value) {
    return null
  }

  if (typeof value === 'string') {
    return value.slice(0, 10)
  }

  return value.toISOString().slice(0, 10)
}

function compareNullableDates(left, right) {
  const leftKey = dateKey(left) || ''
  const rightKey = dateKey(right) || ''

  return leftKey.localeCompare(rightKey)
}

function getUserFromRight(right) {
  return right?.instructor?.user
}

function serializeZone(zone) {
  if (!zone) {
    return null
  }

  return {
    id: zone.id,
    type: zone.type,
    code: zone.code,
    name: zone.name
  }
}

export function getInstructorDisplayName(instructor) {
  const user = instructor?.user ?? instructor
  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim()

  return fullName || user?.email || ''
}

export function getInstructorZoneStatus(right, now = new Date()) {
  const today = dateKey(now)
  const startDate = dateKey(right?.startDate)
  const endDate = dateKey(right?.endDate)

  if (startDate && startDate > today) {
    return 'FUTURE'
  }

  if (endDate && endDate < today) {
    return 'ENDED'
  }

  return 'ACTIVE'
}

export function serializeInstructorHabilitation(right, {currentZoneId = null, now = new Date()} = {}) {
  if (!right) {
    return null
  }

  return {
    id: right.id,
    zone: serializeZone(right.zone),
    zoneId: right.zoneId,
    isAdmin: right.isAdmin,
    startDate: right.startDate,
    endDate: right.endDate,
    status: getInstructorZoneStatus(right, now),
    isCurrentZone: right.zoneId === currentZoneId,
    zoneAttachmentMailSentAt: right.zoneAttachmentMailSentAt,
    createdAt: right.createdAt,
    updatedAt: right.updatedAt
  }
}

export function sortInstructorHabilitations(habilitations) {
  return [...habilitations].sort((a, b) => {
    if (a.isCurrentZone !== b.isCurrentZone) {
      return a.isCurrentZone ? -1 : 1
    }

    const statusOrder = {
      ACTIVE: 0,
      FUTURE: 1,
      ENDED: 2
    }

    const statusComparison = (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99)

    if (statusComparison !== 0) {
      return statusComparison
    }

    return (a.zone?.name || '').localeCompare(b.zone?.name || '', 'fr')
      || compareNullableDates(a.startDate, b.startDate)
  })
}

export function serializeInstructorRight(right, {
  currentUserId = null,
  includeHabilitations = false,
  currentZoneId = right?.zoneId,
  now = new Date()
} = {}) {
  const user = getUserFromRight(right)

  if (!user || user.deletedAt) {
    return null
  }

  const result = {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    accountCreationMailSentAt: user.accountCreationMailSentAt,
    phoneNumber: right.instructor.phoneNumber,
    jobTitle: right.instructor.jobTitle,
    isAdmin: right.isAdmin,
    isCurrentUser: user.id === currentUserId,
    startDate: right.startDate,
    endDate: right.endDate,
    status: getInstructorZoneStatus(right, now),
    zoneAttachmentMailSentAt: right.zoneAttachmentMailSentAt,
    createdAt: right.createdAt,
    updatedAt: right.updatedAt
  }

  if (includeHabilitations) {
    const habilitations = sortInstructorHabilitations(
      (right.instructor.instructorZones || [])
        .map(habilitation => serializeInstructorHabilitation(habilitation, {currentZoneId, now}))
        .filter(Boolean)
    )

    result.habilitations = habilitations
    result.otherHabilitations = habilitations.filter(habilitation => !habilitation.isCurrentZone)
  }

  return result
}

export function serializeInstructorCandidate(user, {
  currentZoneId,
  currentUserId = null,
  now = new Date()
} = {}) {
  if (!user || user.deletedAt || user.role !== 'INSTRUCTOR' || !user.instructor) {
    return null
  }

  const habilitations = sortInstructorHabilitations(
    (user.instructor.instructorZones || [])
      .map(habilitation => serializeInstructorHabilitation(habilitation, {currentZoneId, now}))
      .filter(Boolean)
  )
  const currentZoneHabilitation = habilitations.find(habilitation => habilitation.isCurrentZone) || null

  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    accountCreationMailSentAt: user.accountCreationMailSentAt,
    phoneNumber: user.instructor.phoneNumber,
    jobTitle: user.instructor.jobTitle,
    isCurrentUser: user.id === currentUserId,
    currentZoneHabilitation,
    habilitations,
    otherHabilitations: habilitations.filter(habilitation => !habilitation.isCurrentZone),
    activeHabilitationsCount: habilitations.filter(habilitation => habilitation.status !== 'ENDED').length,
    isAttachedToCurrentZone: currentZoneHabilitation?.status !== 'ENDED' && Boolean(currentZoneHabilitation)
  }
}
