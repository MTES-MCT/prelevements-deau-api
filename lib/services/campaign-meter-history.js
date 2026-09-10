import {campaignDate} from './campaign-index.js'

const day = value => value ? new Date(value).toISOString().slice(0, 10) : null

function applyReplacement(byPointAndMeter, pointId, event) {
  const at = campaignDate(event.at)
  for (const binding of byPointAndMeter.get(`${pointId}:${event.previousCompteurId}`) ?? []) {
    // Une réaffectation ultérieure du même compteur est indépendante.
    if ((!binding.startDate || day(binding.startDate) <= at) && (!binding.endDate || day(binding.endDate) > at)) {
      binding.endDate = new Date(`${at}T00:00:00.000Z`)
    }
  }

  for (const binding of byPointAndMeter.get(`${pointId}:${event.nextCompteurId}`) ?? []) {
    if ((!binding.startDate || day(binding.startDate) < at) && (!binding.endDate || day(binding.endDate) >= at)) {
      binding.startDate = new Date(`${at}T00:00:00.000Z`)
    }
  }
}

// Les campagnes déjà ouvertes restent figées. Pour les suivantes, les derniers
// changements transmis bornent l'inventaire sans réécrire les affectations
// historiques ni rendre irréversible une correction de réponse.
export async function loadCampaignMeterHistory(bindings, client) {
  if (bindings.length === 0) {
    return []
  }

  const pointIds = [...new Set(bindings.map(binding => binding.pointPrelevementId))]
  const responses = await client.campaignResponse.findMany({
    where: {kind: 'INDEX', latestSubmissionId: {not: null}, campaign: {targets: {some: {pointPrelevementId: {in: pointIds}}}}},
    select: {
      latestSubmission: {select: {snapshot: true}},
      campaign: {select: {targets: {where: {pointPrelevementId: {in: pointIds}}, select: {id: true, pointPrelevementId: true}}}}
    }
  })
  const result = bindings.map(binding => ({...binding}))
  const byPointAndMeter = new Map()
  for (const binding of result) {
    const key = `${binding.pointPrelevementId}:${binding.compteurId}`
    const entries = byPointAndMeter.get(key) ?? []
    entries.push(binding)
    byPointAndMeter.set(key, entries)
  }

  for (const response of responses) {
    const pointByTarget = new Map(response.campaign.targets.map(target => [target.id, target.pointPrelevementId]))
    for (const event of response.latestSubmission?.snapshot?.meterEvents ?? []) {
      const pointId = pointByTarget.get(event.targetId)
      if (!pointId || event.type !== 'REPLACEMENT') {
        continue
      }

      applyReplacement(byPointAndMeter, pointId, event)
    }
  }

  return result
}
