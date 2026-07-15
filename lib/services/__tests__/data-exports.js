import test from 'ava'

import {rowToExportObject} from '../data-exports.js'

test('rowToExportObject identifie les données télérelevées', t => {
  t.is(rowToExportObject({isTelemetry: true}).donneeTelerelevee, 'Oui')
  t.is(rowToExportObject({isTelemetry: false}).donneeTelerelevee, 'Non')
  t.is(rowToExportObject({}).donneeTelerelevee, 'Non')
})

test('rowToExportObject francise les types de valeur', t => {
  t.is(rowToExportObject({metricTypeCode: 'volume'}).typeValeur, 'Cumulée sur période')
  t.is(rowToExportObject({metricTypeCode: 'index'}).typeValeur, 'Ponctuelle')
  t.is(rowToExportObject({metricTypeCode: 'débit'}).typeValeur, 'Ponctuelle')
})

test('rowToExportObject conserve les colonnes temporelles adaptées au type de valeur', t => {
  const volume = rowToExportObject({
    metricTypeCode: 'volume',
    frequency: '1 month',
    periodStart: new Date('2026-06-01T00:00:00.000Z'),
    periodEnd: new Date('2026-07-01T00:00:00.000Z')
  })
  const index = rowToExportObject({
    metricTypeCode: 'index',
    frequency: 'instant',
    periodStart: new Date('2026-06-30T12:15:00.000Z'),
    periodEnd: new Date('2026-06-30T12:30:00.000Z')
  })

  t.is(volume.dateMesure, '')
  t.is(volume.dateDebutPeriode, '2026-06-01')
  t.is(volume.dateFinPeriode, '2026-06-30')
  t.is(index.dateMesure, '2026-06-30')
  t.is(index.heureMesure, '12:15:00')
  t.is(index.dateDebutPeriode, '')
})
