import test from 'ava'

import {
  isDeclarationNotificationEnabled,
  listDeclarationNotificationSettings,
  updateDeclarationNotificationSetting
} from '../declaration-notification-settings.js'

test('listDeclarationNotificationSettings retourne les quatre garde-fous actifs par défaut', async t => {
  const client = {
    declarationNotificationSetting: {
      findMany: async () => []
    }
  }

  const settings = await listDeclarationNotificationSettings({client})

  t.is(settings.length, 4)
  t.true(settings.every(setting => setting.enabled))
})

test('isDeclarationNotificationEnabled respecte une désactivation persistée', async t => {
  const client = {
    declarationNotificationSetting: {
      findUnique: async () => ({enabled: false})
    }
  }

  const enabled = await isDeclarationNotificationEnabled({
    notificationType: 'followup',
    periodType: 'week',
    client
  })

  t.false(enabled)
})

test('updateDeclarationNotificationSetting enregistre la valeur du garde-fou', async t => {
  let upsertArguments
  const updatedAt = new Date('2026-07-10T12:00:00.000Z')
  const client = {
    declarationNotificationSetting: {
      async upsert(arguments_) {
        upsertArguments = arguments_
        return {
          notificationType: 'REMINDER',
          periodType: 'MONTH',
          enabled: false,
          updatedAt
        }
      }
    }
  }

  const setting = await updateDeclarationNotificationSetting({
    notificationType: 'reminder',
    periodType: 'month',
    enabled: false,
    client
  })

  t.false(setting.enabled)
  t.deepEqual(upsertArguments.update, {enabled: false})
  t.deepEqual(upsertArguments.create, {
    notificationType: 'REMINDER',
    periodType: 'MONTH',
    enabled: false
  })
})
