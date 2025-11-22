import test from 'ava'
import {
  isParameterSupported,
  getAvailableOperators,
  getDefaultOperator,
  getParameterValueType,
  isOperatorValidForParameter,
  validateOperatorForParameter
} from '../parameters-config.js'

// Tests isParameterSupported
test('isParameterSupported - paramètre supporté', t => {
  t.true(isParameterSupported('volume prélevé'))
  t.true(isParameterSupported('débit prélevé'))
  t.true(isParameterSupported('température'))
})

test('isParameterSupported - paramètre non supporté', t => {
  t.false(isParameterSupported('paramètre inconnu'))
  t.false(isParameterSupported(''))
  t.false(isParameterSupported(null))
})

// Tests getAvailableOperators avec contexte
test('getAvailableOperators - volume prélevé spatial', t => {
  const operators = getAvailableOperators('volume prélevé', 'spatial')
  t.deepEqual(operators, ['sum'])
})

test('getAvailableOperators - volume prélevé temporal', t => {
  const operators = getAvailableOperators('volume prélevé', 'temporal')
  t.deepEqual(operators, ['sum'])
})

test('getAvailableOperators - débit prélevé spatial', t => {
  const operators = getAvailableOperators('débit prélevé', 'spatial')
  t.deepEqual(operators, ['sum'])
})

test('getAvailableOperators - débit prélevé temporal', t => {
  const operators = getAvailableOperators('débit prélevé', 'temporal')
  t.deepEqual(operators, ['mean', 'min', 'max'])
})

test('getAvailableOperators - contexte par défaut est spatial', t => {
  const operators = getAvailableOperators('volume prélevé')
  t.deepEqual(operators, ['sum'])
})

test('getAvailableOperators - paramètre inconnu', t => {
  t.is(getAvailableOperators('inconnu'), null)
  t.is(getAvailableOperators('inconnu', 'temporal'), null)
})

// Tests getDefaultOperator avec contexte
test('getDefaultOperator - volume prélevé spatial retourne sum', t => {
  t.is(getDefaultOperator('volume prélevé', 'spatial'), 'sum')
})

test('getDefaultOperator - volume prélevé temporal retourne sum', t => {
  t.is(getDefaultOperator('volume prélevé', 'temporal'), 'sum')
})

test('getDefaultOperator - débit prélevé spatial retourne sum', t => {
  t.is(getDefaultOperator('débit prélevé', 'spatial'), 'sum')
})

test('getDefaultOperator - débit prélevé temporal retourne mean', t => {
  t.is(getDefaultOperator('débit prélevé', 'temporal'), 'mean')
})

test('getDefaultOperator - contexte par défaut est spatial', t => {
  t.is(getDefaultOperator('volume prélevé'), 'sum')
})

test('getDefaultOperator - paramètre inconnu retourne null', t => {
  t.is(getDefaultOperator('inconnu'), null)
  t.is(getDefaultOperator('inconnu', 'temporal'), null)
})

// Tests getParameterValueType
test('getParameterValueType - volume prélevé est cumulative', t => {
  t.is(getParameterValueType('volume prélevé'), 'cumulative')
})

test('getParameterValueType - débit prélevé est instantaneous', t => {
  t.is(getParameterValueType('débit prélevé'), 'instantaneous')
})

test('getParameterValueType - paramètre inconnu retourne null', t => {
  t.is(getParameterValueType('inconnu'), null)
})

// Tests isOperatorValidForParameter avec contexte
test('isOperatorValidForParameter - sum valide pour volume prélevé spatial', t => {
  t.true(isOperatorValidForParameter('volume prélevé', 'sum', 'spatial'))
})

test('isOperatorValidForParameter - sum valide pour volume prélevé temporal', t => {
  t.true(isOperatorValidForParameter('volume prélevé', 'sum', 'temporal'))
})

test('isOperatorValidForParameter - sum valide pour débit prélevé spatial', t => {
  t.true(isOperatorValidForParameter('débit prélevé', 'sum', 'spatial'))
})

test('isOperatorValidForParameter - sum NON valide pour débit prélevé temporal', t => {
  t.false(isOperatorValidForParameter('débit prélevé', 'sum', 'temporal'))
})

test('isOperatorValidForParameter - mean valide pour débit prélevé temporal', t => {
  t.true(isOperatorValidForParameter('débit prélevé', 'mean', 'temporal'))
})

test('isOperatorValidForParameter - contexte par défaut est spatial', t => {
  t.true(isOperatorValidForParameter('volume prélevé', 'sum'))
  t.true(isOperatorValidForParameter('débit prélevé', 'sum'))
})

test('isOperatorValidForParameter - paramètre inconnu retourne false', t => {
  t.false(isOperatorValidForParameter('inconnu', 'sum'))
  t.false(isOperatorValidForParameter('inconnu', 'sum', 'temporal'))
})

// Tests validateOperatorForParameter avec contexte
test('validateOperatorForParameter - accepte opérateur valide spatial', t => {
  t.notThrows(() => {
    validateOperatorForParameter('volume prélevé', 'sum', 'spatial')
  })
  t.notThrows(() => {
    validateOperatorForParameter('débit prélevé', 'sum', 'spatial')
  })
})

