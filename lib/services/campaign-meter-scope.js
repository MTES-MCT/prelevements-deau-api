const day = value => value instanceof Date ? value.toISOString().slice(0, 10) : value

// Une phase sans identité n’est pas un compteur fictif : elle est uniquement
// bornée par les dates de campagne et le premier compteur réellement connu.
export function campaignMeterlessPeriod(target, {campaign, periods = campaign?.periods ?? [], meterEvents = [], includePending = true} = {}) {
  const dates = [...(campaign?.indexDates ?? []), ...periods.filter(period => period.kind === 'INDEX').flatMap(period => [period.startReadingDate, period.endReadingDate])]
    .filter(Boolean).map(value => day(value)).sort()
  const startDate = dates[0] ?? null
  const lastDate = dates.at(-1) ?? null
  const meters = (target.meters ?? []).filter(meter => (includePending || !meter.pending)
    && (!startDate || !meter.endDate || day(meter.endDate) >= startDate)
    && (!lastDate || !meter.startDate || day(meter.startDate) <= lastDate))
  if (meters.length === 0) {
    return {startDate, endDate: null}
  }

  if (meters.some(meter => !meter.startDate || (startDate && day(meter.startDate) < startDate))) {
    return null
  }

  const endDate = meters.map(meter => day(meter.startDate)).sort()[0]
  if (startDate && endDate === startDate) {
    // À la première borne, le compteur entrant ne couvre pas une phase
    // antérieure. La transition doit néanmoins être explicitement documentée.
    const initialMeters = meters.filter(meter => day(meter.startDate) === startDate)
    const transition = meterEvents.find(event => event.targetId === target.id && event.type === 'REPLACEMENT'
      && event.previousCompteurId === null && event.at === startDate
      && (event.nextCompteurId === initialMeters[0]?.compteurId
        || (event.nextMeter && initialMeters[0]?.pending && initialMeters[0].pendingEvent?.at === event.at)))
    if (initialMeters.length !== 1 || !transition) {
      return null
    }
  }

  return {startDate, endDate}
}

export function isCampaignMeterlessDate(period, date) {
  return Boolean(period && (!period.startDate || date >= period.startDate) && (!period.endDate || date <= period.endDate))
}
