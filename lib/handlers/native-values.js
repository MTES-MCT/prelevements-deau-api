import createHttpError from 'http-errors'
import Joi from 'joi'
import {Prisma} from '@prisma/client'
import {prisma} from '../../db/prisma.js'
import {getSourceForAdmin, getSourceForInstructor} from '../services/instructor-sources.js'
import {getPermissionZoneIdsForUser} from '../services/zone-permissions.js'
import {loadChunkValueCounts} from '../services/chunk-value-summaries.js'
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
    const chunkId = req.params.chunkId
    const cursor = req.query.cursor ? await prisma.chunkValue.findFirst({
      where: {chunkId, id: String(req.query.cursor)}, select: {id: true, periodStart: true}
    }) : null
    if (req.query.cursor && !cursor) throw createHttpError(400, 'Curseur invalide.')
    const [data, counts] = await Promise.all([
      prisma.$queryRaw(Prisma.sql`
        SELECT cv.* FROM "ChunkValue" cv
        WHERE cv."chunkId" = ${chunkId}::uuid
        ${cursor ? Prisma.sql`AND (cv."periodStart", cv.id) > (${cursor.periodStart}::timestamp, ${cursor.id}::uuid)` : Prisma.empty}
        ORDER BY cv."periodStart", cv.id
        LIMIT ${limit + 1}
      `),
      loadChunkValueCounts([chunkId], {client: prisma})
    ])
    const more = data.length > limit
    if (more) data.pop()
    res.json({success: true, data: {data, total: counts.get(chunkId) ?? 0, nextCursor: more ? data.at(-1).id : null}})
  } catch (error) { next(error) }
}
