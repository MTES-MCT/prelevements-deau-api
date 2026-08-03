import fs from 'node:fs/promises'

import test from 'ava'

import {
  LEGACY_INSTRUCTOR_ZONE_PERMISSIONS,
  READ_ONLY_ZONE_PERMISSIONS,
  ZONE_PERMISSION_CODES,
  getMissingPermissionDependencies,
  withPermissionDependencies,
  withoutPermissionDependents
} from '../zone-permissions.js'

test('le catalogue contient 64 droits uniques et 25 droits de lecture par défaut', t => {
  t.is(ZONE_PERMISSION_CODES.length, 64)
  t.is(new Set(ZONE_PERMISSION_CODES).size, 64)
  t.is(READ_ONLY_ZONE_PERMISSIONS.length, 25)
  t.deepEqual(getMissingPermissionDependencies(READ_ONLY_ZONE_PERMISSIONS), [])
})

test('les dépendances sont ajoutées et les droits dépendants sont retirés', t => {
  const selected = withPermissionDependencies(['declarant.document.update'])

  t.deepEqual(selected, [
    'zone.detail.read',
    'declarant.list',
    'declarant.detail.read',
    'declarant.document.read',
    'declarant.document.update'
  ])
  t.deepEqual(
    withoutPermissionDependents(selected, 'declarant.detail.read'),
    ['zone.detail.read', 'declarant.list']
  )
})

test('la documentation contient exactement chaque droit du catalogue', async t => {
  const documentation = await fs.readFile(
    new URL('../../../docs/roles-agents.md', import.meta.url),
    'utf8'
  )
  const documentedCodes = [...documentation.matchAll(/`([a-z][a-z.-]+)`/g)]
    .map(match => match[1])
    .filter(code => code.includes('.'))
  const documentedPermissionCodes = [...new Set(
    documentedCodes.filter(code => ZONE_PERMISSION_CODES.includes(code))
  )]

  t.deepEqual(documentedPermissionCodes.sort(), [...ZONE_PERMISSION_CODES].sort())

  for (const code of ZONE_PERMISSION_CODES) {
    t.true(documentedCodes.includes(code))
  }
})

test('les migrations aboutissent exactement au catalogue et aux droits historiques attendus', async t => {
  const [creationMigration, removalMigration] = await Promise.all([
    fs.readFile(
      new URL(
        '../../../prisma/migrations/20260714153000_add_zone_agent_permissions/migration.sql',
        import.meta.url
      ),
      'utf8'
    ),
    fs.readFile(
      new URL(
        '../../../prisma/migrations/20260803173000_remove_individual_declaration_reminder/migration.sql',
        import.meta.url
      ),
      'utf8'
    )
  ])
  const entries = [...creationMigration.matchAll(/\('([a-z][a-z.-]+)', (true|false)\)/g)]
    .map(match => ({code: match[1], legacyNonAdmin: match[2] === 'true'}))
  const removedCodes = [...removalMigration.matchAll(/WHERE "permission" = '([a-z][a-z.-]+)'/g)]
    .map(match => match[1])
  const migrationCodes = entries
    .map(entry => entry.code)
    .filter(code => !removedCodes.includes(code))
  const legacyCodes = entries
    .filter(entry => entry.legacyNonAdmin)
    .map(entry => entry.code)

  t.deepEqual(migrationCodes, ZONE_PERMISSION_CODES)
  t.deepEqual(removedCodes, ['declarant.reminder.send'])
  t.deepEqual(
    [...legacyCodes].sort(),
    [...LEGACY_INSTRUCTOR_ZONE_PERMISSIONS].sort()
  )
})