test('validateOperatorForParameter - accepte opérateur valide temporal', t => {
  t.notThrows(() => {
    validateOperatorForParameter('volume prélevé', 'sum', 'temporal')
  })
  t.notThrows(() => {
    validateOperatorForParameter('débit prélevé', 'mean', 'temporal')
  })
})

test('validateOperatorForParameter - rejette paramètre non supporté', t => {
  const error = t.throws(() => {
    validateOperatorForParameter('paramètre inconnu', 'sum')
  })
  t.regex(error.message, /Paramètre non supporté/)
  t.regex(error.message, /paramètre inconnu/)
})

test('validateOperatorForParameter - rejette opérateur non disponible en spatial', t => {
  const error = t.throws(() => {
    validateOperatorForParameter('débit prélevé', 'mean', 'spatial')
  })
  t.regex(error.message, /Opérateur 'mean' non disponible/)
  t.regex(error.message, /débit prélevé/)
  t.regex(error.message, /spatiale/)
  t.regex(error.message, /sum/)
})

test('validateOperatorForParameter - rejette opérateur non disponible en temporal', t => {
  const error = t.throws(() => {
    validateOperatorForParameter('débit prélevé', 'sum', 'temporal')
  })
  t.regex(error.message, /Opérateur 'sum' non disponible/)
  t.regex(error.message, /débit prélevé/)
  t.regex(error.message, /temporelle/)
  t.regex(error.message, /mean, min, max/)
})

test('validateOperatorForParameter - message liste les opérateurs disponibles', t => {
  const error = t.throws(() => {
    validateOperatorForParameter('volume prélevé', 'invalid', 'spatial')
  })
  t.regex(error.message, /Opérateurs disponibles: sum/)
})

// Tests de cohérence entre valueType et opérateurs
test('volumes cumulatifs supportent sum en spatial', t => {
  t.true(isOperatorValidForParameter('volume prélevé', 'sum', 'spatial'))
  t.true(isOperatorValidForParameter('volume restitué', 'sum', 'spatial'))
})

test('volumes cumulatifs supportent sum en temporal', t => {
  t.true(isOperatorValidForParameter('volume prélevé', 'sum', 'temporal'))
  t.true(isOperatorValidForParameter('volume restitué', 'sum', 'temporal'))
})

test('débits supportent sum en spatial mais pas en temporal', t => {
  const debits = ['débit prélevé', 'débit réservé', 'débit restitué']

  for (const debit of debits) {
    t.true(isOperatorValidForParameter(debit, 'sum', 'spatial'), `${debit} devrait supporter sum en spatial`)
    t.false(isOperatorValidForParameter(debit, 'sum', 'temporal'), `${debit} ne devrait pas supporter sum en temporal`)
  }
})

test('paramètres instantanés non-débits ne supportent jamais sum', t => {
  const nonDebits = ['température', 'niveau piézométrique', 'chlorures', 'nitrates', 'sulfates', 'turbidité', 'conductivité', 'pH']

  for (const param of nonDebits) {
    t.deepEqual(getAvailableOperators(param, 'spatial'), [], `${param} ne devrait avoir aucun opérateur spatial`)
    t.false(isOperatorValidForParameter(param, 'sum', 'temporal'), `${param} ne devrait pas supporter sum en temporal`)
  }
})

test('seuls les volumes et débits supportent sum en spatial', t => {
  const volumesDebits = [
    'volume prélevé',
    'volume restitué',
    'débit prélevé',
    'débit réservé',
    'débit restitué'
  ]

  const nonAggregatables = [
    'température',
    'niveau piézométrique',
    'chlorures',
    'nitrates',
    'sulfates',
    'turbidité',
    'conductivité',
    'pH'
  ]

  for (const param of volumesDebits) {
    t.true(isOperatorValidForParameter(param, 'sum', 'spatial'), `${param} devrait supporter sum en spatial`)
    t.deepEqual(getAvailableOperators(param, 'spatial'), ['sum'], `${param} ne devrait avoir que sum en spatial`)
  }

  for (const param of nonAggregatables) {
    t.deepEqual(getAvailableOperators(param, 'spatial'), [], `${param} ne devrait avoir aucun opérateur spatial`)
    t.is(getDefaultOperator(param, 'spatial'), null, `${param} ne devrait avoir aucun opérateur spatial par défaut`)
  }
})

test('tous les paramètres instantanés supportent mean, min, max en temporal', t => {
  const instantaneous = [
    'débit prélevé',
    'débit réservé',
    'débit restitué',
    'température',
    'niveau piézométrique',
    'chlorures',
    'nitrates',
    'sulfates',
    'turbidité',
    'conductivité',
    'pH'
  ]

  for (const param of instantaneous) {
    t.true(isOperatorValidForParameter(param, 'mean', 'temporal'), `${param} devrait supporter mean en temporal`)
    t.true(isOperatorValidForParameter(param, 'min', 'temporal'), `${param} devrait supporter min en temporal`)
    t.true(isOperatorValidForParameter(param, 'max', 'temporal'), `${param} devrait supporter max en temporal`)
  }
})
