import test from 'ava'
import {validateAndExtract} from '../tabs/data.js'

test('le titre de l’onglet accepte la casse ASCII et les espaces insécables', t => {
  const names = ['Data | T=1 heure', 'dAtA | t=1 heure', 'DATA | T=1 HEURE', 'Data\u00A0| T=1 heure']
  const periods = names.map(name => validateAndExtract({name, sheet: {}}).data.period)

  t.deepEqual(periods, ['1 heure', '1 heure', '1 heure', '1 heure'])
})

test('le titre de l’onglet conserve le rejet des équivalences Unicode non ASCII', t => {
  const {data} = validateAndExtract({name: 'Data | T=1 ſeconde', sheet: {}})
  t.is(data.period, undefined)
})
