import test from 'ava'

import {
  getSourceFlowTypeFromMetadata,
  normalizePointFlowType
} from '../point-flow-types.js'

test('normalizePointFlowType normalise uniquement les fonctions connues', t => {
  t.is(normalizePointFlowType(' rejet '), 'REJET')
  t.is(normalizePointFlowType('PRELEVEMENT'), 'PRELEVEMENT')
  t.is(normalizePointFlowType('volume'), null)
})

test('getSourceFlowTypeFromMetadata lit uniquement l’indice explicite de la source', t => {
  t.is(getSourceFlowTypeFromMetadata({sourceFlowType: 'REJET', flowType: 'PRELEVEMENT'}), 'REJET')
  t.is(getSourceFlowTypeFromMetadata({source_flow_type: 'prelevement'}), 'PRELEVEMENT')
  t.is(getSourceFlowTypeFromMetadata({flowType: 'REJET'}), null)
})
