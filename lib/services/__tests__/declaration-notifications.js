import test from 'ava'

import {
  computeDeclarationNotificationRecipients,
  getNotificationPeriodKeyForDate,
  getScheduledFor,
  resolveMinimumPeriodType
} from '../declaration-notifications.js'

function buildExploitation(overrides = {}) {
  return {
    id: 'exploitation-1',
    status: 'EN_ACTIVITE',
    pointPrelevementId: 'point-1',
    declarantUserId: 'preleveur-1',
    startDate: null,
    endDate: null,
    connectors: [],
    usage: null,
    declarant: {
      declarantRole: 'PRELEVEUR',
      userId: 'preleveur-1',
      socialReason: 'ASA test',
      phoneNumber: null,
      user: {
        email: 'preleveur@example.fr',
        firstName: 'Paul',
        lastName: 'Préleveur',
        emailAliases: []
      }
    },
    collecteurs: [
      {
        collecteur: {
          declarantRole: 'COLLECTEUR',
          userId: 'collecteur-1',
          socialReason: 'Collecteur test',
          phoneNumber: null,
          user: {
            email: 'collecteur@example.fr',
            firstName: 'Claire',
            lastName: 'Collecteur',
            emailAliases: []
          }
        }
      }
    ],
    pointPrelevement: {
      id: 'point-1',
      name: 'Point test',
      resourceName: 'Ressource test',
      zones: [
        {
          zone: {
            id: 'zone-1',
            code: 'SAGE001',
            type: 'SAGE',
            name: 'SAGE test',
            declarationSettings: {
              defaultPeriodType: 'MONTH'
            },
            declarationOverrides: []
          }
        }
      ]
    },
    ...overrides
  }
}

test('resolveMinimumPeriodType retient le pas de temps le plus fréquent', t => {
  t.is(resolveMinimumPeriodType(['month']), 'month')
  t.is(resolveMinimumPeriodType(['month', 'week']), 'week')
  t.is(resolveMinimumPeriodType(['week', 'month']), 'week')
})

test('getNotificationPeriodKeyForDate utilise la semaine précédente pour les notifications hebdomadaires', t => {
  const monday = new Date(Date.UTC(2026, 6, 13, 9))

  t.is(getNotificationPeriodKeyForDate('reminder', 'week', monday), '2026-W28')
  t.is(getNotificationPeriodKeyForDate('followup', 'week', monday), '2026-W28')
})

test('getNotificationPeriodKeyForDate distingue rappel et relance mensuels', t => {
  const reminderDate = new Date(Date.UTC(2026, 5, 28, 9))
  const followupDate = new Date(Date.UTC(2026, 6, 5, 9))

  t.is(getNotificationPeriodKeyForDate('reminder', 'month', reminderDate), '2026-06')
  t.is(getNotificationPeriodKeyForDate('followup', 'month', followupDate), '2026-06')
})

test('getScheduledFor calcule les horaires en Europe/Paris', t => {
  t.is(
    getScheduledFor({
      notificationType: 'reminder',
      periodType: 'week',
      from: new Date('2026-07-07T10:00:00.000Z')
    }).toISOString(),
    '2026-07-13T07:00:00.000Z'
  )
  t.is(
    getScheduledFor({
      notificationType: 'followup',
      periodType: 'week',
      from: new Date('2026-12-01T10:00:00.000Z')
    }).toISOString(),
    '2026-12-07T16:00:00.000Z'
  )
  t.is(
    getScheduledFor({
      notificationType: 'followup',
      periodType: 'month',
      from: new Date('2026-07-01T10:00:00.000Z')
    }).toISOString(),
    '2026-07-05T07:00:00.000Z'
  )
})

test('computeDeclarationNotificationRecipients ne relance pas un point déjà déclaré par un collecteur', async t => {
  const client = {
    declarantPointPrelevement: {
      findMany: async () => [buildExploitation()]
    },
    chunk: {
      findMany: async () => [
        {
          pointPrelevementId: 'point-1'
        }
      ]
    }
  }

  const preview = await computeDeclarationNotificationRecipients({
    notificationType: 'followup',
    periodType: 'month',
    periodKey: '2026-06',
    client
  })

  t.deepEqual(preview.recipients, [])
  t.true(preview.exclusions.some(exclusion => exclusion.reason === 'ALREADY_DECLARED'))
  t.true(preview.exclusions.some(exclusion =>
    exclusion.reason === 'ALREADY_DECLARED'
    && exclusion.reasonLabel === 'Déclaration déjà reçue'
    && exclusion.reasonDescription.includes('existe déjà')
  ))
})
