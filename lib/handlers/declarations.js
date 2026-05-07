import createHttpError from 'http-errors'
import Joi from 'joi'
import crypto, {randomUUID} from 'node:crypto'
import path from 'node:path'
import {Buffer} from 'node:buffer'

import createStorageClient from '../util/s3.js'
import {prisma} from '../../db/prisma.js'
import {activeWindowWhere} from '../models/point-prelevement.js'
import {updateLastDeclarationAt} from '../models/declarant.js'
import {
  decorateDeclarationsWithDeclarationTypes,
  findAllowedDeclarationTypeForDeclarant,
  listAllowedDeclarationTypesForDeclarant,
  normalizeDeclarationTypeCode
} from '../models/declaration-type.js'
import {notifyDeclarationUploaded} from '../services/orchestration-client.js'

export const DECLARATIONS_BUCKET = 'declarations'

const DOSSIER_ALPHABET = 'ACDEFHJMNPRTUVWY23479'

export function generateDossierCode(length = 6) {
  const bytes = crypto.randomBytes(length)
  let code = ''

  for (let i = 0; i < length; i++) {
    code += DOSSIER_ALPHABET[bytes[i] % DOSSIER_ALPHABET.length]
  }

  return code
}

export function safeFilename(filename) {
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
  type: Joi.string().trim().min(1).max(120).required(),
  comment: Joi.string().trim().max(20_000).allow('').optional(),
  aotDecreeNumber: Joi.string().trim().max(255).allow('').optional(),

  fileTypes: Joi.alternatives()
    .try(
      Joi.string().trim().min(1).max(120),
      Joi.array().items(Joi.string().trim().min(1).max(120)).min(1).max(50)
    )
    .optional()
}).unknown(true)

const declarationIdSchema = Joi.object({
  declarationId: Joi.string().uuid({version: 'uuidv4'}).required()
})

/**
 * POST /declarations
 * multipart/form-data:
 * - files: fichiers du type sélectionné
 * - fileTypes: champ répété, UN type métier par fichier (facultatif ; défaut = type de déclaration)
 * - comment?: string
 * - aotDecreeNumber?: string
 *
 * Champs forcés côté API:
 * - dataSourceType: SPREADSHEET
 * - waterWithdrawalType: "unknown"
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

    const declarantUserId = req.user.id
    const type = normalizeDeclarationTypeCode(req.body.type)

    const allowedDeclarationType = await findAllowedDeclarationTypeForDeclarant(
      declarantUserId,
      type
    )

    if (!allowedDeclarationType) {
      throw createHttpError(
        403,
        `Le déclarant n’est pas autorisé à déposer une déclaration de type "${type}".`
      )
    }

    const fileTypesRaw = normalizeRepeatedField(req.body.fileTypes)

    if (fileTypesRaw && fileTypesRaw.length !== files.length) {
      throw createHttpError(
        400,
        `Le nombre de fileTypes (${fileTypesRaw.length}) doit correspondre au nombre de fichiers (${files.length}).`
      )
    }

    const fileTypes = fileTypesRaw
      ? fileTypesRaw.map((t, i) => {
        const value = normalizeDeclarationTypeCode(t)
        if (!value) {
          throw createHttpError(400, `Type manquant pour le fichier #${i + 1}.`)
        }

        return value
      })
      : files.map(() => type)

    const unexpectedFileType = fileTypes.find(fileType => fileType !== type)
    if (unexpectedFileType) {
      throw createHttpError(
        400,
        `Tous les fichiers d’une déclaration doivent avoir le type sélectionné "${type}". Type reçu: "${unexpectedFileType}".`
      )
    }

    const commentRaw = typeof req.body.comment === 'string' ? req.body.comment.trim() : undefined
    const comment = commentRaw || null

    const aotRaw = typeof req.body.aotDecreeNumber === 'string' ? req.body.aotDecreeNumber.trim() : undefined
    const aotDecreeNumber = aotRaw || null

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
        waterWithdrawalType: 'unknown'
      }
    })

    await updateLastDeclarationAt(declarantUserId)

    const uploadedKeys = []

    try {
      const createdFiles = []

      // Le traitement est volontairement séquentiel pour garder un flux d'upload et de création en base maîtrisé.
      // eslint-disable-next-line no-await-in-loop
      for (const [i, file] of files.entries()) {
        const filename = safeFilename(file.originalname)
        const type = fileTypes[i]

        const objectKey = `declarations/${declaration.id}/${uuid()}-${filename}`

        // eslint-disable-next-line no-await-in-loop
        await storage.uploadObject(objectKey, file.buffer, {
          filename,
          type: file.mimetype
        })

        uploadedKeys.push(objectKey)

        // eslint-disable-next-line no-await-in-loop
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

      await notifyDeclarationUploaded({declarationId: declaration.id})

      return res.status(201).json({
        success: true,
        data: {
          ...declaration,
          declarationType: allowedDeclarationType,
          files: filesWithUrls
        }
      })
    } catch (error_) {
      try {
        await prisma.declaration.delete({where: {id: declaration.id}})
      } catch {}

      try {
        await Promise.all(uploadedKeys.map(async k => storage.deleteObject(k, true)))
      } catch {}

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

    const [items, allowedDeclarationTypes] = await Promise.all([
      prisma.declaration.findMany({
        where: {declarantUserId},
        orderBy: {createdAt: 'desc'},
        include: {
          files: true,
          source: {
            include: {
              chunks: true
            }
          },
          declarant: {
            include: {
              user: true
            }
          }
        }
      }),
      listAllowedDeclarationTypesForDeclarant(declarantUserId)
    ])

    return res.json({
      success: true,
      data: await decorateDeclarationsWithDeclarationTypes(items),
      meta: {
        canCreateDeclaration: allowedDeclarationTypes.length > 0,
        allowedDeclarationTypes
      }
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /declarations/allowed-types
 * Liste des types de déclaration déposables par le déclarant authentifié.
 */
