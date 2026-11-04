const frenchDate = new Intl.DateTimeFormat('en-CA', {timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit'})

export function collectorDate(now = new Date()) {
  return frenchDate.format(now)
}

// Exploitation bounds are inclusive DATE columns, not instants. Keep this
// normalization local to collector workflows rather than changing all readers.
export function collectorDay(now = new Date()) {
  return new Date(`${collectorDate(now)}T00:00:00Z`)
}
