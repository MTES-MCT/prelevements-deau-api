import test from 'ava'

import {
  authorizeDocument,
  authorizeRegle
} from '../resource-authorization.js'

const now = new Date('2026-08-04T12:00:00.000Z')

function createClient() {
  return {
    async $queryRaw() {
      return [
        {declarantUserId: 'declarant-1', zoneId: 'zone-1'},
        {declarantUserId: 'declarant-1', zoneId: 'zone-2'}
      ]
    },
    instructorZone: {
      async findMany() {
        return [{zoneId: 'zone-1'}]
      }
    }
  }
}

test('les middlewares règle et document exposent seulement l’intersection autorisée', async t => {
  const cases = [
    {
      name: 'règle',
      middleware: client => authorizeRegle(
        'read',
        'declarant.rule.read',
        {client, now}
      ),
      resource: {
        regle: {
          declarantUserId: 'declarant-1',
          exploitations: []
        }
      }
    },
    {
      name: 'document',
      middleware: client => authorizeDocument(
        'read',
        'declarant.document.read',
        {client, now}
      ),
      resource: {
        document: {
          declarantUserId: 'declarant-1',
          declarantPointPrelevementId: null
        }
      }
    }
  ]

  for (const item of cases) {
    const req = {
      ...item.resource,
      user: {id: 'instructor-1', role: 'INSTRUCTOR'}
    }
    let nextError

    // eslint-disable-next-line no-await-in-loop
    await item.middleware(createClient())(req, {}, error => {
      nextError = error
    })

    t.is(nextError, undefined, `${item.name}`)
    t.deepEqual(req.permittedZoneIds, ['zone-1'], `${item.name}`)
  }
})