export async function listMyAllowedDeclarationTypesHandler(req, res, next) {
  try {
    const allowedDeclarationTypes = await listAllowedDeclarationTypesForDeclarant(req.user.id)

    return res.json({
      success: true,
      data: allowedDeclarationTypes,
      meta: {
        canCreateDeclaration: allowedDeclarationTypes.length > 0
      }
    })
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
                pointPrelevement: true,
                chunkValues: true,
                instructedByInstructor: {
                  include: {
                    user: {
                      select: {
                        lastName: true,
                        firstName: true
                      }
                    }
                  }
                }
              }
            }
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

    const [declarationWithType] = await decorateDeclarationsWithDeclarationTypes([declaration])

    declaration.files = await Promise.all(
      declaration.files.map(async file => ({
        ...file,
        url: await storage.getPresignedUrl(file.storageKey)
      }))
    )

    return res.json({
      success: true,
      data: {
        ...declaration,
        declarationType: declarationWithType.declarationType
      }
    })
  } catch (error) {
    next(error)
  }
}

export async function getAvailablePointsPrelevementsForDeclarationHandler(req, res, next) {
  try {
    const declarationId = String(req.params.declarationId || '').trim()
    const {error} = declarationIdSchema.validate({declarationId})

    if (error) {
      throw createHttpError(400, error.message)
    }

    const instructorUserId = req.user.id

    const declaration = await prisma.declaration.findUnique({
      where: {id: declarationId},
      select: {
        id: true,
        declarantUserId: true
      }
    })

    if (!declaration) {
      throw createHttpError(404, 'Déclaration introuvable')
    }

    const points = await getAvailablePointsPrelevementsForDeclaration({
      declarationId,
      declarantUserId: declaration.declarantUserId,
      instructorUserId
    })

    return res.json({
      success: true,
      data: points
    })
  } catch (error) {
    next(error)
  }
}

export async function getAvailablePointsPrelevementsForDeclaration({
  declarantUserId,
  instructorUserId
}) {
  const now = new Date()

  const instructorZoneActiveWhere = {
    instructorUserId,
    ...activeWindowWhere(now, {startNullable: false, endNullable: true})
  }

  const declarantLinkActiveWhere = {
    declarantUserId,
    ...activeWindowWhere()
  }

  return prisma.pointPrelevement.findMany({
    where: {
      deletedAt: null,
      declarants: {
        some: declarantLinkActiveWhere
      },
      zones: {
        some: {
          zone: {
            instructorZones: {
              some: instructorZoneActiveWhere
            }
          }
        }
      }
    },
    select: {
      id: true,
      name: true
    },
    orderBy: {
      name: 'asc'
    }
  })
}
