import createHttpError from 'http-errors'
import {
  getSourceForAdmin,
  getSourceForInstructor,
  listSourcesForAdmin,
  listSourcesForInstructor
} from '../services/instructor-sources.js'

const ALLOWED_SOURCE_STATUSES = [
  'TO_INSTRUCT',
  'VALIDATED',
  'REJECTED',
  'PARTIALLY_VALIDATED',
  'INSTRUCTION_IN_PROGRESS'
]
const ALLOWED_SOURCE_TYPES = [
  'MANUAL',
  'SPREADSHEET',
  'API'
]
const EMPTY_SOURCE_TYPES_FILTER = 'NONE'
const DEFAULT_PAGE = 1
const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100

function parseStatuses(rawStatuses) {
  if (!rawStatuses) {
    return undefined
  }

  const values = Array.isArray(rawStatuses) ? rawStatuses : [rawStatuses]

  const statuses = values
    .flatMap(value => String(value).split(','))
    .map(value => value.trim())
    .filter(Boolean)

  if (statuses.length === 0) {
    return undefined
  }

  const invalidStatuses = statuses.filter(status => !ALLOWED_SOURCE_STATUSES.includes(status))

  if (invalidStatuses.length > 0) {
    throw createHttpError(
      400,
      `Statut(s) invalide(s) : ${invalidStatuses.join(', ')}. Valeurs autorisées : ${ALLOWED_SOURCE_STATUSES.join(', ')}.`
    )
  }

  return [...new Set(statuses)]
}

function parseTypes(rawTypes) {
  if (!rawTypes) {
    return undefined
  }

  const values = Array.isArray(rawTypes) ? rawTypes : [rawTypes]

  const types = values
    .flatMap(value => String(value).split(','))
    .map(value => value.trim())
    .filter(Boolean)

  if (types.length === 0) {
    return undefined
  }

  if (types.includes(EMPTY_SOURCE_TYPES_FILTER)) {
    return []
  }

  const invalidTypes = types.filter(type => !ALLOWED_SOURCE_TYPES.includes(type))

  if (invalidTypes.length > 0) {
    throw createHttpError(
      400,
      `Type(s) invalide(s) : ${invalidTypes.join(', ')}. Valeurs autorisées : ${ALLOWED_SOURCE_TYPES.join(', ')}.`
    )
  }

  return [...new Set(types)]
}

function parsePositiveInteger(value, {defaultValue, max} = {}) {
  if (value === undefined) {
    return defaultValue
  }

  const number = Number.parseInt(String(value), 10)

  if (!Number.isInteger(number) || number < 1) {
    throw createHttpError(400, 'Paramètre de pagination invalide.')
  }

  return max ? Math.min(number, max) : number
}

function parseBoolean(value, label) {
  if (value === undefined) {
    return undefined
  }

  const normalizedValue = String(value).trim().toLowerCase()

  if (['true', '1'].includes(normalizedValue)) {
    return true
  }

  if (['false', '0', ''].includes(normalizedValue)) {
    return undefined
  }

  throw createHttpError(400, `${label} doit être un booléen.`)
}

function parseDate(value, label) {
  if (!value) {
    return undefined
  }

  const text = String(value).trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw createHttpError(400, `${label} doit être au format YYYY-MM-DD.`)
  }

  const date = new Date(`${text}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) {
    throw createHttpError(400, `${label} est invalide.`)
  }

  return date
}

function parseListQuery(query) {
  const page = parsePositiveInteger(query.page, {defaultValue: DEFAULT_PAGE})
  const pageSize = parsePositiveInteger(query.pageSize ?? query.perPage, {
    defaultValue: DEFAULT_PAGE_SIZE,
    max: MAX_PAGE_SIZE
  })
  const startDate = parseDate(query.startDate, 'startDate')
  const endDate = parseDate(query.endDate, 'endDate')

  if (startDate && endDate && startDate > endDate) {
    throw createHttpError(400, 'startDate doit être antérieure ou égale à endDate.')
  }

  return {
    declarant: typeof query.declarant === 'string' ? query.declarant.trim() : undefined,
    dossierNumber: typeof query.dossierNumber === 'string' ? query.dossierNumber.trim() : undefined,
    endDate,
    page,
    pageSize,
    pointsToAssociate: parseBoolean(query.pointsToAssociate, 'pointsToAssociate'),
    startDate,
    statuses: parseStatuses(query.statuses),
    types: parseTypes(query.types)
  }
}

export async function listMySourcesHandler(req, res, next) {
  try {
    const query = parseListQuery(req.query)
    const data = req.user.role === 'ADMIN'
      ? await listSourcesForAdmin(query)
      : await listSourcesForInstructor(req.user.id, {
        ...query
      })

    return res.json({
      success: true,
      data
    })
  } catch (error) {
    return next(error)
  }
}

export async function getMySourceHandler(req, res, next) {
  try {
    const {sourceId} = req.params

    const item = req.user.role === 'ADMIN'
      ? await getSourceForAdmin(sourceId)
      : await getSourceForInstructor(req.user.id, sourceId)

    if (!item) {
      return next(createHttpError(404, 'Source introuvable'))
    }

    return res.json({
      success: true,
      data: item
    })
  } catch (error) {
    return next(error)
  }
}
