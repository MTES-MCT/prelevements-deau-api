import test from 'ava'

import {
  applySandreDepartmentSnapshot,
  deactivateMissingSandreAlertZones,
  normalizeSandreZoneGeometries,
  SANDRE_DEPARTMENT_CODES,
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

test('la normalisation borne la charge PostGIS par petits lots séquentiels', async t => {
  const payloadSizes = []
  let activeQueries = 0
  let maximumActiveQueries = 0
  const features = Array.from({length: 11}, (_, index) => feature({
    codeSandre: `FR_SUP_${String(index).padStart(3, '0')}`
  }))
  const database = {
    async $queryRawUnsafe(_sql, payload) {
      activeQueries += 1
      maximumActiveQueries = Math.max(maximumActiveQueries, activeQueries)
      const items = JSON.parse(payload)
      payloadSizes.push(items.length)
      await Promise.resolve()
      activeQueries -= 1
      return items.map((item, index) => ({
        ordinal: index + 1,
        code_sandre: item.codeSandre,
        geometry: multiPolygon,
        raw_valid: true,
        normalized_valid: true,
        bbox_unchanged: true,
        relative_area_delta: 0
      }))
    }
  }

  const normalized = await normalizeSandreZoneGeometries(features, {database})

  t.deepEqual(payloadSizes, [5, 5, 1])
  t.is(maximumActiveQueries, 1)
  t.is(normalized.length, features.length)
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

test('une réparation géométrique minime est acceptée sans catalogue spécifique', async t => {
  const database = {
    async $queryRawUnsafe() {
      return [{
        ordinal: 1,
        code_sandre: 'FR_SUP_001',
        geometry: multiPolygon,
        raw_valid: false,
        normalized_valid: true,
        bbox_unchanged: true,
        relative_area_delta: 3.5e-9
      }]
    }
  }

  const [normalized] = await normalizeSandreZoneGeometries([feature()], {database})
  t.deepEqual(normalized.geometry, multiPolygon)
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

test('l’upsert départemental gèle sans effacer le dernier polygone', async t => {
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

test('un import national complet désactive les zones absentes sans les supprimer', async t => {
  let update
  const database = {
    sandreAlertZone: {
      async updateMany(payload) {
        update = payload
        return {count: 2}
      }
    }
  }

  const result = await deactivateMissingSandreAlertZones(['FR_SUP_001'], {database})

  t.deepEqual(result, {count: 2})
  t.deepEqual(update, {
    where: {
      active: true,
      codeSandre: {notIn: ['FR_SUP_001']}
    },
    data: {
      active: false,
      status: 'FROZEN'
    }
  })
})

test('la synchronisation nationale est indépendante des zones de gestion', t => {
  t.is(SANDRE_DEPARTMENT_CODES.length, 101)
  t.true(SANDRE_DEPARTMENT_CODES.includes('2A'))
  t.true(SANDRE_DEPARTMENT_CODES.includes('971'))
  t.false(SANDRE_DEPARTMENT_CODES.includes('20'))
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

test('la synchronisation plafonne les départements concurrents', async t => {
  let activeNormalizations = 0
  let maximumActiveNormalizations = 0

  await synchronizeSandreAlertZones({
    apply: false,
    departmentCodes: ['01', '02', '03', '04'],
    database: {},
    acquireLock: false,
    concurrency: 10,
    async fetchSnapshot() {
      return snapshot([feature()])
    },
    async normalizeGeometries(features) {
      activeNormalizations += 1
      maximumActiveNormalizations = Math.max(maximumActiveNormalizations, activeNormalizations)
      await new Promise(resolve => {
        setImmediate(resolve)
      })
      activeNormalizations -= 1
      return features
    },
    logger: {log() {}}
  })

  t.is(maximumActiveNormalizations, 2)
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

test('la perte du verrou interrompt la synchronisation sans erreur non gérée', async t => {
  let errorHandler
  const client = {
    on(event, handler) {
      if (event === 'error') {
        errorHandler = handler
      }
    },
    off() {},
    async connect() {},
    async query() {
      return {rows: [{acquired: true}]}
    },
    async end() {}
  }

  const error = await t.throwsAsync(() => withSandreSyncLock(async assertLockHealthy => {
    errorHandler(new Error('connection lost'))
    assertLockHealthy()
  }, {
    async clientFactory() {
      return client
    },
    logger: {error() {}}
  }))

  t.regex(error.message, /verrou.*perdu/i)
})

test('la perte du verrou au dernier département empêche de désactiver les absentes', async t => {
  let errorHandler
  let transactionCount = 0
  let deactivationCalled = false
  const client = {
    on(event, handler) {
      if (event === 'error') {
        errorHandler = handler
      }
    },
    off() {},
    async connect() {},
    async query() {
      return {rows: [{acquired: true}]}
    },
    async end() {}
  }
  const transaction = {
    async $executeRawUnsafe() {},
    sandreAlertZoneSyncState: {
      async upsert() {}
    }
  }
  const database = {
    async $transaction(callback) {
      transactionCount += 1
      const result = await callback(transaction)
      if (transactionCount === SANDRE_DEPARTMENT_CODES.length) {
        errorHandler(new Error('connection lost'))
      }

      return result
    },
    sandreAlertZone: {
      async updateMany() {
        deactivationCalled = true
      }
    }
  }

  const error = await t.throwsAsync(() => synchronizeSandreAlertZones({
    apply: true,
    database,
    async fetchSnapshot(departmentCode) {
      return snapshot([feature({
        codeSandre: `FR_${departmentCode}`,
        departmentCode
      })])
    },
    async normalizeGeometries(features) {
      return features
    },
    async lockClientFactory() {
      return client
    },
    logger: {error() {}, log() {}}
  }))

  t.regex(error.message, /verrou.*perdu/i)
  t.false(deactivationCalled)
})
