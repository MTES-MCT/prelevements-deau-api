export function campaignLocalDate(date, timezone = 'Europe/Paris') {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(new Date(date))
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

// La clôture est une borne exclusive : minuit correspond au dernier jour précédent.
export function campaignDeadlineDate(closesAt, timezone = 'Europe/Paris') {
  return campaignLocalDate(new Date(new Date(closesAt).getTime() - 1), timezone)
}
