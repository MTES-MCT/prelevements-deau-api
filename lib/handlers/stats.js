import {getStats} from '../models/stats.js'

// Statistiques globales
export async function getStatsHandler(req, res) {
  const stats = await getStats()

  res.send(stats)
}

// Statistiques par territoire
export async function getStatsTerritoireHandler(req, res) {
  const stats = await getStats(req.params.territoire)

  res.send(stats)
}
