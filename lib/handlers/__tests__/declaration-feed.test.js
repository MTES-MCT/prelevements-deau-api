import test from 'ava'

import {
  DECLARATION_FEED_DECLARATION_SELECT,
  DECLARATION_FEED_ENTRY_TYPES,
  buildDeclarantDeclarationFeed,
  buildDeclarationFeedCounts,
  buildDeclarationFeedPositionWhere,
  compareDeclarationFeedEntriesDescending,
  decodeDeclarationFeedCursor,
  encodeDeclarationFeedCursor,
  getDeclarationFeedAccessWhere,
  paginateDeclarationFeedEntries,
  parseDeclarationFeedQuery
} from '../declaration-feed.js'
import {
  canReadDeclarationWhere,
  canReadTelemetrySourceWhere
} from '../declarations.js'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const PRELEVEUR_ID = '22222222-2222-4222-8222-222222222222'
const DECLARATION_NEW_ID = '33333333-3333-4333-8333-333333333333'
const DECLARATION_OLD_ID = '44444444-4444-4444-8444-444444444444'
const SOURCE_ID = '55555555-5555-4555-8555-555555555555'
const POINT_ID = '66666666-6666-4666-8666-666666666666'

function buildDeclarant(userId = USER_ID) {
  return {
    userId,
    declarantType: 'LEGAL_PERSON',
    declarantRole: 'PRELEVEUR',
    civility: null,
    socialReason: 'Exploitation test',
    user: {
      id: userId,
      email: 'declarant@example.test',
      firstName: 'Alice',
      lastName: 'Martin'
    }
  }
}

function buildDeclaration(id, createdAt) {
  return {
    id,
    code: 'ABC234',
    type: 'quick-declaration',
    dataSourceType: 'MANUAL',
    processingStatus: 'COMPLETED',
    createdAt: new Date(createdAt),
    declarant: buildDeclarant(),
    createdByDeclarant: buildDeclarant(),
    source: {
      id: id === DECLARATION_NEW_ID
        ? '77777777-7777-4777-8777-777777777777'
        : '88888888-8888-4888-8888-888888888888',
      type: 'DECLARATION',
      status: 'COMPLETED',
      globalInstructionStatus: 'VALIDATED',
      metadata: {
        manualQuickDeclaration: true,
        measurementType: 'INDEX',
        entriesCount: 1,
        internalPayload: {mustNotLeak: true}
      },
      createdAt: new Date(createdAt),
      chunks: [{
        id: '99999999-9999-4999-8999-999999999999',
        pointPrelevementId: POINT_ID,
        pointPrelevementName: 'Forage brut',
        minDate: new Date('2026-01-01T00:00:00.000Z'),
        maxDate: new Date('2026-01-01T00:00:00.000Z'),
        metadata: {readingDate: '2026-01-01', rawImport: 'must-not-leak'},
        pointPrelevement: {
          id: POINT_ID,
          name: 'Forage 1',
          otherNames: null,
          usageName: 'Parcelle nord'
        },
        _count: {chunkValues: 1}
      }],
      _count: {chunks: 1}
    }
  }
}

function buildTelemetrySource() {
  return {
    id: SOURCE_ID,
    type: 'API',
    status: 'COMPLETED',
    globalInstructionStatus: 'VALIDATED',
    metadata: {
      connector: 'Willie',
      totalWaterVolumeWithdrawn: 42,
      rawConnectorResponse: {mustNotLeak: true}
    },
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    declaration: null,
    chunks: [{
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      pointPrelevementId: POINT_ID,
      pointPrelevementName: 'Forage brut',
      minDate: new Date('2025-12-01T00:00:00.000Z'),
      maxDate: new Date('2025-12-31T00:00:00.000Z'),
      metadata: {},
      pointPrelevement: {
        id: POINT_ID,
        name: 'Forage 1',
        otherNames: null,
        usageName: null,
        declarants: [{
          declarantUserId: USER_ID,
          declarant: buildDeclarant()
        }]
      },
      _count: {chunkValues: 31}
    }],
    _count: {chunks: 1}
  }
}

function entry(entryType, id, createdAt) {
  const resource = {id}

  return {
    id: `${entryType.toLowerCase()}-${id}`,
    entryType,
    createdAt,
    declaration: entryType === DECLARATION_FEED_ENTRY_TYPES.DECLARATION
      ? resource
      : {id: `view-${id}`},
    source: entryType === DECLARATION_FEED_ENTRY_TYPES.TELEMETRY
      ? resource
      : null
  }
}

