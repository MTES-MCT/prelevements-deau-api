import test from 'ava'

import {listPointMapSummaries} from '../points-prelevement.js'

function createRecordingCache({enabled = true} = {}) {
  const values = new Map()
  const scopes = []

  return {
    scopes,
    isEnabled: () => enabled,
    async getOrLoad({scope, loader}) {
      scopes.push(scope)
      const key = JSON.stringify(scope)

      if (values.has(key)) {
        return JSON.parse(values.get(key))
      }

      const value = await loader()
      values.set(key, JSON.stringify(value))
      return value
    }
  }
}

function createDependencies() {
  const calls = {
    admin: 0,
    declarant: 0,
    instructor: 0,
    permissions: [],
    serializations: []
  }

  return {
    calls,
    dependencies: {
      async getPermissionZoneIdsForUser(user, permission) {
        calls.permissions.push({permission, userId: user.id})
        return {
          'pp.detail.read': ['zone-detail'],
          'declarant.list': ['zone-declarant'],
          'exploitation.list': ['zone-exploitation']
        }[permission]
      },
      async getPointMapSummaries() {
        calls.admin++
        return [{id: 'point-admin'}]
      },
      async getPointMapSummariesByDeclarant(userId) {
        calls.declarant++
        return [{id: `point-${userId}`}]
      },
      async getPointMapSummariesByInstructor(zoneIds) {
        calls.instructor++
        return [{id: `point-${zoneIds.join('-')}`}]
      },
      serializePointMapSummaries(points, options = {}) {
        const serializedOptions = Object.fromEntries(Object.entries(options)
          .map(([key, value]) => [key, value instanceof Set ? [...value] : value]))
        calls.serializations.push({options: serializedOptions, points})
        return {options: serializedOptions, points}
      }
    }
  }
}

function createResponse() {
  return {
    body: undefined,
    send(body) {
      this.body = body
    }
  }
}

test('la carte isole admin, instructeur et déclarant et réutilise chaque hit', async t => {
  const cache = createRecordingCache()
  const {calls, dependencies} = createDependencies()
  const adminRequest = {
    user: {id: 'admin-1'},
    userRole: 'ADMIN'
  }
  const instructorRequest = {
    permittedZoneIds: ['zone-map'],
    user: {id: 'instructor-1'},
    userRole: 'INSTRUCTOR'
  }
  const declarantRequest = {
    user: {id: 'declarant-1'},
    userRole: 'DECLARANT'
  }

  const run = request => listPointMapSummaries(
    request,
    createResponse(),
    {cache, dependencies}
  )

  await run(adminRequest)
  await run(adminRequest)
  await run(instructorRequest)
  await run(instructorRequest)
  await run(declarantRequest)
  await run(declarantRequest)

  t.deepEqual({
    admin: calls.admin,
    declarant: calls.declarant,
    instructor: calls.instructor
  }, {admin: 1, declarant: 1, instructor: 1})
  t.is(calls.permissions.length, 6)
  t.deepEqual(cache.scopes[0], cache.scopes[1])
  t.deepEqual(cache.scopes[2], cache.scopes[3])
  t.deepEqual(cache.scopes[4], cache.scopes[5])
  t.notDeepEqual(cache.scopes[0], cache.scopes[2])
  t.notDeepEqual(cache.scopes[2], cache.scopes[4])
  t.deepEqual(cache.scopes[2].rights, {
    permittedZoneIds: ['zone-map'],
    detailZoneIds: ['zone-detail'],
    declarantZoneIds: ['zone-declarant'],
    exploitationZoneIds: ['zone-exploitation']
  })
})

test('cache désactivé conserve le chargement historique par rôle', async t => {
  const cache = createRecordingCache({enabled: false})
  const {calls, dependencies} = createDependencies()

  await listPointMapSummaries({
    user: {id: 'admin-1'},
    userRole: 'ADMIN'
  }, createResponse(), {cache, dependencies})
  await listPointMapSummaries({
    permittedZoneIds: ['zone-map'],
    user: {id: 'instructor-1'},
    userRole: 'INSTRUCTOR'
  }, createResponse(), {cache, dependencies})
  await listPointMapSummaries({
    user: {id: 'declarant-1'},
    userRole: 'DECLARANT'
  }, createResponse(), {cache, dependencies})

  t.deepEqual({
    admin: calls.admin,
    declarant: calls.declarant,
    instructor: calls.instructor
  }, {admin: 1, declarant: 1, instructor: 1})
  t.is(calls.permissions.length, 3)
  t.is(cache.scopes.length, 0)
  t.deepEqual(calls.serializations[1].options, {
    readableDeclarantZoneIds: ['zone-declarant'],
    readableDetailZoneIds: ['zone-detail'],
    readableExploitationZoneIds: ['zone-exploitation'],
    visibleZoneIds: ['zone-map']
  })
})
