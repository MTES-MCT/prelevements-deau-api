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

const now = new Date()

function permissionCodes(assignment) {
  return assignment.permissions.map(item => item.permission)
}

function isManager(codes) {
  const selected = new Set(codes)
  return ZONE_AGENT_MANAGEMENT_PERMISSIONS.every(code => selected.has(code))
}

const [assignments, zones, declarantsCount, declarantZones, auditsCount] = await Promise.all([
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
  prisma.declarant.count({
    where: {user: {deletedAt: null}}
  }),
  prisma.declarantZone.findMany({
    where: {declarant: {user: {deletedAt: null}}},
    select: {declarantUserId: true, zoneId: true, source: true}
  }),
  prisma.instructorZonePermissionAudit.count()
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
const zonesWithoutActiveManager = zones
  .filter(zone => activeAssignmentZoneIds.has(zone.id) && !activeManagerZoneIds.has(zone.id))
  .map(zone => ({code: zone.code, name: zone.name}))
const linkedDeclarantIds = new Set(declarantZones.map(link => link.declarantUserId))
const orphanDeclarantsCount = declarantsCount - linkedDeclarantIds.size
const linksBySource = Object.fromEntries(
  [...new Set(declarantZones.map(link => link.source))]
    .sort()
    .map(source => [source, declarantZones.filter(link => link.source === source).length])
)

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
    activeManagerZones: activeManagerZoneIds.size,
    zonesWithoutActiveManager
  },
  declarants: {
    total: declarantsCount,
    linked: linkedDeclarantIds.size,
    orphan: orphanDeclarantsCount,
    links: declarantZones.length,
    linksBySource
  },
  audits: auditsCount,
  details: {
    emptyAssignments,
    invalidPermissions,
    missingDependencies,
    compatibilityDrifts
  }
}, null, 2))

const hasCriticalAnomaly = invalidPermissions.length > 0
  || missingDependencies.length > 0
  || emptyAssignments.length > 0
  || compatibilityDrifts.length > 0
  || zonesWithoutActiveManager.length > 0

if (hasCriticalAnomaly) {
  process.exitCode = 1
}

await prisma.$disconnect()
