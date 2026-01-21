import createHttpError from 'http-errors'
import Joi from 'joi'
import crypto, {randomUUID} from 'node:crypto'
import path from 'node:path'
import moment from 'moment'

import createStorageClient from '../../lib/util/s3.js'
import {prisma} from '../../db/prisma.js'

const DECLARATIONS_BUCKET = 'declarations'

function safeFilename(filename) {
  const base = path.basename(filename || 'file')
  return base
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .slice(0, 180)
}

function uuid() {
  return crypto.randomUUID()
}

function normalizeRepeatedField(value) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') return [value]
  return null
}

function parseMonthDateOrThrow(value, fieldName) {
  const s = String(value ?? '').trim()

  // On force strict "YYYY-MM-DD" (ex: 2026-01-01)
  const m = moment.utc(s, 'YYYY-MM-DD', true)
  if (!m.isValid()) {
    throw createHttpError(400, `Champ "${fieldName}" invalide (format attendu: YYYY-MM-DD).`)
  }

  // Règle métier : toujours le 1er du mois
  if (m.date() !== 1) {
    throw createHttpError(400, `Champ "${fieldName}" invalide: la date doit être le 1er du mois.`)
  }

  return m.toDate()
}

const createDeclarationSchema = Joi.object({
  comment: Joi.string().trim().max(20_000).allow('').optional(),
  startMonth: Joi.string().trim().required(),
  endMonth: Joi.string().trim().required(),
  aotDecreeNumber: Joi.string().trim().max(255).allow('').optional(),

  fileTypes: Joi.alternatives()
    .try(
      Joi.string().trim().min(1).max(120),
      Joi.array().items(Joi.string().trim().min(1).max(120)).min(1).max(50)
    )
    .required()
}).unknown(true)

const declarationIdSchema = Joi.object({
  declarationId: Joi.string().uuid({version: 'uuidv4'}).required()
})


/**
 * POST /declarations
 * multipart/form-data:
 * - files: fichiers
 * - fileTypes: champ répété, UN type métier par fichier (obligatoire)
 * - comment?: string
 * - startMonth: YYYY-MM-DD (toujours le 1er du mois)
 * - endMonth: YYYY-MM-DD (toujours le 1er du mois, >= startMonth)
 * - aotDecreeNumber?: string
 *
 * Champs forcés côté API:
 * - status: SUBMITTED
 * - dataSourceType: SPREADSHEET
 * - waterWithdrawalType: "Inconnu"
 */
