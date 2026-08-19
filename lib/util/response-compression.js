import process from 'node:process'

import compression from 'compression'

const DEFAULT_COMPRESSION_MIN_BYTES = 1024
const {filter: defaultCompressionFilter} = compression

function parseNonNegativeInteger(value, fallback) {
  if (!/^\d+$/.test(value || '')) {
    return fallback
  }

  return Number.parseInt(value, 10)
}

export function readResponseCompressionMinBytes() {
  return parseNonNegativeInteger(
    process.env.API_RESPONSE_COMPRESSION_MIN_BYTES,
    DEFAULT_COMPRESSION_MIN_BYTES
  )
}

export function shouldCompressJson(request, response) {
  const contentDisposition = String(response.getHeader('Content-Disposition') || '')
  const contentEncoding = String(response.getHeader('Content-Encoding') || 'identity')
    .toLowerCase()
  const contentType = String(response.getHeader('Content-Type') || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()

  if (contentDisposition || contentEncoding !== 'identity') {
    return false
  }

  const isJson = contentType === 'application/json' || contentType.endsWith('+json')
  return isJson && defaultCompressionFilter(request, response)
}

export function createResponseCompressionMiddleware() {
  return compression({
    filter: shouldCompressJson,
    threshold: readResponseCompressionMinBytes()
  })
}
