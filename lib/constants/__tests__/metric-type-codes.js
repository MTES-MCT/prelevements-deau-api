import test from 'ava'

import {
  METRIC_TYPE_CODES,
  getCompatibleMetricTypeCodes,
  inferFlowTypeFromLegacyMetricTypeCode,
  normalizeMetricTypeCode
} from '../metric-type-codes.js'

test('normalizeMetricTypeCode sépare la mesure de la fonction historique', t => {
  t.is(normalizeMetricTypeCode('volume prélevé'), METRIC_TYPE_CODES.VOLUME)
  t.is(normalizeMetricTypeCode('volume rejeté'), METRIC_TYPE_CODES.VOLUME)
  t.is(normalizeMetricTypeCode('débit prélevé'), METRIC_TYPE_CODES.DEBIT)
  t.is(normalizeMetricTypeCode('relevé d\'index'), METRIC_TYPE_CODES.INDEX)
})

test('inferFlowTypeFromLegacyMetricTypeCode ne déduit une fonction que des anciens types directionnels', t => {
  t.is(inferFlowTypeFromLegacyMetricTypeCode('volume prélevé'), 'PRELEVEMENT')
  t.is(inferFlowTypeFromLegacyMetricTypeCode('volume rejeté'), 'REJET')
  t.is(inferFlowTypeFromLegacyMetricTypeCode(METRIC_TYPE_CODES.VOLUME), null)
  t.is(inferFlowTypeFromLegacyMetricTypeCode(METRIC_TYPE_CODES.INDEX), null)
})

test('getCompatibleMetricTypeCodes conserve la lecture des volumes historiques', t => {
  t.deepEqual(getCompatibleMetricTypeCodes(METRIC_TYPE_CODES.VOLUME), [
    METRIC_TYPE_CODES.VOLUME,
    'volume prélevé',
    'volume rejeté'
  ])
})
