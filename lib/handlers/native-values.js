import createHttpError from 'http-errors'
import Joi from 'joi'
import {prisma} from '../../db/prisma.js'
import {getSourceForAdmin, getSourceForInstructor} from '../services/instructor-sources.js'
import {getPermissionZoneIdsForUser} from '../services/zone-permissions.js'
import {canReadDeclarationWhere, getReadableDeclarantUserIdsForDeclarant} from './declarations.js'

export async function sourceForReader(sourceId, user) {
  if (user.role === 'ADMIN') return getSourceForAdmin(sourceId, {accessOnly: true})
  if (user.role === 'INSTRUCTOR') {
    const readZoneIds = await getPermissionZoneIdsForUser(user, 'declaration.detail.read')
    return getSourceForInstructor(sourceId, {readZoneIds}, {accessOnly: true})
  }
  if (user.role !== 'DECLARANT') throw createHttpError(403, 'Accès non autorisé.')
  const readableIds = await getReadableDeclarantUserIdsForDeclarant(user)
  return prisma.source.findFirst({where: {id: sourceId, declaration: canReadDeclarationWhere(user.id, readableIds)},
    select: {id: true, chunks: {select: {id: true}}}})
}

export async function nativeValuesHandler(req, res, next) {
  try {
    const {error} = Joi.object({sourceId: Joi.string().uuid().required(), chunkId: Joi.string().uuid().required()}).validate(req.params)
    if (error) throw createHttpError(400, 'Identifiant invalide.')
    if (req.query.cursor !== undefined && Joi.string().uuid().validate(req.query.cursor).error) throw createHttpError(400, 'Curseur invalide.')
    const source = await sourceForReader(req.params.sourceId, req.user)
    if (!source?.chunks.some(c => c.id === req.params.chunkId)) throw createHttpError(404, 'Série introuvable.')
    const limit = Math.min(200, Number(req.query.limit ?? 50))
    if (!Number.isInteger(limit) || limit < 1) throw createHttpError(400, 'Pagination invalide.')
    const where = {chunkId: req.params.chunkId}
    if (req.query.cursor && !await prisma.chunkValue.findFirst({where: {...where, id: String(req.query.cursor)}})) throw createHttpError(400, 'Curseur invalide.')
    const [data, total] = await Promise.all([
      prisma.chunkValue.findMany({where, orderBy: [{periodStart: 'asc'}, {id: 'asc'}], take: limit + 1,
        ...(req.query.cursor ? {cursor: {id: String(req.query.cursor)}, skip: 1} : {})}), prisma.chunkValue.count({where})
    ])
    const more = data.length > limit
    if (more) data.pop()
    res.json({success: true, data: {data, total, nextCursor: more ? data.at(-1).id : null}})
  } catch (error) { next(error) }
}
