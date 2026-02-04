import createHttpError from 'http-errors'
import {randomUUID} from "node:crypto";

export async function getPointPrelevement(pointId) {
  return prisma.pointPrelevement.findUnique({
    where: {id: pointId}
  })
}

export async function getPointsPrelevement(includeDeleted = false) {
  return prisma.pointPrelevement.findMany({
    where: {
      ...computeDeletionCondition(includeDeleted)
    }
  })
}

export async function getPointsPrelevementByIds(pointIds, includeDeleted = false) {
  return prisma.pointPrelevement.findMany({
    where: {
      id: {in: pointIds},
      ...computeDeletionCondition(includeDeleted)
    }
  })
}

export async function getPointInfoById(pointId) {
  return prisma.pointPrelevement.findUnique({
    where: {id: pointId},
    select: {
      id: true,
      name: true,
      sourceId: true
    }
  })
}

/* Insertion (utilisé par le service) */

export async function insertPointPrelevement(point) {
  const data = {
    id: randomUUID(),
    ...point
  }

  return prisma.pointPrelevement.create({data})
}
/* Mise à jour par ID (utilisé par le service) */

export async function updatePointPrelevementById(pointId, changes) {
  if (!changes || typeof changes !== 'object') {
    throw createHttpError(400, 'Les modifications doivent être un objet.')
  }

  const {count} = await prisma.pointPrelevement.updateMany({
    where: {id: pointId, deletedAt: null},
    data: {
      ...changes
    }
  })

  if (count === 0) {
    throw createHttpError(404, 'Ce point de prélèvement est introuvable.')
  }

  return prisma.pointPrelevement.findUnique({where: {id: pointId}})
}


/* Suppression par ID (utilisé par le service) */

export async function deletePointPrelevementById(pointId) {
  const now = new Date()

  const {count} = await prisma.pointPrelevement.updateMany({
    where: {id: pointId, deletedAt: null},
    data: {
      deletedAt: now
    }
  })

  if (count === 0) {
    return null
  }

  return prisma.pointPrelevement.findUnique({where: {id: pointId}})
}


/* Helpers */

function computeDeletionCondition(withDeleted) {
  return withDeleted ? {} : {deletedAt: null}
}
