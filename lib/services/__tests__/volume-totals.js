import test from 'ava'

import {computeChunkVolumeTotals} from '../volume-totals.js'

const values = [
  {metricTypeCode: 'volume', value: 12.5},
  {metricTypeCode: 'index', value: 400},
  {metricTypeCode: 'débit', value: 2}
]

test('computeChunkVolumeTotals classe un volume générique selon la fonction du PP', t => {
  t.deepEqual(computeChunkVolumeTotals(values, 'PRELEVEMENT'), {
    totalWaterVolume: 12.5,
    totalWaterVolumeWithdrawn: 12.5,
    totalWaterVolumeDischarged: 0
  })

  t.deepEqual(computeChunkVolumeTotals(values, 'REJET'), {
    totalWaterVolume: 12.5,
    totalWaterVolumeWithdrawn: 0,
    totalWaterVolumeDischarged: 12.5
  })
})

test('computeChunkVolumeTotals sait encore lire les types historiques sans fonction de PP', t => {
  t.deepEqual(computeChunkVolumeTotals([
    {metricTypeCode: 'volume prélevé', value: 10},
    {metricTypeCode: 'volume rejeté', value: 4}
  ]), {
    totalWaterVolume: 14,
    totalWaterVolumeWithdrawn: 10,
    totalWaterVolumeDischarged: 4
  })
})
