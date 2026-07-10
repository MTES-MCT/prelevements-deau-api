import process from 'node:process'

import createHttpError from 'http-errors'

const BREVO_API_URL = 'https://api.brevo.com/v3'
const BREVO_TEMPLATE_TIMEOUT_MS = 10_000

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#039;')
}

function renderParams(value, params, {html = false} = {}) {
  return String(value ?? '').replaceAll(
    /{{\s*params\.(\w+)\s*}}/g,
    (placeholder, key) => {
      if (!Object.hasOwn(params ?? {}, key)) {
        return placeholder
      }

      return html ? escapeHtml(params[key]) : String(params[key] ?? '')
    }
  )
}

function renderBrevoBuiltIns(value) {
  return String(value ?? '')
    .replaceAll(/{{\s*unsubscribe\s*}}/gi, '#aperçu-desinscription')
    .replaceAll(/{{\s*mirror\s*}}/gi, '#aperçu-miroir')
}

function extractUnresolvedPlaceholders(values) {
  const placeholders = new Set()

  for (const value of values) {
    for (const match of String(value ?? '').matchAll(/{{\s*([^{}]+?)\s*}}/g)) {
      placeholders.add(match[1].trim())
    }
  }

  return [...placeholders]
}

export function renderBrevoTemplatePreview(template, params) {
  const subject = renderParams(template.subject, params)
  const htmlContent = renderBrevoBuiltIns(renderParams(template.htmlContent, params, {html: true}))
  const textContent = renderBrevoBuiltIns(renderParams(template.textContent, params))

  return {
    subject,
    htmlContent,
    textContent,
    unresolvedPlaceholders: extractUnresolvedPlaceholders([subject, htmlContent, textContent])
  }
}

export async function getBrevoTemplate(templateId, {
  apiKey = process.env.BREVO_API_KEY,
  fetchImplementation = fetch
} = {}) {
  if (!apiKey) {
    throw createHttpError(503, 'BREVO_API_KEY manquant pour générer l’aperçu.')
  }

  const response = await fetchImplementation(`${BREVO_API_URL}/smtp/templates/${templateId}`, {
    headers: {
      accept: 'application/json',
      'api-key': apiKey
    },
    signal: AbortSignal.timeout(BREVO_TEMPLATE_TIMEOUT_MS)
  })
  let data = {}

  try {
    data = await response.json()
  } catch {}

  if (!response.ok) {
    throw createHttpError(502, data.message || `Brevo a répondu ${response.status}`)
  }

  return data
}

export async function buildBrevoTemplatePreview({
  templateId,
  params,
  recipient,
  apiKey,
  fetchImplementation
}) {
  const template = await getBrevoTemplate(templateId, {apiKey, fetchImplementation})
  const rendered = renderBrevoTemplatePreview(template, params)

  return {
    templateId,
    templateName: template.name ?? null,
    templateActive: template.isActive ?? null,
    recipient,
    params,
    approximate: true,
    ...rendered
  }
}
