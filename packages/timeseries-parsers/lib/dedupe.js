/*
 * Déduplication des valeurs de séries temporelles.
 * Pour chaque série, on supprime les entrées ayant la même clé temporelle (date ou date+time si hasSubDay=true)
 * en conservant la première occurrence et en signalant via un warning global les séries affectées.
 */

export function dedupe(result) {
  if (!result || !result.data || !Array.isArray(result.data.series)) {
    return result
  }

  const {series} = result.data
  const dedupedSeriesIds = []

  for (const s of series) {
    if (!s || !Array.isArray(s.data)) {
      continue
    }

    const hasSubDay = s.data.some(d => d.time)
    const seen = new Set()
    const originalLength = s.data.length
    const filtered = []

    for (const row of s.data) {
      const key = hasSubDay ? `${row.date}|${row.time || ''}` : row.date
      if (seen.has(key)) {
        continue
      }

      seen.add(key)
      filtered.push(row)
    }

    if (filtered.length !== originalLength) {
      s.data = filtered
      // Recalcul min/max
      let minDate = filtered[0].date
      let maxDate = filtered[0].date
      for (const r of filtered) {
        if (r.date < minDate) {
          minDate = r.date
        }

        if (r.date > maxDate) {
          maxDate = r.date
        }
      }

      s.minDate = minDate
      s.maxDate = maxDate
      dedupedSeriesIds.push(buildSeriesIdentifier(s))
    }
  }

  if (dedupedSeriesIds.length > 0) {
    if (!Array.isArray(result.errors)) {
      result.errors = []
    }

    result.errors.push({
      message: `Certaines séries contenaient des doublons de valeurs qui ont été supprimés : ${dedupedSeriesIds.join(', ')}`,
      severity: 'warning'
    })
  }

  return result
}

function buildSeriesIdentifier(s) {
  const parts = []
  if (s.pointPrelevement) {
    parts.push(`pp=${s.pointPrelevement}`)
  }

  if (s.parameter) {
    parts.push(`param=${s.parameter}`)
  }

  if (s.frequency) {
    parts.push(`freq=${s.frequency}`)
  }

  return parts.join(' ')
}
