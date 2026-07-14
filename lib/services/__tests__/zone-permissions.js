import test from 'ava'

import {
  activeInstructorZoneWhere,
  getPermissionZoneIdsForUser,
  hasZonePermission,
  validateZonePermissions
} from '../zone-permissions.js'

const now = new Date('2026-07-14T12:00:00.000Z')

test('validateZonePermissions normalise une combinaison cohérente', t => {
  t.deepEqual(validateZonePermissions([
    'pp.update',
    'zone.detail.read',
    'zone.geometry.read',
    'pp.list',
    'pp.detail.read',
    'pp.update'
  ]), [
    'zone.detail.read',
    'zone.geometry.read',
    'pp.list',
    'pp.detail.read',
    'pp.update'
  ])
})

test('validateZonePermissions refuse les droits inconnus et les dépendances absentes', t => {
  const unknownError = t.throws(() => validateZonePermissions(['unknown.permission']))
  t.is(unknownError.statusCode, 400)
  t.regex(unknownError.message, /Droits inconnus/)

  const dependencyError = t.throws(() => validateZonePermissions(['pp.update']))
  t.is(dependencyError.statusCode, 400)
  t.regex(dependencyError.message, /pp\.update requiert pp\.detail\.read/)
})

test('activeInstructorZoneWhere inclut la période active et le droit demandé', t => {
  const where = activeInstructorZoneWhere('agent-1', {
    now,
    permission: 'declaration.instruct'
  })

  t.is(where.instructorUserId, 'agent-1')
  t.deepEqual(where.permissions, {
    some: {permission: 'declaration.instruct'}
  })
  t.deepEqual(where.AND, [
    {startDate: {lte: now}},
    {OR: [{endDate: null}, {endDate: {gte: now}}]}
  ])
})

test('getPermissionZoneIdsForUser donne toutes les zones filtrées à un administrateur', async t => {
  let query
  const client = {
    zone: {
      async findMany(arguments_) {
        query = arguments_
        return [{id: 'zone-2'}]
      }
    }
  }

  const zoneIds = await getPermissionZoneIdsForUser(
    {id: 'admin-1', role: 'ADMIN'},
    'pp.list',
    {client, zoneIds: ['zone-2', 'zone-2']}
  )

  t.deepEqual(zoneIds, ['zone-2'])
  t.deepEqual(query.where, {id: {in: ['zone-2']}})
})

test('getPermissionZoneIdsForUser filtre les habilitations actives par droit', async t => {
  let query
  const client = {
    instructorZone: {
      async findMany(arguments_) {
        query = arguments_
        return [{zoneId: 'zone-1'}]
      }
    }
  }

  const zoneIds = await getPermissionZoneIdsForUser(
    {id: 'agent-1', role: 'INSTRUCTOR'},
    'declaration.reconcile',
    {client, now, zoneIds: ['zone-1', 'zone-2']}
  )

  t.deepEqual(zoneIds, ['zone-1'])
  t.is(query.where.instructorUserId, 'agent-1')
  t.deepEqual(query.where.zoneId, {in: ['zone-1', 'zone-2']})
  t.deepEqual(query.where.permissions, {
    some: {permission: 'declaration.reconcile'}
  })
  t.deepEqual(query.where.AND, [
    {startDate: {lte: now}},
    {OR: [{endDate: null}, {endDate: {gte: now}}]}
  ])
})

test('hasZonePermission accepte une ressource liée à au moins une zone autorisée', async t => {
  const client = {
    instructorZone: {
      async findMany() {
        return [{zoneId: 'zone-2'}]
      }
    }
  }

  t.true(await hasZonePermission(
    {id: 'agent-1', role: 'INSTRUCTOR'},
    'pp.update',
    ['zone-1', 'zone-2'],
    {client, now}
  ))
  t.false(await hasZonePermission(
    {id: 'agent-1', role: 'INSTRUCTOR'},
    'pp.update',
    [],
    {client, now}
  ))
})

test('getPermissionZoneIdsForUser refuse implicitement les rôles non agents', async t => {
  t.deepEqual(await getPermissionZoneIdsForUser(
    {id: 'declarant-1', role: 'DECLARANT'},
    'zone.detail.read',
    {client: {}}
  ), [])
})
