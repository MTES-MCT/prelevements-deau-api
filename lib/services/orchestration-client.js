import crypto from 'node:crypto'
import process from 'node:process'

export async function notifyDeclarationUploaded({declarationId, required = false}) {
  const baseUrl = process.env.ORCHESTRATION_BASE_URL
  const secret = process.env.ORCHESTRATION_WEBHOOK_SECRET

  if (!baseUrl) {
    if (required) {
      throw new Error('ORCHESTRATION_BASE_URL non défini')
    }

    console.warn('[orchestration] ORCHESTRATION_BASE_URL non défini, hook ignoré')
    return {queued: false, reason: 'ORCHESTRATION_BASE_URL_MISSING'}
  }

  if (!secret) {
    throw new Error('ORCHESTRATION_WEBHOOK_SECRET manquant')
  }

  const body = JSON.stringify({
    event: 'declaration.uploaded',
    declarationId
  })

  const signature = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex')

  const response = await fetch(`${baseUrl}/hooks/declarations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-PLE-Signature': signature
    },
    body
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`[orchestration] Hook failed ${response.status}: ${text}`)
  }

  let responseBody = null
  try {
    responseBody = await response.json()
  } catch {}

  return {
    queued: true,
    jobId: responseBody?.jobId ?? null
  }
}
