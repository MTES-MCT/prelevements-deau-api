import createHttpError from 'http-errors'
import {getSourceForInstructor, listSourcesForInstructor} from "../services/instructor-sources.js";

const ALLOWED_SOURCE_STATUSES = [
  'TO_INSTRUCT',
  'VALIDATED',
  'REJECTED',
  'PARTIALLY_VALIDATED',
  'INSTRUCTION_IN_PROGRESS'
]

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

export async function listMySourcesHandler(req, res, next) {
  try {
    const instructorUserId = req.user.id
    const statuses = parseStatuses(req.query.statuses)
    const items = await listSourcesForInstructor(instructorUserId, {
      statuses,
    })

    return res.json({
      success: true,
      data: items
    })
  } catch (error) {
    return next(error)
  }
}

export async function getMySourceHandler(req, res, next) {
  try {
    const instructorUserId = req.user.id
    const {sourceId} = req.params

    const item = await getSourceForInstructor(instructorUserId, sourceId)

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
