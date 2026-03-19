// Noinspection JSNonASCIINames

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import {parse} from 'csv-parse'
import {fileURLToPath} from 'node:url'

import {prisma} from '../../db/prisma.js'
import moment from 'moment'
import {closeQueues} from '../../lib/queues/config.js'
import {closeRedis} from '../../lib/queues/redis.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CSV_PATH = path.resolve(__dirname, '../../data/blv/instructeurs.csv')

function clean(value) {
  const v = String(value ?? '').trim()
  return v || null
}

function getTodayAsDateOnly() {
  return moment.utc().startOf('day').toDate()
}

async function importRow(row, startDate) {
  const email = clean(row.email)?.toLowerCase()
  const zoneCode = clean(row.zone)

  if (!email) {
    throw new Error(`email manquant : ${JSON.stringify(row)}`)
  }

  if (!zoneCode) {
    throw new Error(`zone manquante : ${JSON.stringify(row)}`)
  }

  const user = await prisma.user.findUnique({
    where: {email},
    select: {id: true}
  })

  if (!user?.id) {
    throw new Error(`Utilisateur introuvable pour email=${email}`)
  }

  const instructor = await prisma.instructor.findUnique({
    where: {userId: user.id},
    select: {userId: true}
  })

  if (!instructor?.userId) {
    throw new Error(`Instructor introuvable pour email=${email}`)
  }

  const zone = await prisma.zone.findFirst({
    where: {code: zoneCode},
    select: {id: true, code: true, type: true}
  })

  if (!zone?.id) {
    throw new Error(`Zone introuvable pour code=${zoneCode}`)
  }

  await prisma.instructorZone.upsert({
    where: {
      instructorUserId_zoneId: {
        instructorUserId: instructor.userId,
        zoneId: zone.id
      }
    },
    update: {
      isAdmin: false,
      endDate: null
    },
    create: {
      instructorUserId: instructor.userId,
      zoneId: zone.id,
      isAdmin: false,
      startDate,
      endDate: null
    }
  })
}

async function main() {
  console.log('[import-instructor-zones] start')

  const parser = fs
    .createReadStream(CSV_PATH)
    .pipe(
      parse({
        columns: true,
        skip_empty_lines: true,
        trim: true
      })
    )

  const startDate = getTodayAsDateOnly()

  let count = 0

  for await (const row of parser) {
    await prisma.$transaction(async () => {
      await importRow(row, startDate)
    })

    count++

    if (count % 100 === 0) {
      console.log(`[import-instructor-zones] ${count} liaisons instructeur-zone importées`)
    }
  }

  console.log(`[import-instructor-zones] terminé (${count} liaisons)`)
}

try {
  await main()
} catch (error) {
  console.error(error)
  throw error
} finally {
  await closeQueues()
  await closeRedis()
  await prisma.$disconnect()
}
