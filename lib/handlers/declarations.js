import createHttpError from 'http-errors'
import Joi from 'joi'
import crypto, {randomUUID} from 'node:crypto'
import path from 'node:path'
import {Buffer} from 'node:buffer'

import createStorageClient from '../util/s3.js'
import {prisma} from '../../db/prisma.js'
import {addJobProcessDeclaration} from '../queues/jobs.js'

export const DECLARATIONS_BUCKET = 'declarations'
const ALLOWED_TYPES = ['aep-zre', 'camion-citerne', 'template-file', 'extract-aquasys', 'gidaf']

const DOSSIER_ALPHABET = 'ACDEFHJMNPRTUVWY23479'

export function generateDossierCode(length = 6) {
  const bytes = crypto.randomBytes(length)
  let code = ''

  for (let i = 0; i < length; i++) {
    code += DOSSIER_ALPHABET[bytes[i] % DOSSIER_ALPHABET.length]
  }

  return code
}

function safeFilename(filename) {
  const base = path.basename(filename || 'file')
  return base
    .normalize('NFC')
    .replaceAll(/[^\p{L}\p{N}._-]+/gu, '_')
    .slice(0, 180)
}

function uuid() {
  return crypto.randomUUID()
}

function normalizeRepeatedField(value) {
  if (Array.isArray(value)) {
    return value
  }

  if (typeof value === 'string') {
    return [value]
  }

  return null
}

const createDeclarationSchema = Joi.object({
  type: Joi.string().trim().required().valid(...ALLOWED_TYPES),
  comment: Joi.string().trim().max(20_000).allow('').optional(),
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
    for (const fileType of fileTypes) {
      const key = fileType.toLocaleLowerCase('fr-FR')
      if (seen.has(key)) {
        throw createHttpError(
          400,
          `Type dupliqué dans la déclaration: "${fileType}". Un type doit être unique par déclaration.`
        )
      }

      seen.add(key)
    }

    const type = String(req.body.type).trim()

    const commentRaw = typeof req.body.comment === 'string' ? req.body.comment.trim() : undefined
    const comment = commentRaw ? commentRaw : null

    const aotRaw = typeof req.body.aotDecreeNumber === 'string' ? req.body.aotDecreeNumber.trim() : undefined
    const aotDecreeNumber = aotRaw ? aotRaw : null

    const declarantUserId = req.user.id // UUID string
    const storage = createStorageClient(DECLARATIONS_BUCKET)

    const declaration = await prisma.declaration.create({
      data: {
        id: randomUUID(),
        code: generateDossierCode(6),
        type,
        declarantUserId,
        comment,
        aotDecreeNumber,
        dataSourceType: 'SPREADSHEET',
        waterWithdrawalType: 'unknown',
        status: 'SUBMITTED'
      }
    })

    const uploadedKeys = []

    try {
      const createdFiles = []

      for (const [i, file] of files.entries()) {
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

      await addJobProcessDeclaration(declaration.id)

      return res.status(201).json({
        success: true,
        data: {
          ...declaration,
          files: filesWithUrls
        }
      })
    } catch (error_) {
      await prisma.declaration.delete({where: {id: declaration.id}}).catch(() => {})
      await Promise.all(uploadedKeys.map(k => storage.deleteObject(k, true))).catch(() => {})
      throw error_
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
      include: {
        files: true,
        source: true,
        declarant: {
          include: {
            user: true
          }
        }
      }
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
      include: {
        files: true,
        source: {
          include: {
            chunks: {
              include: {
                pointPrelevement: true
              }
            },
          }
        },
        declarant: {
          include: {
            user: true
          }
        }
      }
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
