import test from 'ava'

import {buildVolumeCharts} from '../dashboard.js'

function createUsage(id, code, label) {
  return {
    id,
    code,
    kind: 'USAGE',
    parentId: null,
    mnemonic: null,
    label,
    definition: null,
    status: null,
    color: '#000091',
    dashboardVisible: true
  }
}

function createVolumeRow({flowType, month, usage, volume}) {
  return {
    flowType,
    month,
    usageId: usage.id,
    usageCode: usage.code,
    usageMnemonic: usage.mnemonic,
    usageLabel: usage.label,
    usageColor: usage.color,
    volume
  }
}

test('buildVolumeCharts conserve les usages attendus sans volume dans la légende', t => {
  const irrigation = createUsage('irrigation', '2', 'Irrigation')
  const industry = createUsage('industry', '4', 'Industrie')
  const drinkingWater = createUsage('drinking-water', '1', 'Alimentation en eau potable')
  const sanitation = createUsage('sanitation', '6', 'Assainissement')
  const charts = buildVolumeCharts([
    createVolumeRow({
      flowType: 'PRELEVEMENT',
      month: 3,
      usage: irrigation,
      volume: 125
    }),
    createVolumeRow({
      flowType: 'PRELEVEMENT',
      month: 4,
      usage: drinkingWater,
      volume: 0
    })
  ], 2026, [
    {flowType: 'PRELEVEMENT', usage: irrigation},
    {flowType: 'PRELEVEMENT', usage: industry},
    {flowType: 'REJET', usage: sanitation}
  ])

  const withdrawnUsages = new Map(
    charts.withdrawn.usages.map(item => [item.usage.id, item])
  )

  t.like(withdrawnUsages.get(irrigation.id), {
    total: 125,
    hasData: true
  })
  t.like(withdrawnUsages.get(industry.id), {
    total: 0,
    hasData: false
  })
  t.like(withdrawnUsages.get(drinkingWater.id), {
    total: 0,
    hasData: false
  })
  t.like(charts.discharged.usages[0], {
    usage: sanitation,
    total: 0,
    hasData: false
  })
  t.deepEqual(charts.withdrawn.months[2].usages, [{
    usage: irrigation,
    volume: 125,
    percentage: 100
  }])
})
