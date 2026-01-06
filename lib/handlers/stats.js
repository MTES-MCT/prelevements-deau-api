import {getStats} from '../models/stats.js'

// Statistiques globales
export async function getStatsHandler(req, res) {
  const stats = await getStats()

  res.send(stats)
}
