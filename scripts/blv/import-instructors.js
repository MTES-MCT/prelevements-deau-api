// Noinspection JSNonASCIINames

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import {parse} from 'csv-parse'
import {fileURLToPath} from 'node:url'

import {prisma} from '../../db/prisma.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CSV_PATH = path.resolve(__dirname, '../../data/blv/instructeurs.csv')

function clean(value) {
  const v = String(value ?? '').trim()
  return v || null
}

function buildInstructorSourceId(row) {
  const zone = clean(row.zone)
  const email = clean(row.email)

  if (!zone) {
    throw new Error(`zone manquante : ${JSON.stringify(row)}`)
  }

  if (!email) {
    throw new Error(`email manquant : ${JSON.stringify(row)}`)
  }

  return `blv-instructor-${zone}-${email.toLowerCase()}`
}

async function importRow(row) {
  const email = clean(row.email)?.toLowerCase()
  const firstName = clean(row.firstName)
  const lastName = clean(row.lastName)
  const phoneNumber = clean(row.phoneNumber)
  const jobTitle = clean(row.jobTitle)
  const sourceId = buildInstructorSourceId(row)

  if (!email) {
    throw new Error(`email manquant : ${JSON.stringify(row)}`)
  }

  const existingInstructor = await prisma.instructor.findUnique({
    where: {sourceId},
    include: {user: true}
  })

  let instructorUserId

  if (existingInstructor) {
    instructorUserId = existingInstructor.userId

    await prisma.user.update({
      where: {id: instructorUserId},
      data: {
        email,
        role: 'INSTRUCTOR',
        firstName,
        lastName
      }
    })

    await prisma.instructor.update({
      where: {userId: instructorUserId},
      data: {
        sourceId,
        phoneNumber,
        jobTitle
      }
    })
  } else {
    const user = await prisma.user.upsert({
      where: {email},
      update: {
        role: 'INSTRUCTOR',
        firstName,
        lastName
      },
      create: {
        email,
        role: 'INSTRUCTOR',
        firstName,
        lastName
      }
    })

    instructorUserId = user.id

    await prisma.instructor.upsert({
      where: {userId: instructorUserId},
      update: {
        sourceId,
        phoneNumber,
        jobTitle
      },
      create: {
        userId: instructorUserId,
        sourceId,
        phoneNumber,
        jobTitle
      }
    })
  }
}

async function main() {
  console.log('[import-instructors] start')

  const parser = fs
    .createReadStream(CSV_PATH)
    .pipe(
      parse({
        columns: true,
        skip_empty_lines: true,
        trim: true
      })
    )

  let count = 0

  for await (const row of parser) {
    await prisma.$transaction(async () => {
      await importRow(row)
    })

    count++

    if (count % 100 === 0) {
      console.log(`[import-instructors] ${count} instructeurs importés`)
    }
  }

  console.log(`[import-instructors] terminé (${count} instructeurs)`)
}

try {
  await main()
} catch (error) {
  console.error(error)
  throw error
} finally {
  await prisma.$disconnect()
}
