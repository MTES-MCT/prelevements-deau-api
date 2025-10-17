// Utilitaire pour construire un pointInfo cohérent
export function buildPointInfo(point) {
  if (!point) {
    return null
  }

  let displayName = point.nom
  if (!displayName && point.bnpe?.nom) {
    displayName = point.bnpe.nom
  }

  displayName ||= `Point ${point.id_point}`

  return {
    id_point: point.id_point,
    nom: displayName
  }
}

// Enrichit une liste générique d'objets avec pointInfo
// list: array
// getId: (item) => ObjectId | string | null
// setInfo: (item, info) => void
// fetchPoints: (ids:ObjectId[]) => Promise<Point[]>
export async function enrichWithPointInfo(list, {getId, setInfo, fetchPoints}) {
  const ids = [...new Set(list.map(i => getId(i)).filter(Boolean).map(id => id.toString()))]
  if (ids.length === 0) {
    return list
  }

  const points = await fetchPoints(ids)
  const index = new Map(points.map(p => [p._id.toString(), buildPointInfo(p)]))

  for (const item of list) {
    const id = getId(item)
    if (!id) {
      continue
    }

    setInfo(item, index.get(id.toString()) || null)
  }

  return list
}
