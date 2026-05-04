/**
 * Aligne les libellés de fréquence (connecteurs, API) sur ceux attendus par le back / le front.
 * Ex. l’orchestration envoie Granularity.FIFTEEN_MINUTES = '15_minutes'.
 */
const ALIASES = {
  '15_minutes': '15 minutes',
  '15m': '15 minutes',
  '1_hour': '1 hour',
  '1h': '1 hour',
  '1_day': '1 day',
  '1d': '1 day',
  '1_week': '1 week',
  '7_days': '1 week',
  '1_month': '1 month',
  '1_quarter': '1 quarter',
  '1_year': '1 year'
}

export function normalizeSeriesFrequency(raw) {
  if (raw == null) {
    return null
  }

  if (typeof raw !== 'string') {
    return String(raw)
  }

  const t = raw.trim()
  if (!t) {
    return null
  }

  return ALIASES[t] ?? t
}