test('le curseur conserve l’ordre createdAt, type d’entrée et id sans doublon de frontière', t => {
  const createdAt = '2026-01-02T00:00:00.000Z'
  const declarationHigh = entry(
    DECLARATION_FEED_ENTRY_TYPES.DECLARATION,
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    createdAt
  )
  const declarationLow = entry(
    DECLARATION_FEED_ENTRY_TYPES.DECLARATION,
    '11111111-1111-4111-8111-111111111111',
    createdAt
  )
  const telemetry = entry(
    DECLARATION_FEED_ENTRY_TYPES.TELEMETRY,
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    createdAt
  )
  const entries = [telemetry, declarationLow, declarationHigh]
  const page = paginateDeclarationFeedEntries(entries, 2)

  t.deepEqual(page.data, [declarationHigh, declarationLow])
  t.true(page.hasNext)

  const cursor = decodeDeclarationFeedCursor(page.nextCursor)
  t.is(cursor.type, DECLARATION_FEED_ENTRY_TYPES.DECLARATION)
  t.is(cursor.id, declarationLow.declaration.id)
  t.deepEqual(
    buildDeclarationFeedPositionWhere(DECLARATION_FEED_ENTRY_TYPES.DECLARATION, cursor),
    {
      OR: [
        {createdAt: {lt: cursor.createdAt}},
        {createdAt: cursor.createdAt, id: {lt: cursor.id}}
      ]
    }
  )
  t.deepEqual(
    buildDeclarationFeedPositionWhere(DECLARATION_FEED_ENTRY_TYPES.TELEMETRY, cursor),
    {
      OR: [
        {createdAt: {lt: cursor.createdAt}},
        {createdAt: cursor.createdAt}
      ]
    }
  )
  t.is(compareDeclarationFeedEntriesDescending(declarationHigh, telemetry), -1)
})

test('le curseur est opaque, réversible et les paramètres sont bornés', t => {
  const sourceEntry = entry(
    DECLARATION_FEED_ENTRY_TYPES.TELEMETRY,
    SOURCE_ID,
    '2026-01-02T00:00:00.000Z'
  )
  const encoded = encodeDeclarationFeedCursor(sourceEntry)
  const parsed = parseDeclarationFeedQuery({cursor: encoded, limit: '50'})

  t.is(parsed.limit, 50)
  t.true(parsed.includeMeta)
  t.is(parsed.cursor.id, SOURCE_ID)
  t.is(parsed.cursor.type, DECLARATION_FEED_ENTRY_TYPES.TELEMETRY)
  t.false(parseDeclarationFeedQuery({includeMeta: 'false'}).includeMeta)
  t.throws(() => parseDeclarationFeedQuery({limit: '51'}), {name: 'BadRequestError'})
  t.throws(() => parseDeclarationFeedQuery({cursor: 'invalide'}), {name: 'BadRequestError'})
  t.throws(() => parseDeclarationFeedQuery({unexpected: 'value'}), {name: 'BadRequestError'})
})

test('les filtres d’accès du flux sont exactement ceux des endpoints existants', t => {
  const user = {id: USER_ID}
  const declarantUserIds = [USER_ID, PRELEVEUR_ID]
  const accessWhere = getDeclarationFeedAccessWhere(user, declarantUserIds)

  t.deepEqual(
    accessWhere.declarations,
    canReadDeclarationWhere(USER_ID, [PRELEVEUR_ID])
  )
  t.deepEqual(
    accessWhere.telemetrySources,
    canReadTelemetrySourceWhere(declarantUserIds)
  )
})

