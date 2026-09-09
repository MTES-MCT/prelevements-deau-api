import createHttpError from 'http-errors'

import {getPublicStats, resolvePublicStatsMonth} from '../models/public-stats.js'
import {publicStatsQuerySchema} from '../validation/public-stats.js'

export function createPublicStatsHandler({loadStats = getPublicStats, now = () => new Date()} = {}) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store')
    const {error, value} = publicStatsQuerySchema.validate(req.query)
    if (error) {
      throw createHttpError(400, 'Choisissez un mois terminé au format AAAA-MM.')
    }

    const currentDate = now()
    const month = resolvePublicStatsMonth(value.month, currentDate)
    const stats = await loadStats({month, now: currentDate})
    res.set('Cache-Control', 'public, max-age=300')
    res.json(stats)
  }
}

export const getPublicStatsHandler = createPublicStatsHandler()
