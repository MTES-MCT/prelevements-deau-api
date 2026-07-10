import test from 'ava'

import {
  getMonitoringStationSyncStatus,
  normalizeStationCode,
  resolveMonitoringStationMetadata,
  upsertMonitoringStationMetadata
} from '../monitoring-stations.js'

test('normalizeStationCode normalise les espaces et la casse', t => {
  t.is(normalizeStationCode(' 07704x0079/s '), '07704X0079/S')
})

test('resolveMonitoringStationMetadata ne transforme pas des coordonnées absentes en zéro', async t => {
  const metadata = await resolveMonitoringStationMetadata('PIEZOMETER', '07704X0079/S', {
    async getPiezometer() {
      return {
        code_bss: '07704X0079/S',
        bss_id: 'BSS001WMMN',
        libelle_pe: 'Station sans coordonnées',
        x: null,
        y: null
      }
    }
  })

  t.is(metadata.longitude, null)
  t.is(metadata.latitude, null)
  t.is(metadata.bssId, 'BSS001WMMN')
})

test('resolveMonitoringStationMetadata privilégie la géométrie fournisseur', async t => {
  const metadata = await resolveMonitoringStationMetadata('FLOW_STATION', 'Y020401001', {
    async getFlowStation() {
      return {
        code_station: 'Y020401001',
        code_site: 'Y0204010',
        libelle_station: 'La Preste',
        longitude_station: 1,
        latitude_station: 2,
        geometry: {coordinates: [2.403, 42.407]}
      }
    }
  })

  t.deepEqual(
    {longitude: metadata.longitude, latitude: metadata.latitude},
    {longitude: 2.403, latitude: 42.407}
  )
  t.is(metadata.siteCode, 'Y0204010')
  t.is(metadata.bssId, null)
})

test('upsertMonitoringStationMetadata réutilise une station par son bssId stable', async t => {
  let updateArguments
  const transaction = {
    monitoringStation: {
      async findUnique() {
        return {id: 'station-id'}
      },
      async update(arguments_) {
        updateArguments = arguments_
        return {id: 'station-id', ...arguments_.data}
      },
      async upsert() {
        t.fail('L’upsert par ancien code ne doit pas être utilisé quand le bssId existe déjà.')
      }
    }
  }
  const result = await upsertMonitoringStationMetadata(transaction, {
    type: 'PIEZOMETER',
    stationCode: '10971X0198/LAFAR',
    bssId: 'BSS002MUNP',
    siteCode: null,
    providerLabel: 'ORTAFFA',
    longitude: 2.92,
    latitude: 42.57,
    metadata: {}
  })

  t.deepEqual(updateArguments.where, {id: 'station-id'})
  t.is(updateArguments.data.bssId, 'BSS002MUNP')
  t.is(result.stationCode, '10971X0198/LAFAR')
})

test('getMonitoringStationSyncStatus distingue attente, succès et erreur', t => {
  t.is(getMonitoringStationSyncStatus({}), 'PENDING')
  t.is(getMonitoringStationSyncStatus({lastSyncError: 'erreur'}), 'ERROR')
  t.is(getMonitoringStationSyncStatus({lastSyncSuccessAt: new Date()}), 'READY')
})
