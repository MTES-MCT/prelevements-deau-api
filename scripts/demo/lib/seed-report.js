import {randomUUID} from 'node:crypto'
import {chmod, lstat, mkdir, open, readFile, rename, unlink} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import {redactSensitive} from './seed-target.js'

export function describeSeedOutcome({
  command,
  authorized,
  apply,
  verification,
  operationError
}) {
  let databaseWriteStatus = 'NOT_REQUESTED'
  if (command === 'apply' && !authorized) {
    databaseWriteStatus = 'DRY_RUN'
  } else if (command === 'apply' && apply?.success === true) {
    databaseWriteStatus = 'COMMITTED'
  } else if (command === 'apply') {
    databaseWriteStatus = 'NOT_CONFIRMED'
  }

  const committed = databaseWriteStatus === 'COMMITTED'

  if (operationError) {
    return {
      success: false,
      status: committed ? 'COMMITTED_POSTCHECK_FAILED' : 'FAILED',
      databaseWriteStatus
    }
  }

  if (verification?.success === false) {
    return {
      success: false,
      status: committed ? 'COMMITTED_VERIFICATION_FAILED' : 'VERIFICATION_FAILED',
      databaseWriteStatus
    }
  }

  if (committed && !verification) {
    return {
      success: false,
      status: 'COMMITTED_WITHOUT_VERIFICATION',
      databaseWriteStatus
    }
  }

  if (command === 'apply' && authorized && !committed) {
    return {success: false, status: 'APPLY_NOT_CONFIRMED', databaseWriteStatus}
  }

  if (command === 'verify' && !verification) {
    return {success: false, status: 'VERIFICATION_NOT_RUN', databaseWriteStatus}
  }

  return {success: true, status: 'COMPLETED', databaseWriteStatus}
}

export function formatSeedOutcome(outcome) {
  return `[demo-seed] status=${outcome.status} databaseWriteStatus=${outcome.databaseWriteStatus}`
}

function resolveReportPath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('Le chemin du rapport est requis')
  }

  return path.resolve(filePath)
}

function serializeReport(report) {
  return `${JSON.stringify(redactSensitive(report), null, 2)}\n`
}

async function cleanupTemporaryFile(filePath, originalError) {
  try {
    await unlink(filePath)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      originalError.cleanupError = error
    }
  }
}

async function writeExclusivePrivateFile(filePath, content) {
  let handle
  let created = false

  try {
    handle = await open(filePath, 'wx', 0o600)
    created = true
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await chmod(filePath, 0o600)
  } catch (error) {
    if (handle) {
      await handle.close().catch(closeError => {
        error.closeError = closeError
      })
    }

    if (created) {
      await cleanupTemporaryFile(filePath, error)
    }

    throw error
  }
}

/**
 * Réserve le chemin final avant toute mutation de la base.
 *
 * Le fichier de réservation est déjà un rapport JSON valide et expurgé. Il
 * reste donc une trace explicite si le processus est interrompu entre la
 * transaction PostgreSQL et la publication du rapport final.
 */
export async function reserveSecureJsonReport(filePath, report = {}) {
  const absolutePath = resolveReportPath(filePath)
  const directory = path.dirname(absolutePath)
  const reservationId = randomUUID()
  await mkdir(directory, {recursive: true, mode: 0o700})
  await writeExclusivePrivateFile(absolutePath, serializeReport({
    ...report,
    success: false,
    status: 'RESERVED_BEFORE_DATABASE_OPERATION',
    reservationId
  }))

  const reportStat = await lstat(absolutePath)
  return Object.freeze({
    absolutePath,
    reservationId,
    device: reportStat.dev,
    inode: reportStat.ino
  })
}

async function assertOwnedReservation(reservation) {
  if (!reservation || typeof reservation !== 'object') {
    throw new Error('Réservation de rapport invalide')
  }

  const reportStat = await lstat(reservation.absolutePath)
  if (
    !reportStat.isFile()
    || reportStat.dev !== reservation.device
    || reportStat.ino !== reservation.inode
    || (reportStat.mode & 0o777) !== 0o600
  ) {
    throw new Error('Le fichier de réservation du rapport a été remplacé')
  }

  const reservedReport = JSON.parse(await readFile(reservation.absolutePath, 'utf8'))
  if (reservedReport.reservationId !== reservation.reservationId) {
    throw new Error('Le jeton de réservation du rapport ne correspond pas')
  }
}

export async function finalizeSecureJsonReport(reservation, report) {
  await assertOwnedReservation(reservation)

  const directory = path.dirname(reservation.absolutePath)
  const temporaryPath = path.join(
    directory,
    `.${path.basename(reservation.absolutePath)}.tmp-${process.pid}-${randomUUID()}`
  )

  try {
    await writeExclusivePrivateFile(temporaryPath, serializeReport(report))
    // Le renommage remplace atomiquement uniquement la réservation vérifiée.
    await rename(temporaryPath, reservation.absolutePath)
    return reservation.absolutePath
  } catch (error) {
    await cleanupTemporaryFile(temporaryPath, error)
    throw error
  }
}

export async function writeSecureJsonReport(filePath, report) {
  const reservation = await reserveSecureJsonReport(filePath)
  return finalizeSecureJsonReport(reservation, report)
}
