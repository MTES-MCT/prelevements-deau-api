import createHttpError from 'http-errors'
import Joi from 'joi'

import {
  createDataExport,
  deleteDataExport,
  getDataExportDownloadUrl,
  getDataExportForUser,
  getDataExportOptions,
  listDataExports
} from '../services/data-exports.js'
import {addJobProcessDataExport} from '../queues/jobs.js'

const exportIdSchema = Joi.string().guid({version: 'uuidv4'}).required()

const createDataExportSchema = Joi.object({
  startDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
  endDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
  usageIds: Joi.array().items(Joi.string().guid({version: 'uuidv4'})).default([]),
  zoneIds: Joi.array().items(Joi.string().guid({version: 'uuidv4'})).default([]),
  waterBodyTypes: Joi.array()
    .items(Joi.string().valid('SUPERFICIELLE', 'SOUTERRAIN', 'TRANSITION'))
    .default([])
})

function getParisDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Europe/Paris',
    year: 'numeric'
  }).formatToParts(date)

  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))

  return `${values.year}-${values.month}-${values.day}`
}

function validateExportId(rawExportId) {
  const {error, value} = exportIdSchema.validate(rawExportId)

  if (error) {
    throw createHttpError(400, 'Identifiant d’export invalide.')
  }

  return value
}

function validateCreateDataExportPayload(body) {
  const {error, value} = createDataExportSchema.validate(body, {
    abortEarly: false,
    stripUnknown: true
  })

  if (error) {
    throw createHttpError(400, error.details.map(detail => detail.message).join(' '))
  }

  if (value.startDate > value.endDate) {
    throw createHttpError(400, 'La date de début doit être antérieure ou égale à la date de fin.')
  }

  const today = getParisDateString()
  if (value.startDate > today || value.endDate > today) {
    throw createHttpError(400, 'La période exportée ne peut pas inclure de date future.')
  }

  return value
}

function asHttpError(error) {
  if (error.status) {
    return createHttpError(error.status, error.message)
  }

  return error
}

export async function getDataExportOptionsHandler(req, res, next) {
  try {
    const options = await getDataExportOptions(req.user)
    res.send(options)
  } catch (error) {
    next(asHttpError(error))
  }
}

export async function listDataExportsHandler(req, res, next) {
  try {
    const items = await listDataExports(req.user)
    res.send({items})
  } catch (error) {
    next(asHttpError(error))
  }
}

export async function createDataExportHandler(req, res, next) {
  try {
    const filters = validateCreateDataExportPayload(req.body)
    const dataExport = await createDataExport({
      user: req.user,
      filters
    })

    await addJobProcessDataExport(dataExport.id)

    res.status(202).send(dataExport)
  } catch (error) {
    next(asHttpError(error))
  }
}

export async function getDataExportHandler(req, res, next) {
  try {
    const exportId = validateExportId(req.params.exportId)
    const dataExport = await getDataExportForUser(req.user, exportId)

    if (!dataExport) {
      throw createHttpError(404, 'Export introuvable.')
    }

    res.send(dataExport)
  } catch (error) {
    next(asHttpError(error))
  }
}

export async function getDataExportDownloadHandler(req, res, next) {
  try {
    const exportId = validateExportId(req.params.exportId)
    const dataExport = await getDataExportDownloadUrl(req.user, exportId)

    if (!dataExport) {
      throw createHttpError(404, 'Export introuvable.')
    }

    res.send(dataExport)
  } catch (error) {
    next(asHttpError(error))
  }
}

export async function deleteDataExportHandler(req, res, next) {
  try {
    const exportId = validateExportId(req.params.exportId)
    const dataExport = await deleteDataExport(req.user, exportId)

    if (!dataExport) {
      throw createHttpError(404, 'Export introuvable.')
    }

    res.status(204).send()
  } catch (error) {
    next(asHttpError(error))
  }
}
