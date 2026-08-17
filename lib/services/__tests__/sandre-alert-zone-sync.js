import test from 'ava'

import {
  applySandreDepartmentSnapshot,
  deactivateMissingSandreAlertZones,
  getProcessedSnapshotHash,
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

function normalizedRow(overrides = {}) {
  return {
    ordinal: 1,
    code_sandre: 'FR_SUP_001',
    geometry: multiPolygon,
    raw_valid: true,
    invalid_reason: 'Valid Geometry',
    normalized_geometry_type: 'MULTIPOLYGON',
    normalized_valid: true,
    bbox_xmin_delta: 0,
    bbox_xmax_delta: 0,
    bbox_ymin_delta: 0,
    bbox_ymax_delta: 0,
    max_bbox_delta: 0,
    relative_area_delta: 0,
    ...overrides
  }
}

function reusableState(overrides = {}) {
  return {
    lastSuccessAt: new Date('2026-08-16T04:30:00.000Z'),
    featureCount: 1,
    snapshotHash: getProcessedSnapshotHash('snapshot-hash'),
    ...overrides
  }
}

function storedZone(storedFeature = feature(), overrides = {}) {
  return {
    code_sandre: storedFeature.codeSandre,
    payload_hash: storedFeature.payloadHash,
    status: storedFeature.status,
    active: storedFeature.status === 'VALIDATED',
    has_coordinates: storedFeature.geometry !== null,
    ...overrides
  }
}

test('la normalisation transforme et contrôle les géométries PostGIS', async t => {
  const normalizedGeometry = {...multiPolygon, marker: 'normalized'}
  const database = {
    async $queryRawUnsafe(sql, payload) {
      t.regex(sql, /ST_MakeValid/)
      t.regex(sql, /geometry_input AS MATERIALIZED/)
      t.regex(sql, /normalized AS MATERIALIZED/)
      t.regex(sql, /measured AS MATERIALIZED/)
      t.is(JSON.parse(payload)[0].codeSandre, 'FR_SUP_001')
      return [normalizedRow({
        geometry: normalizedGeometry,
        raw_valid: false,
        invalid_reason: 'Self-intersection'
      })]
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
      return items.map((item, index) => normalizedRow({
        ordinal: index + 1,
        code_sandre: item.codeSandre
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
      return [normalizedRow({
        relative_area_delta: 0.01
      })]
    }
  }

  const error = await t.throwsAsync(() => normalizeSandreZoneGeometries([feature()], {database}))
  t.regex(error.message, /non sûre/)
})

test('une réparation géométrique minime est acceptée sans catalogue spécifique', async t => {
  const database = {
    async $queryRawUnsafe() {
      return [normalizedRow({
        raw_valid: false,
        relative_area_delta: 3.5e-9
      })]
    }
  }

  const [normalized] = await normalizeSandreZoneGeometries([feature()], {database})
  t.deepEqual(normalized.geometry, multiPolygon)
})

test('la zone SANDRE 1879 tolère un bruit bbox inférieur à 1e-9 degré', async t => {
  const sandre1879 = feature({codeSandre: '1879', departmentCode: '39'})
  const database = {
    async $queryRawUnsafe() {
      return [normalizedRow({
        code_sandre: '1879',
        raw_valid: false,
        invalid_reason: 'Too few points in geometry component',
        bbox_xmin_delta: 4e-12,
        bbox_xmax_delta: 0,
        bbox_ymin_delta: 6e-12,
        bbox_ymax_delta: 0,
        max_bbox_delta: 6e-12,
        relative_area_delta: Number('8.62875723555914e-12')
      })]
    }
  }

  const [normalized] = await normalizeSandreZoneGeometries([sandre1879], {database})
  t.deepEqual(normalized.geometry, multiPolygon)
})

test('un déplacement bbox supérieur à 1e-9 degré est refusé même si la surface varie peu', async t => {
  const database = {
    async $queryRawUnsafe() {
      return [normalizedRow({
        bbox_xmin_delta: 1.1e-9,
        max_bbox_delta: 1.1e-9,
        relative_area_delta: 1e-12
      })]
    }
  }

  const error = await t.throwsAsync(() => normalizeSandreZoneGeometries([feature()], {database}))
  t.regex(error.message, /bboxDelta=1\.1e-9/)
  t.regex(error.message, /xmin=1\.1e-9/)
})

test('une métrique bbox absente est refusée', async t => {
  const database = {
    async $queryRawUnsafe() {
      return [normalizedRow({max_bbox_delta: null})]
    }
  }

  const error = await t.throwsAsync(() => normalizeSandreZoneGeometries([feature()], {database}))
  t.regex(error.message, /bboxDelta=invalide/)
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
  t.is(stateUpdates[0].create.snapshotHash, 'geometry-v1:snapshot-hash')
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
      async findUnique() {
        return null
      },
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

test('le dry-run court-circuite un snapshot versionné inchangé sans écrire', async t => {
  let zoneLookup
  const database = {
    sandreAlertZoneSyncState: {
      async findUnique() {
        return reusableState()
      }
    },
    async $queryRawUnsafe(sql, departmentCode, codes) {
      zoneLookup = {sql, departmentCode, codes: JSON.parse(codes)}
      return [storedZone()]
    },
    async $transaction() {
      t.fail('un dry-run inchangé ne doit pas ouvrir de transaction d’écriture')
    }
  }

  const result = await synchronizeSandreAlertZones({
    apply: false,
    departmentCodes: ['75'],
    database,
    acquireLock: false,
    async fetchSnapshot() {
      return snapshot([feature()])
    },
    async normalizeGeometries() {
      t.fail('un snapshot inchangé ne doit pas être renormalisé')
    },
    logger: {log() {}}
  })

  t.is(result.successCount, 1)
  t.regex(zoneLookup.sql, /coordinates IS NOT NULL AS has_coordinates/)
  t.is(zoneLookup.departmentCode, '75')
  t.deepEqual(zoneLookup.codes, ['FR_SUP_001'])
})

test('l’apply inchangé rafraîchit le succès et lastSeenAt sans renormaliser', async t => {
  let seenUpdate
  let stateUpdate
  const transaction = {
    sandreAlertZone: {
      async updateMany(payload) {
        seenUpdate = payload
        return {count: 1}
      }
    },
    sandreAlertZoneSyncState: {
      async upsert(payload) {
        stateUpdate = payload
      }
    }
  }
  const database = {
    sandreAlertZoneSyncState: {
      async findUnique() {
        return reusableState()
      }
    },
    async $queryRawUnsafe() {
      return [storedZone()]
    },
    async $transaction(callback) {
      return callback(transaction)
    }
  }

  const result = await synchronizeSandreAlertZones({
    apply: true,
    departmentCodes: ['75'],
    database,
    acquireLock: false,
    async fetchSnapshot() {
      return snapshot([feature()])
    },
    async normalizeGeometries() {
      t.fail('un snapshot inchangé ne doit pas être renormalisé')
    },
    logger: {log() {}}
  })

  t.is(result.successCount, 1)
  t.deepEqual(seenUpdate.where, {
    departmentCode: '75',
    codeSandre: {in: ['FR_SUP_001']}
  })
  t.true(seenUpdate.data.lastSeenAt instanceof Date)
  t.is(stateUpdate.create.snapshotHash, 'geometry-v1:snapshot-hash')
  t.true(stateUpdate.create.lastSuccessAt instanceof Date)
  t.is(stateUpdate.create.lastError, null)
})

test('un hash inchangé avec une zone stockée manquante force la normalisation', async t => {
  let normalizedCount = 0
  const database = {
    sandreAlertZoneSyncState: {
      async findUnique() {
        return reusableState()
      }
    },
    async $queryRawUnsafe() {
      return []
    }
  }

  await synchronizeSandreAlertZones({
    apply: false,
    departmentCodes: ['75'],
    database,
    acquireLock: false,
    async fetchSnapshot() {
      return snapshot([feature()])
    },
    async normalizeGeometries(features) {
      normalizedCount += features.length
      return features
    },
    logger: {log() {}}
  })

  t.is(normalizedCount, 1)
})

test('le dry-run renormalise une zone stockée qui a perdu sa géométrie', async t => {
  let normalizedCount = 0
  const database = {
    sandreAlertZoneSyncState: {
      async findUnique() {
        return reusableState()
      }
    },
    async $queryRawUnsafe() {
      return [storedZone(feature(), {has_coordinates: false})]
    }
  }

  await synchronizeSandreAlertZones({
    apply: false,
    departmentCodes: ['75'],
    database,
    acquireLock: false,
    async fetchSnapshot() {
      return snapshot([feature()])
    },
    async normalizeGeometries(features) {
      normalizedCount += features.length
      return features
    },
    logger: {log() {}}
  })

  t.is(normalizedCount, 1)
})

test('l’apply réécrit une zone stockée qui a perdu sa géométrie', async t => {
  let normalizedCount = 0
  let upsertCount = 0
  const transaction = {
    async $executeRawUnsafe() {
      upsertCount += 1
    },
    sandreAlertZoneSyncState: {
      async upsert() {}
    }
  }
  const database = {
    sandreAlertZoneSyncState: {
      async findUnique() {
        return reusableState()
      }
    },
    async $queryRawUnsafe() {
      return [storedZone(feature(), {has_coordinates: false})]
    },
    async $transaction(callback) {
      return callback(transaction)
    }
  }

  await synchronizeSandreAlertZones({
    apply: true,
    departmentCodes: ['75'],
    database,
    acquireLock: false,
    async fetchSnapshot() {
      return snapshot([feature()])
    },
    async normalizeGeometries(features) {
      normalizedCount += features.length
      return features
    },
    logger: {log() {}}
  })

  t.is(normalizedCount, 1)
  t.is(upsertCount, 1)
})

test('un hash non versionné force une nouvelle normalisation', async t => {
  let normalizedCount = 0
  const database = {
    sandreAlertZoneSyncState: {
      async findUnique() {
        return reusableState({snapshotHash: 'snapshot-hash'})
      }
    }
  }

  await synchronizeSandreAlertZones({
    apply: false,
    departmentCodes: ['75'],
    database,
    acquireLock: false,
    async fetchSnapshot() {
      return snapshot([feature()])
    },
    async normalizeGeometries(features) {
      normalizedCount += features.length
      return features
    },
    logger: {log() {}}
  })

  t.is(normalizedCount, 1)
})

test('la désactivation nationale conserve les codes des snapshots court-circuités', async t => {
  let deactivation
  const transaction = {
    sandreAlertZone: {
      async updateMany(payload) {
        return {count: payload.where.codeSandre.in.length}
      }
    },
    sandreAlertZoneSyncState: {
      async upsert() {}
    }
  }
  const database = {
    sandreAlertZoneSyncState: {
      async findUnique() {
        return reusableState()
      }
    },
    async $queryRawUnsafe(_sql, _departmentCode, codes) {
      const codeSandre = JSON.parse(codes)[0]
      return [storedZone(feature({codeSandre}))]
    },
    sandreAlertZone: {
      async updateMany(payload) {
        deactivation = payload
        return {count: 0}
      }
    },
    async $transaction(callback) {
      return callback(transaction)
    }
  }

  const result = await synchronizeSandreAlertZones({
    apply: true,
    database,
    acquireLock: false,
    async fetchSnapshot(departmentCode) {
      return snapshot([feature({
        codeSandre: `FR_${departmentCode}`,
        departmentCode
      })])
    },
    async normalizeGeometries() {
      t.fail('les snapshots inchangés ne doivent pas être renormalisés')
    },
    logger: {log() {}}
  })

  t.is(result.successCount, SANDRE_DEPARTMENT_CODES.length)
  t.is(deactivation.where.codeSandre.notIn.length, SANDRE_DEPARTMENT_CODES.length)
  t.true(deactivation.where.codeSandre.notIn.includes('FR_39'))
})

test('la synchronisation plafonne les départements concurrents', async t => {
  let activeNormalizations = 0
  let maximumActiveNormalizations = 0

  await synchronizeSandreAlertZones({
    apply: false,
    departmentCodes: ['01', '02', '03', '04'],
    database: {
      sandreAlertZoneSyncState: {
        async findUnique() {
          return null
        }
      }
    },
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
    sandreAlertZoneSyncState: {
      async findUnique() {
        return null
      }
    },
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
