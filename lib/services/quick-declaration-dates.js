import createHttpError from 'http-errors'

const indexFields = ['readingDate']
const volumeFields = ['periodStartDate', 'periodEndDate']
const labels = {readingDate: 'La date du relevé', periodStartDate: 'La date de début', periodEndDate: 'La date de fin'}
const fieldsFor = type => type === 'INDEX' ? indexFields : volumeFields

function parseQuickDeclarationDate(value, label) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''))

  if (!match) {
    throw createHttpError(400, `${label} doit être au format YYYY-MM-DD.`)
  }

  const [, year, month, day] = match
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))

  if (
    Number.isNaN(date.getTime())
    || date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)
  ) {
    throw createHttpError(400, `${label} est invalide.`)
  }

  return date
}

// Historical records retain their own dates until someone explicitly chooses common dates.
export function storedQuickDeclarationDates(measurementType, entries) {
  if (!entries.length) return {requiresDateSelection: false}
  const fields = fieldsFor(measurementType)
  const first = entries[0]
  if (fields.some(field => !first[field] || entries.some(entry => entry[field] !== first[field]))) {
    return {requiresDateSelection: true}
  }
  return {requiresDateSelection: false, ...Object.fromEntries(fields.map(field => [field, first[field]]))}
}

export function getQuickDeclarationDates(body, {requireExplicit = false} = {}) {
  if (!body.entries.length) return {}
  const fields = fieldsFor(body.measurementType ?? 'INDEX')
  if (requireExplicit && fields.some(field => !body[field])) {
    throw createHttpError(400, 'Les lignes de cette déclaration ont des dates différentes. Choisissez explicitement une date de relevé ou une période commune pour enregistrer les modifications.')
  }
  const dates = {}
  for (const field of fields) {
    const values = new Set(body.entries.map(entry => entry[field] ?? body[field]))
    if (body[field]) values.add(body[field])
    if (values.size !== 1) {
      throw createHttpError(400, 'Toutes les lignes de la déclaration doivent partager la même date de relevé ou la même période.')
    }
    const [value] = values
    dates[field] = parseQuickDeclarationDate(value, labels[field]).toISOString().slice(0, 10)
  }
  if (dates.periodEndDate < dates.periodStartDate) {
    throw createHttpError(400, 'La date de fin doit être postérieure ou égale à la date de début.')
  }
  return dates
}
