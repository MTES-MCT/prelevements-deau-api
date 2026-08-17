import test from 'ava'

import {
  applySandreDepartmentSnapshot,
  normalizeSandreZoneGeometries,
  synchronizeSandreAlertZones,
  withSandreSyncLock
} from '../sandre-alert-zone-sync.js'

const multiPolygon = {
  type: 'MultiPolygon',
  coordinates: [[[
    [2, 48],
    [3, 48],
    [3, 49],
    [2, 48]
  ]]]
}

function feature(overrides = {}) {
  return {
    gid: 42,
    codeSandre: 'FR_SUP_001',
    alternateCodes: [],
    preferredAlternateCode: null,
    departmentCode: '75',
    name: 'Zone test',
    type: 'SUP',
    status: 'VALIDATED',
    sourceUpdatedAt: '2026-08-15',
    version: 1,
    basinCode: 5,
    influencedResource: true,
    geometry: multiPolygon,
    payloadHash: 'abc',
    ...overrides
  }
}

function snapshot(features) {
  return {
    features,
    featureCount: features.length,
    sourceUpdatedAt: features[0]?.sourceUpdatedAt ?? null,
    snapshotHash: 'snapshot-hash'
  }
}

test('la normalisation transforme et contrôle les géométries PostGIS', async t => {
  const normalizedGeometry = {...multiPolygon, marker: 'normalized'}
  const database = {
    async $queryRawUnsafe(sql, payload) {
      t.regex(sql, /ST_MakeValid/)
      t.is(JSON.parse(payload)[0].codeSandre, 'FR_SUP_001')
      return [{
        ordinal: 1,
        code_sandre: 'FR_SUP_001',
        geometry: normalizedGeometry,
        raw_valid: false,
        invalid_reason: 'Self-intersection',
        normalized_geometry_type: 'MULTIPOLYGON',
        normalized_valid: true,
        bbox_unchanged: true,
        relative_area_delta: 0
      }]
    }
  }

  const [result] = await normalizeSandreZoneGeometries([feature()], {database})
  t.deepEqual(result.geometry, normalizedGeometry)
})

test('une réparation qui modifie trop la surface est refusée', async t => {
  const database = {
    async $queryRawUnsafe() {
      return [{
        ordinal: 1,
        code_sandre: 'FR_SUP_001',
        geometry: multiPolygon,
        normalized_valid: true,
        bbox_unchanged: true,
        relative_area_delta: 0.01
      }]
    }
  }

  const error = await t.throwsAsync(() => normalizeSandreZoneGeometries([feature()], {database}))
  t.regex(error.message, /non sûre/)
})

test('une réparation VigiEau auditée est acceptée uniquement pour le payload exact', async t => {
  const approvedFeature = feature({
    codeSandre: '3575',
    gid: 3575,
    departmentCode: '11',
    sourceUpdatedAt: '2026-08-13',
    payloadHash: '22cf08f853d00b25d6c0f9d427acecd37962609935154ef3ff8313cd0a208945'
  })
  const database = {
    async $queryRawUnsafe() {
      return [{
        ordinal: 1,
        code_sandre: '3575',
        geometry: multiPolygon,
        raw_valid: false,
        normalized_valid: true,
        bbox_unchanged: true,
        relative_area_delta: 3.5e-9
      }]
    }
  }

  const [normalized] = await normalizeSandreZoneGeometries([approvedFeature], {database})
  t.deepEqual(normalized.geometry, multiPolygon)

  await t.throwsAsync(
    () => normalizeSandreZoneGeometries([{...approvedFeature, payloadHash: 'changed'}], {database}),
    {message: /non sûre/}
  )
})

test('une zone gelée sans géométrie ne déclenche pas PostGIS', async t => {
  const frozen = feature({status: 'FROZEN', geometry: null})
  const database = {
    async $queryRawUnsafe() {
      t.fail('PostGIS ne doit pas être appelé')
    }
  }

  const [result] = await normalizeSandreZoneGeometries([frozen], {database})
  t.is(result.geometry, null)
})

test('l’upsert gèle sans effacer le dernier polygone et ne traite pas les absents', async t => {
  const calls = []
  const stateUpdates = []
  const transaction = {
    async $executeRawUnsafe(sql, payload) {
      calls.push({sql, zones: JSON.parse(payload)})
    },
    sandreAlertZoneSyncState: {
      async upsert(payload) {
        stateUpdates.push(payload)
      }
    }
  }
  const database = {
    async $transaction(callback) {
      return callback(transaction)
    }
  }
  const frozen = feature({status: 'FROZEN', geometry: null})

  await applySandreDepartmentSnapshot('75', snapshot([frozen]), {database})

  t.is(calls.length, 1)
  t.regex(calls[0].sql, /COALESCE\(EXCLUDED\."coordinates", "SandreAlertZone"\."coordinates"\)/)
  t.notRegex(calls[0].sql, /\bdelete\b/i)
  t.is(calls[0].zones[0].active, false)
  t.is(calls[0].zones[0].geometry, null)
  t.is(stateUpdates[0].create.featureCount, 1)
})

test('le dry-run valide toutes les zones sans écrire', async t => {
  let normalizedCount = 0
  const database = {
    zone: {
      async findMany() {
        t.fail('les départements explicites doivent être utilisés')
      }
    },
    sandreAlertZoneSyncState: {
      async upsert() {
        t.fail('un dry-run ne doit pas écrire son état')
      }
    },
    async $transaction() {
      t.fail('un dry-run ne doit pas ouvrir de transaction d’écriture')
    }
  }

  const result = await synchronizeSandreAlertZones({
    apply: false,
    departmentCodes: ['75'],
    database,
    acquireLock: false,
    async fetchSnapshot(departmentCode) {
      t.is(departmentCode, '75')
      return snapshot([feature()])
    },
    async normalizeGeometries(features) {
      normalizedCount += features.length
      return features
    },
    logger: {log() {}}
  })

  t.is(result.featureCount, 1)
  t.is(normalizedCount, 1)
})

test('le verrou ignore une seconde synchronisation concurrente', async t => {
  const queries = []
  let callbackCalled = false
  const client = {
    async connect() {},
    async query(sql) {
      queries.push(sql)
      return {rows: [{acquired: false}]}
    },
    async end() {}
  }

  const result = await withSandreSyncLock(async () => {
    callbackCalled = true
  }, {
    async clientFactory() {
      return client
    },
    logger: {warn() {}}
  })

  t.deepEqual(result, {skipped: true, reason: 'already-running'})
  t.false(callbackCalled)
  t.is(queries.length, 1)
})
