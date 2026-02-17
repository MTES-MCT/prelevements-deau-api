import {prisma} from '../../db/prisma.js'

export async function listZones(req, res) {
  const userId = req.user.id

  const rights = await prisma.instructorZone.findMany({
    where: {
      instructorUserId: userId
    },
    include: {
      zone: {
        select: {
          id: true,
          type: true,
          code: true,
          name: true
        }
      }
    }
  })

  const zones = rights.map(r => ({
    id: r.zone.id,
    type: r.zone.type,
    code: r.zone.code,
    name: r.zone.name,
    isAdmin: r.isAdmin,
    startDate: r.startDate,
    endDate: r.endDate
  }))

  res.json(zones)
}

