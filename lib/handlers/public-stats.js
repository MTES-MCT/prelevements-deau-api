import createHttpError from 'http-errors'

import {getPublicStats, resolvePublicStatsMonth} from '../models/public-stats.js'
import {publicStatsQuerySchema} from '../validation/public-stats.js'
import {getPublicVisitors, unavailablePublicVisitors} from '../services/public-visitors.js'

export function createPublicStatsHandler({loadStats = getPublicStats, loadVisitors = getPublicVisitors, now = () => new Date()} = {}) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store')
    const {error, value} = publicStatsQuerySchema.validate(req.query)
    if (error) {
      throw createHttpError(400, 'Choisissez un mois terminé au format AAAA-MM.')
    }

    const currentDate = now()
    const month = resolvePublicStatsMonth(value.month, currentDate)
    const [stats, publicVisitors] = await Promise.all([
      loadStats({month, now: currentDate}),
      Promise.resolve().then(() => loadVisitors({now: currentDate}))
        .catch(() => unavailablePublicVisitors(currentDate))
    ])
    res.set('Cache-Control', 'public, max-age=300')
    res.json({...stats, publicVisitors})
  }
}

export const getPublicStatsHandler = createPublicStatsHandler()
