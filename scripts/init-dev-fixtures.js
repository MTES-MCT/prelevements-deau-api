/* eslint-disable unicorn/no-process-exit */
import 'dotenv/config'
import {prisma} from '../db/prisma.js'
import {randomUUID} from 'node:crypto'

const usersToCreate = [
  {
    email: 'declarant@declarant.fr',
    firstName: 'Jean',
    lastName: 'DÉCLARANT',
    role: 'DECLARANT'
  },
  {
    email: 'instructor@instructor.fr',
    firstName: 'Alice',
    lastName: 'INSTRUCTRICE',
    role: 'INSTRUCTOR'
  }
]

async function main() {
  const declarantUser = await prisma.user.upsert({
    where: {email: usersToCreate[0].email},
    create: {
      id: randomUUID(),
      ...usersToCreate[0],
      declarant: {create: {}}
    },
    update: {
      ...usersToCreate[0],
      declarant: {
        upsert: {create: {}, update: {}}
      }
    },
    include: {declarant: true}
  })

  const instructorUser = await prisma.user.upsert({
    where: {email: usersToCreate[1].email},
    create: {
      id: randomUUID(),
      ...usersToCreate[1],
      instructor: {create: {}}
    },
    update: {
      ...usersToCreate[1],
      instructor: {
        upsert: {create: {}, update: {}}
      }
    },
    include: {instructor: true}
  })

  const zone1 = await prisma.zone.findFirstOrThrow({
    where: {
      code: 'sage-SAGE06025',
      type: 'SAGE'
    }
  })

  const point1 = await prisma.pointPrelevement.findUniqueOrThrow({
    where: {name: '38-1314'}
  })

  const point2 = await prisma.pointPrelevement.findUniqueOrThrow({
    where: {name: '26-2485'}
  })

  await prisma.instructorZone.upsert({
    where: {
      instructorUserId_zoneId: {
        instructorUserId: instructorUser.instructor.userId,
        zoneId: zone1.id
      }
    },
    create: {
      instructorUserId: instructorUser.instructor.userId,
      zoneId: zone1.id,
      startDate: new Date('2024-01-01'),
      isAdmin: true
    },
    update: {
      startDate: new Date('2024-01-01'),
      isAdmin: true
    }
  })

  await prisma.declarantPointPrelevement.upsert({
    where: {
      declarantUserId_pointPrelevementId: {
        declarantUserId: declarantUser.declarant.userId,
        pointPrelevementId: point1.id
      }
    },
    create: {
      declarantUserId: declarantUser.declarant.userId,
      pointPrelevementId: point1.id,
      type: 'PRELEVEUR_DECLARANT'
    },
    update: {
      type: 'PRELEVEUR_DECLARANT'
    }
  })

  await prisma.declarantPointPrelevement.upsert({
    where: {
      declarantUserId_pointPrelevementId: {
        declarantUserId: declarantUser.declarant.userId,
        pointPrelevementId: point2.id
      }
    },
    create: {
      declarantUserId: declarantUser.declarant.userId,
      pointPrelevementId: point2.id,
      type: 'PRELEVEUR_DECLARANT'
    },
    update: {
      type: 'PRELEVEUR_DECLARANT'
    }
  })
}

await main().finally(() => prisma.$disconnect())
