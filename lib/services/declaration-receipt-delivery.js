import {prisma} from '../../db/prisma.js'
import {renderDeclarationReceipt} from '../util/declaration-receipt-email.js'
import {classifyReceiptSmtpError, getDeclarationReceiptMailConfig, sendDeclarationReceiptEmail} from '../util/declaration-receipt-smtp.js'
import {getReceiptDeliveryAccess} from './declaration-receipt-recipient.js'

const MAX_ATTEMPTS = 3
const MINUTE = 60_000
const retryMinutes = [1, 5]
let warnedAboutDisabledDelivery = false

async function claimNextReceipt(client, now) {
  const leaseEnd = new Date(now.getTime() + 5 * MINUTE)
  // An older pending revision also blocks its successors while its retry is delayed.
  const [receipt] = await client.$queryRaw`
    WITH candidate AS (
      SELECT r.id FROM "DeclarationReceipt" r
      WHERE r.status IN ('PENDING', 'PREPARING') AND r."nextAttemptAt" <= ${now}
        AND r.attempts < ${MAX_ATTEMPTS}
        AND NOT EXISTS (
          SELECT 1 FROM "DeclarationReceipt" earlier
          WHERE earlier."declarationId" = r."declarationId" AND earlier.revision < r.revision
            AND earlier.status IN ('PENDING', 'PREPARING', 'SENDING')
        )
      ORDER BY r."nextAttemptAt", r."createdAt", r.id
      LIMIT 1 FOR UPDATE OF r SKIP LOCKED
    )
    UPDATE "DeclarationReceipt" r
      SET status = 'PREPARING', attempts = r.attempts + 1, "nextAttemptAt" = ${leaseEnd}
    FROM candidate WHERE r.id = candidate.id RETURNING r.*`
  return receipt
}

async function transition(client, receipt, from, data) {
  // The attempt number fences a previous worker that resumed after its preparation lease expired.
  const result = await client.declarationReceipt.updateMany({
    where: {id: receipt.id, attempts: receipt.attempts, status: from},
    data
  })
  return result.count > 0
}

function failureState(code, attempts, now) {
  if (code === 'SMTP_UNKNOWN') return {status: 'UNKNOWN', failureCode: code}
  if (code === 'SMTP_REJECTED' || attempts >= MAX_ATTEMPTS) return {status: 'FAILED', failureCode: code}
  return {status: 'PENDING', failureCode: code, nextAttemptAt: new Date(now.getTime() + retryMinutes[attempts - 1] * MINUTE)}
}

async function recordFailure(receipt, from, code, {client, clock, logger}) {
  const state = failureState(code, receipt.attempts, clock())
  if (await transition(client, receipt, from, state) && state.status !== 'PENDING') {
    logger.warn(`Mail récapitulatif ${receipt.id} : ${state.status} (${code}).`)
  }
}

async function deliver(receipt, options) {
  const {client, config, access, render, send, clock} = options
  let content
  try {
    const rights = await access(client, receipt)
    if (!rights.deliver) {
      await transition(client, receipt, 'PREPARING', {status: 'SKIPPED', failureCode: 'RECIPIENT_UNAVAILABLE'})
      return
    }
    content = await render(receipt, {frontUrl: config.frontUrl, canEdit: rights.canEdit})
  } catch {
    await recordFailure(receipt, 'PREPARING', 'PREPARATION_FAILED', options)
    return
  }
  const sending = await transition(client, receipt, 'PREPARING', {
    status: 'SENDING', failureCode: null, nextAttemptAt: new Date(clock().getTime() + 15 * MINUTE)
  })
  if (!sending) return

  try {
    await send(receipt, content, config)
  } catch (error) {
    await recordFailure(receipt, 'SENDING', classifyReceiptSmtpError(error), options)
    return
  }
  // A DB failure here leaves SENDING in place. Recovery records an unknown outcome instead of sending twice.
  await transition(client, receipt, 'SENDING', {status: 'SENT', sentAt: clock(), failureCode: null})
}

export async function processDeclarationReceipts({
  client = prisma, config = getDeclarationReceiptMailConfig(), access = getReceiptDeliveryAccess,
  render = renderDeclarationReceipt, send = sendDeclarationReceiptEmail, clock = () => new Date(),
  limit = 50, logger = console
} = {}) {
  if (!config) {
    const pending = await client.declarationReceipt.count({where: {status: 'PENDING'}})
    if (pending && !warnedAboutDisabledDelivery) {
      logger.warn('Des mails récapitulatifs attendent la configuration de DECLARATION_RECEIPT_SMTP_HOST sur le worker.')
    }
    warnedAboutDisabledDelivery = Boolean(pending)
    return {processed: 0, pending, configured: false}
  }
  warnedAboutDisabledDelivery = false
  const expired = {lte: clock()}
  const unknown = await client.declarationReceipt.updateMany({
    where: {status: 'SENDING', nextAttemptAt: expired},
    data: {status: 'UNKNOWN', failureCode: 'SMTP_UNKNOWN'}
  })
  const failed = await client.declarationReceipt.updateMany({
    where: {status: 'PREPARING', nextAttemptAt: expired, attempts: {gte: MAX_ATTEMPTS}},
    data: {status: 'FAILED', failureCode: 'PREPARATION_FAILED'}
  })
  if (unknown.count || failed.count) {
    logger.warn(`Mails récapitulatifs interrompus : ${unknown.count} envoi(s) à vérifier, ${failed.count} préparation(s) en échec.`)
  }
  let processed = 0
  // Settle one receipt before claiming another. Other workers can process independent declarations in parallel.
  /* eslint-disable no-await-in-loop */
  while (processed < limit) {
    const receipt = await claimNextReceipt(client, clock())
    if (!receipt) break
    await deliver(receipt, {client, config, access, render, send, clock, logger})
    processed++
  }
  /* eslint-enable no-await-in-loop */
  return {processed, configured: true}
}