export async function createDeclarationHandler(req, res, next) {
  try {
    const {error} = createDeclarationSchema.validate(req.body)
    if (error) {
      throw createHttpError(400, error.message)
    }

    const files = req.files || []
    if (!Array.isArray(files) || files.length === 0) {
      throw createHttpError(400, 'Aucun fichier envoyé (champ "files")')
    }

    for (const f of files) {
      if (!f?.buffer || !Buffer.isBuffer(f.buffer)) {
        throw createHttpError(400, 'Fichier invalide (buffer manquant)')
      }
      if (!f.originalname) {
        throw createHttpError(400, 'Fichier invalide (originalname manquant)')
      }
    }

    const fileTypesRaw = normalizeRepeatedField(req.body.fileTypes)
    if (!fileTypesRaw) {
      throw createHttpError(400, 'Champ "fileTypes" obligatoire (1 occurrence par fichier)')
    }

    if (fileTypesRaw.length !== files.length) {
      throw createHttpError(
        400,
        `Le nombre de fileTypes (${fileTypesRaw.length}) doit correspondre au nombre de fichiers (${files.length}).`
      )
    }

    const fileTypes = fileTypesRaw.map((t, i) => {
      const value = String(t).trim()
      if (!value) {
        throw createHttpError(400, `Type manquant pour le fichier #${i + 1}.`)
      }
      return value
    })

    const seen = new Set()
    for (let i = 0; i < fileTypes.length; i++) {
      const key = fileTypes[i].toLocaleLowerCase('fr-FR')
      if (seen.has(key)) {
        throw createHttpError(
          400,
          `Type dupliqué dans la déclaration: "${fileTypes[i]}". Un type doit être unique par déclaration.`
        )
      }
      seen.add(key)
    }

    const startMonth = parseMonthDateOrThrow(req.body.startMonth, 'startMonth')
    const endMonth = parseMonthDateOrThrow(req.body.endMonth, 'endMonth')

    if (moment.utc(startMonth).isAfter(moment.utc(endMonth))) {
      throw createHttpError(400, 'Ordre de dates invalide: startMonth doit être <= endMonth.')
    }

    const commentRaw = typeof req.body.comment === 'string' ? req.body.comment.trim() : undefined
    const comment = commentRaw ? commentRaw : null

    const aotRaw = typeof req.body.aotDecreeNumber === 'string' ? req.body.aotDecreeNumber.trim() : undefined
    const aotDecreeNumber = aotRaw ? aotRaw : null

    const declarantUserId = req.user.id // UUID string
    const storage = createStorageClient(DECLARATIONS_BUCKET)

    const declaration = await prisma.declaration.create({
      data: {
        id: randomUUID(),
        declarantUserId,
        comment,
        startMonth,
        endMonth,
        aotDecreeNumber,
        dataSourceType: 'SPREADSHEET',
        waterWithdrawalType: 'Inconnu',
        status: 'SUBMITTED'
      }
    })

    const uploadedKeys = []

    try {
      const createdFiles = []

      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        const filename = safeFilename(file.originalname)
        const type = fileTypes[i]

        const objectKey = `declarations/${declaration.id}/${uuid()}-${filename}`

        await storage.uploadObject(objectKey, file.buffer, {
          filename,
          type: file.mimetype
        })

        uploadedKeys.push(objectKey)

        const row = await prisma.declarationFile.create({
          data: {
            id: randomUUID(),
            declarationId: declaration.id,
            type,
            filename,
            storageKey: objectKey
          }
        })

        createdFiles.push(row)
      }

      const filesWithUrls = await Promise.all(
        createdFiles.map(async f => ({
          ...f,
          url: await storage.getPresignedUrl(f.storageKey)
        }))
      )

      return res.status(201).json({
        success: true,
        data: {
          ...declaration,
          files: filesWithUrls
        }
      })
    } catch (err) {
      await prisma.declaration.delete({where: {id: declaration.id}}).catch(() => {})
      await Promise.all(uploadedKeys.map(k => storage.deleteObject(k, true))).catch(() => {})
      throw err
    }
  } catch (error) {
    next(error)
  }
}

/**
 * GET /declarations/me
 * Liste de mes déclarations + fichiers + URL présignées
 */
export async function listMyDeclarationsHandler(req, res, next) {
  try {
    const declarantUserId = req.user.id

    const items = await prisma.declaration.findMany({
      where: {declarantUserId},
      orderBy: {createdAt: 'desc'},
      include: {files: true}
    })

    return res.json({success: true, data: items})
  } catch (error) {
    next(error)
  }
}

/**
 * GET /declarations/:declarationId
 * Détail + fichiers + URL présignées
 */
export async function getDeclarationDetailHandler(req, res, next) {
  try {
    const declarationId = String(req.params.declarationId || '').trim()
    const {error} = declarationIdSchema.validate({declarationId})
    if (error) {
      throw createHttpError(400, error.message)
    }

    const declarantUserId = req.user.id
    const storage = createStorageClient(DECLARATIONS_BUCKET)

    const declaration = await prisma.declaration.findFirst({
      where: {id: declarationId, declarantUserId},
      include: {files: true}
    })

    if (!declaration) {
      throw createHttpError(404, 'Déclaration introuvable')
    }

    const filesWithUrls = await Promise.all(
      declaration.files.map(async f => ({
        ...f,
        url: await storage.getPresignedUrl(f.storageKey)
      }))
    )

    return res.json({
      success: true,
      data: {...declaration, files: filesWithUrls}
    })
  } catch (error) {
    next(error)
  }
}
