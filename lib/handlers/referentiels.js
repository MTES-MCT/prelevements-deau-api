import createHttpError from 'http-errors'
import {
  listSandreWaterUses,
  serializeWaterUse,
  sortSandreWaterUses
} from '../services/sandre-water-uses.js'

export async function getWaterUsesHandler(_req, res) {
  const waterUses = await listSandreWaterUses()
  const byId = new Map(waterUses.map(waterUse => [waterUse.id, {
    ...serializeWaterUse(waterUse),
    children: []
  }]))

  const roots = []

  for (const waterUse of byId.values()) {
    if (waterUse.parentId && byId.has(waterUse.parentId)) {
      byId.get(waterUse.parentId).children.push(waterUse)
    } else {
      roots.push(waterUse)
    }
  }

  for (const root of roots) {
    root.children = sortSandreWaterUses(root.children)
  }

  res.send({
    usages: sortSandreWaterUses(roots),
    items: waterUses.map(serializeWaterUse)
  })
}

function sendDisabledList(_req, res) {
  res.send([])
}

function sendDisabledDetail(_req, _res) {
  throw createHttpError(404, 'Référentiel désactivé.')
}

export const getBssListHandler = sendDisabledList
export const getBssDetailHandler = sendDisabledDetail

export const getBnpeListHandler = sendDisabledList
export const getBnpeDetailHandler = sendDisabledDetail

export const getMeContinentalesBvListHandler = sendDisabledList
export const getMeContinentalesBvDetailHandler = sendDisabledDetail

export const getBvBdcarthageListHandler = sendDisabledList
export const getBvBdcarthageDetailHandler = sendDisabledDetail

export const getMesoListHandler = sendDisabledList
export const getMesoDetailHandler = sendDisabledDetail
