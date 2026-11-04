import {prisma} from '../../db/prisma.js'
import {exploitationAtDateWhere} from './exploitation-periods.js'
import {collectorDay} from './collector-calendar.js'

async function hasManagement(user, client) {
  if (user?.role !== 'DECLARANT' || !user.id) return false
  return Boolean(await client.declarant.findFirst({
    where: {userId: user.id, declarantRole: 'COLLECTEUR', pointManagementEnabled: true,
      user: {role: 'DECLARANT', deletedAt: null}},
    select: {userId: true}
  }))
}

function managedExploitationWhere(user, now) {
  return {...exploitationAtDateWhere(collectorDay(now)),
    pointPrelevement: {deletedAt: null},
    declarant: {declarantRole: 'PRELEVEUR', user: {role: 'DECLARANT', deletedAt: null}},
    collecteurs: {some: {collecteurUserId: user.id}}}
}

// These capabilities expose the dedicated collector forms, never generic
// administration permissions. Queries stay bounded independently of list size.
export async function getCollectorEditableExploitationIds(user, exploitationIds, {client = prisma, now = new Date()} = {}) {
  if (!exploitationIds.length || !await hasManagement(user, client)) return new Set()
  const rows = await client.declarantPointPrelevement.findMany({
    where: {...managedExploitationWhere(user, now), id: {in: exploitationIds}},
    select: {id: true}
  })
  return new Set(rows.map(row => row.id))
}

export async function getCollectorEditablePreleveurIds(user, preleveurIds, {client = prisma, now = new Date()} = {}) {
  if (!preleveurIds.length || !await hasManagement(user, client)) return new Set()
  const rows = await client.declarantPointPrelevement.findMany({
    where: {...managedExploitationWhere(user, now), declarantUserId: {in: preleveurIds}},
    select: {declarantUserId: true}, distinct: ['declarantUserId']
  })
  return new Set(rows.map(row => row.declarantUserId))
}
