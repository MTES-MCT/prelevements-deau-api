import '../lib/config/env.js'

import process from 'node:process'

import {prisma} from '../db/prisma.js'
import {
  ZONE_AGENT_MANAGEMENT_PERMISSIONS,
  ZONE_PERMISSION_CODE_SET,
  ZONE_PERMISSION_CODES,
  getMissingPermissionDependencies
} from '../lib/constants/zone-permissions.js'
import {activeWindowWhere} from '../lib/models/point-prelevement.js'
import {getEffectiveDeclarantZoneLinks} from '../lib/services/zone-permissions.js'

const now = new Date()
const DERIVED_DECLARANT_ZONE_SOURCES = new Set([
  'EXPLOITATION',
  'DECLARATION',
  'RECONCILIATION'
])

function permissionCodes(assignment) {
  return assignment.permissions.map(item => item.permission)
}

function isManager(codes) {
  const selected = new Set(codes)
  return ZONE_AGENT_MANAGEMENT_PERMISSIONS.every(code => selected.has(code))
}

const [
  assignments,
  zones,
  declarants,
  declarantZones,
  effectiveDeclarantZoneLinks,
  auditsCount,
  globalAdminsCount
] = await Promise.all([
  prisma.instructorZone.findMany({
    include: {
      permissions: {select: {permission: true}},
      zone: {select: {id: true, code: true, name: true}},
      instructor: {
        select: {
          user: {select: {email: true, firstName: true, lastName: true}}
        }
      }
    }
  }),
  prisma.zone.findMany({select: {id: true, code: true, name: true}}),
  prisma.declarant.findMany({
    where: {user: {deletedAt: null}},
    select: {userId: true}
  }),
  prisma.declarantZone.findMany({
    where: {declarant: {user: {deletedAt: null}}},
    select: {id: true, declarantUserId: true, zoneId: true, source: true}
  }),
  getEffectiveDeclarantZoneLinks(),
  prisma.auditMutation.count({where: {entityType: 'ZONE_AGENT_ASSIGNMENT'}}),
  prisma.user.count({
    where: {
      role: 'ADMIN',
      deletedAt: null
    }
  })
])

const activeAssignments = await prisma.instructorZone.findMany({
  where: {
    ...activeWindowWhere(now, {startNullable: false, endNullable: true}),
    instructor: {user: {deletedAt: null}}
  },
  include: {permissions: {select: {permission: true}}}
})
const invalidPermissions = []
const missingDependencies = []
const emptyAssignments = []
const compatibilityDrifts = []

for (const assignment of assignments) {
  const codes = permissionCodes(assignment)
  const invalid = codes.filter(code => !ZONE_PERMISSION_CODE_SET.has(code))

  if (invalid.length > 0) {
    invalidPermissions.push({assignmentId: assignment.id, invalid})
  }

  const missing = getMissingPermissionDependencies(codes)
  if (missing.length > 0) {
    missingDependencies.push({assignmentId: assignment.id, missing})
  }

  if (codes.length === 0) {
    emptyAssignments.push({
      assignmentId: assignment.id,
      zone: assignment.zone.code,
      instructor: assignment.instructor.user.email
    })
  }

  const shouldBeLegacyAdmin = codes.length === ZONE_PERMISSION_CODES.length
  if (assignment.isAdmin !== shouldBeLegacyAdmin) {
    compatibilityDrifts.push({
      assignmentId: assignment.id,
      isAdmin: assignment.isAdmin,
      permissionsCount: codes.length
    })
  }
}

const activeManagerZoneIds = new Set(
  activeAssignments
    .filter(assignment => isManager(permissionCodes(assignment)))
    .map(assignment => assignment.zoneId)
)
const activeAssignmentZoneIds = new Set(activeAssignments.map(assignment => assignment.zoneId))
const zonesWithoutLocalManager = zones
  .filter(zone => activeAssignmentZoneIds.has(zone.id) && !activeManagerZoneIds.has(zone.id))
  .map(zone => ({code: zone.code, name: zone.name}))
const zonesWithoutActiveManager = globalAdminsCount > 0 ? [] : zonesWithoutLocalManager
const linksBySource = Object.fromEntries(
  [...new Set(declarantZones.map(link => link.source))]
    .sort()
    .map(source => [source, declarantZones.filter(link => link.source === source).length])
)
const effectiveLinkKeys = new Set(
  effectiveDeclarantZoneLinks.map(link => `${link.declarantUserId}:${link.zoneId}`)
)
const activeDeclarantIds = new Set(declarants.map(declarant => declarant.userId))
const linkedDeclarantIds = new Set(
  effectiveDeclarantZoneLinks
    .filter(link => activeDeclarantIds.has(link.declarantUserId))
    .map(link => link.declarantUserId)
)
const orphanDeclarantsCount = declarants.length - linkedDeclarantIds.size

const staleDerivedLinks = declarantZones
  .filter(link => DERIVED_DECLARANT_ZONE_SOURCES.has(link.source))
  .filter(link => !effectiveLinkKeys.has(`${link.declarantUserId}:${link.zoneId}`))
  .map(link => ({
    id: link.id,
    declarantUserId: link.declarantUserId,
    zoneId: link.zoneId,
    source: link.source
  }))

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  catalog: {
    permissions: ZONE_PERMISSION_CODES.length,
    managementPermissions: ZONE_AGENT_MANAGEMENT_PERMISSIONS
  },
  assignments: {
    total: assignments.length,
    active: activeAssignments.length,
    empty: emptyAssignments.length,
    invalidPermissions: invalidPermissions.length,
    missingDependencies: missingDependencies.length,
    compatibilityDrifts: compatibilityDrifts.length
  },
  managers: {
    globalAdmins: globalAdminsCount,
    activeLocalManagerZones: activeManagerZoneIds.size,
    zonesWithoutLocalManager,
    zonesWithoutActiveManager
  },
  declarants: {
    total: declarants.length,
    linked: linkedDeclarantIds.size,
    orphan: orphanDeclarantsCount,
    links: declarantZones.length,
    linksBySource,
    staleDerivedLinks: staleDerivedLinks.length
  },
  audits: auditsCount,
  details: {
    emptyAssignments,
    invalidPermissions,
    missingDependencies,
    compatibilityDrifts,
    staleDerivedLinks
  }
}, null, 2))

const hasCriticalAnomaly = invalidPermissions.length > 0
  || missingDependencies.length > 0
  || emptyAssignments.length > 0
  || compatibilityDrifts.length > 0
  || staleDerivedLinks.length > 0
  || zonesWithoutActiveManager.length > 0

if (hasCriticalAnomaly) {
  process.exitCode = 1
}

await prisma.$disconnect()