test('le flux retourne un DTO directement affichable et ne demande aucune relation lourde', async t => {
  const calls = {}
  const client = {
    declaration: {
      async findMany(options) {
        calls.declarations = options
        return [
          buildDeclaration(DECLARATION_NEW_ID, '2026-01-03T00:00:00.000Z'),
          buildDeclaration(DECLARATION_OLD_ID, '2026-01-01T00:00:00.000Z')
        ]
      },
      async groupBy(options) {
        calls.declarationGroups = options
        return [{dataSourceType: 'MANUAL', _count: {_all: 2}}]
      }
    },
    source: {
      async findMany(options) {
        calls.telemetry = options
        return [buildTelemetrySource()]
      },
      async count(options) {
        calls.telemetryCount = options
        return 1
      }
    }
  }
  const response = await buildDeclarantDeclarationFeed({
    user: {id: USER_ID},
    limit: 2,
    client,
    findReadableDeclarantUserIds: async () => [USER_ID, PRELEVEUR_ID],
    async findAllowedTypesMeta(_userId, options) {
      calls.allowedTypes = options
      return {
        meta: {
          declarantRole: 'COLLECTEUR',
          canCreateDeclaration: true,
          preleveurs: []
        }
      }
    },
    decorateDeclarationTypes: async declarations => declarations.map(declaration => ({
      ...declaration,
      declarationType: declaration.type === 'quick-declaration'
        ? {code: 'quick-declaration', name: 'Saisie rapide'}
        : null
    }))
  })

  t.true(response.success)
  t.is(response.data.length, 2)
  t.is(response.data[0].id, `declaration-${DECLARATION_NEW_ID}`)
  t.is(response.data[1].id, `telemetry-${SOURCE_ID}`)
  t.is(response.data[1].declaration.dataSourceType, 'API')
  t.is(response.data[1].declaration.declarationType.name, 'Willie')
  t.is(response.data[1].source.declarant.id, USER_ID)
  t.is(response.data[1].url, `/mes-declarations/sources/${SOURCE_ID}`)
  t.false(Object.hasOwn(response.data[0].declaration, 'files'))
  t.false(Object.hasOwn(response.data[0].declaration, 'processingEvents'))
  t.false(Object.hasOwn(response.data[0].source.metadata, 'internalPayload'))
  t.false(Object.hasOwn(response.data[0].source.chunks[0].metadata, 'rawImport'))
  t.false(Object.hasOwn(response.data[1].source.metadata, 'rawConnectorResponse'))
  t.deepEqual(response.meta.countsByKind, {
    MANUAL: 2,
    SPREADSHEET: 0,
    TELEMETRY: 1,
    NONE: 0
  })
  t.is(response.meta.total, 3)
  t.true(response.meta.pagination.hasNext)
  t.truthy(response.meta.pagination.nextCursor)
  t.deepEqual(calls.allowedTypes, {includePreleveurs: false})
  t.is(calls.declarations.take, 3)
  t.is(calls.telemetry.take, 3)
  t.deepEqual(calls.declarations.where, canReadDeclarationWhere(USER_ID, [PRELEVEUR_ID]))
  t.deepEqual(calls.telemetry.where, canReadTelemetrySourceWhere([USER_ID, PRELEVEUR_ID]))

  const declarationSelect = calls.declarations.select
  const declarationChunkSelect = declarationSelect.source.select.chunks.select
  const telemetryChunkSelect = calls.telemetry.select.chunks.select

  t.deepEqual(declarationSelect, DECLARATION_FEED_DECLARATION_SELECT)
  t.false(Object.hasOwn(declarationSelect, 'files'))
  t.false(Object.hasOwn(declarationSelect, 'processingEvents'))
  t.false(Object.hasOwn(declarationChunkSelect, 'chunkValues'))
  t.false(Object.hasOwn(telemetryChunkSelect, 'chunkValues'))
  t.deepEqual(Object.keys(declarationSelect.declarant.select).sort(), [
    'civility',
    'declarantRole',
    'declarantType',
    'socialReason',
    'user',
    'userId'
  ])
})

test('une page suivante peut omettre les compteurs et droits globaux', async t => {
  const client = {
    declaration: {
      async findMany() {
        return []
      },
      async groupBy() {
        throw new Error('groupBy ne doit pas être appelé')
      }
    },
    source: {
      async findMany() {
        return []
      },
      async count() {
        throw new Error('count ne doit pas être appelé')
      }
    }
  }
  const response = await buildDeclarantDeclarationFeed({
    user: {id: USER_ID},
    includeMeta: false,
    client,
    findReadableDeclarantUserIds: async () => [USER_ID],
    async findAllowedTypesMeta() {
      throw new Error('les droits ne doivent pas être recalculés')
    },
    decorateDeclarationTypes: async declarations => declarations
  })

  t.deepEqual(response.meta, {
    pagination: {
      limit: 20,
      hasNext: false,
      nextCursor: null
    }
  })
})

test('les compteurs regroupent exactement les deux familles du flux', t => {
  t.deepEqual(
    buildDeclarationFeedCounts([
      {dataSourceType: null, _count: {_all: 2}},
      {dataSourceType: 'MANUAL', _count: {_all: 3}},
      {dataSourceType: 'SPREADSHEET', _count: {_all: 4}},
      {dataSourceType: 'API', _count: {_all: 1}}
    ], 5),
    {
      countsByKind: {
        MANUAL: 3,
        SPREADSHEET: 4,
        TELEMETRY: 6,
        NONE: 2
      },
      total: 15
    }
  )
})
