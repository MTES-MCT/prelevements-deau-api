import test from 'ava'

import {
  getDeclarationUsageOptionsForRoot,
  getRootUsageCodeFromWaterUse,
  getWaterUseRootId,
  serializeWaterUse,
  serializeWaterUses,
  sortSandreWaterUses
} from '../sandre-water-uses.js'

const rootIrrigation = {id: 'root-2', code: '2', kind: 'USAGE', label: 'Irrigation', color: '#2E7D32'}
const subIrrigation = {id: 'sub-2a', code: '2A', kind: 'SUB_USAGE', parentId: 'root-2', label: 'Aspersion', color: '#2E7D32'}
const rootIndustrie = {id: 'root-4', code: '4', kind: 'USAGE', label: 'Industrie', color: '#B3404A'}

test('sortSandreWaterUses trie naturellement par code SANDRE', t => {
  const result = sortSandreWaterUses([
    {code: '10'},
    {code: '2B'},
    {code: '2'},
    {code: '2A'}
  ])

  t.deepEqual(result.map(item => item.code), ['2', '2A', '2B', '10'])
})

test('serializeWaterUse expose le contrat front stable', t => {
  t.deepEqual(serializeWaterUse({
    ...subIrrigation,
    mnemonic: 'Irrig. asp',
    definition: 'Définition',
    status: 'Validé',
    dashboardVisible: true
  }), {
    id: 'sub-2a',
    code: '2A',
    kind: 'SUB_USAGE',
    parentId: 'root-2',
    mnemonic: 'Irrig. asp',
    label: 'Aspersion',
    definition: 'Définition',
    status: 'Validé',
    color: '#2E7D32',
    dashboardVisible: true
  })
})

test('serializeWaterUses trie avant sérialisation', t => {
  t.deepEqual(serializeWaterUses([rootIndustrie, subIrrigation, rootIrrigation]).map(item => item.code), [
    '2',
    '2A',
    '4'
  ])
})

test('getWaterUseRootId et getRootUsageCodeFromWaterUse résolvent racine et sous-usage', t => {
  t.is(getWaterUseRootId(rootIrrigation), 'root-2')
  t.is(getWaterUseRootId(subIrrigation), 'root-2')
  t.is(getRootUsageCodeFromWaterUse(rootIrrigation), '2')
  t.is(getRootUsageCodeFromWaterUse(subIrrigation), '2')
})

test('getDeclarationUsageOptionsForRoot limite les options au groupe racine', t => {
  const options = getDeclarationUsageOptionsForRoot(rootIrrigation, [
    subIrrigation,
    rootIndustrie,
    rootIrrigation
  ])

  t.deepEqual(options.map(option => option.code), ['2', '2A'])
})
