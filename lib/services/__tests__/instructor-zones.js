import test from 'ava'

import {
  getInstructorZoneStatus,
  serializeInstructorCandidate,
  serializeInstructorRight
} from '../instructor-zones.js'

const now = new Date('2026-07-06T12:00:00.000Z')

function date(value) {
  return new Date(`${value}T00:00:00.000Z`)
}

function zone(id, name) {
  return {
    id,
    type: 'SAGE',
    code: id.toUpperCase(),
    name
  }
}

function right(overrides = {}) {
  return {
    id: overrides.id || 'right-1',
    instructorUserId: overrides.instructorUserId || 'user-1',
    zoneId: overrides.zoneId || 'zone-1',
    zone: overrides.zone || zone(overrides.zoneId || 'zone-1', 'Zone courante'),
    isAdmin: overrides.isAdmin ?? false,
    startDate: overrides.startDate ?? date('2026-01-01'),
    endDate: overrides.endDate ?? null,
    zoneAttachmentMailSentAt: overrides.zoneAttachmentMailSentAt ?? null,
    createdAt: overrides.createdAt ?? date('2026-01-01'),
    updatedAt: overrides.updatedAt ?? date('2026-01-01'),
    instructor: overrides.instructor
  }
}

test('getInstructorZoneStatus distingue actif, futur et terminé sur des dates seules', t => {
  t.is(getInstructorZoneStatus(right({startDate: date('2026-01-01'), endDate: null}), now), 'ACTIVE')
  t.is(getInstructorZoneStatus(right({startDate: date('2026-07-07'), endDate: null}), now), 'FUTURE')
  t.is(getInstructorZoneStatus(right({startDate: date('2026-01-01'), endDate: date('2026-07-05')}), now), 'ENDED')
  t.is(getInstructorZoneStatus(right({startDate: date('2026-01-01'), endDate: date('2026-07-06')}), now), 'ACTIVE')
})

test('serializeInstructorRight ajoute les autres habilitations sans perdre les champs historiques', t => {
  const instructor = {
    phoneNumber: '0102030405',
    jobTitle: 'Chargée de mission',
    user: {
      id: 'user-1',
      email: 'agent@example.test',
      firstName: 'Ada',
      lastName: 'Lovelace',
      accountCreationMailSentAt: date('2026-02-01'),
      deletedAt: null
    },
    instructorZones: [
      right({id: 'current', zoneId: 'zone-1', zone: zone('zone-1', 'Zone courante'), isAdmin: true}),
      right({id: 'other', zoneId: 'zone-2', zone: zone('zone-2', 'Autre zone'), startDate: date('2026-08-01')})
    ]
  }

  const serialized = serializeInstructorRight(right({instructor, isAdmin: true}), {
    currentUserId: 'user-2',
    includeHabilitations: true,
    currentZoneId: 'zone-1',
    now
  })

  t.like(serialized, {
    id: 'user-1',
    email: 'agent@example.test',
    firstName: 'Ada',
    lastName: 'Lovelace',
    phoneNumber: '0102030405',
    jobTitle: 'Chargée de mission',
    isAdmin: true,
    isCurrentUser: false,
    status: 'ACTIVE'
  })
  t.is(serialized.habilitations.length, 2)
  t.true(serialized.habilitations[0].isCurrentZone)
  t.deepEqual(serialized.otherHabilitations.map(habilitation => habilitation.id), ['other'])
})

test('serializeInstructorCandidate expose le rattachement courant et le nombre de territoires actifs', t => {
  const user = {
    id: 'user-1',
    role: 'INSTRUCTOR',
    email: 'agent@example.test',
    firstName: 'Ada',
    lastName: 'Lovelace',
    accountCreationMailSentAt: null,
    deletedAt: null,
    instructor: {
      phoneNumber: null,
      jobTitle: null,
      instructorZones: [
        right({id: 'current', zoneId: 'zone-1', zone: zone('zone-1', 'Zone courante')}),
        right({id: 'future', zoneId: 'zone-2', zone: zone('zone-2', 'Zone à venir'), startDate: date('2026-08-01')}),
        right({id: 'ended', zoneId: 'zone-3', zone: zone('zone-3', 'Zone terminée'), endDate: date('2026-06-30')})
      ]
    }
  }

  const candidate = serializeInstructorCandidate(user, {
    currentZoneId: 'zone-1',
    currentUserId: 'user-1',
    now
  })

  t.true(candidate.isCurrentUser)
  t.true(candidate.isAttachedToCurrentZone)
  t.is(candidate.currentZoneHabilitation.id, 'current')
  t.is(candidate.activeHabilitationsCount, 2)
  t.deepEqual(candidate.otherHabilitations.map(habilitation => habilitation.id), ['future', 'ended'])
})
