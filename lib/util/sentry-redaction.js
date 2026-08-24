const SENSITIVE_KEY_PATTERN = /(activation.?url|authorization|cookie|password|passwd|secret|token|api[-_]?key|credential)/i
const FILTERED_VALUE = '[Filtered]'

function redactValue(value, seen, path = []) {
  if (!value || typeof value !== 'object') {
    return value
  }

  if (seen.has(value)) {
    return '[Circular]'
  }

  seen.add(value)

  if (Array.isArray(value)) {
    return value.map((item, index) => redactValue(item, seen, [...path, String(index)]))
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key)
        ? FILTERED_VALUE
        : redactPotentialJsonBody(key, nestedValue, seen, path)
    ])
  )
}

function redactPotentialJsonBody(key, value, seen, parentPath) {
  const nextPath = [...parentPath, key]
  const isRequestBody = parentPath.at(-1) === 'request' && /^(body|data)$/i.test(key)

  if (typeof value !== 'string' || !isRequestBody) {
    return redactValue(value, seen, nextPath)
  }

  try {
    const parsed = JSON.parse(value)
    return JSON.stringify(redactValue(parsed, seen))
  } catch {
    return FILTERED_VALUE
  }
}

export function redactSentryEvent(event) {
  return redactValue(event, new WeakSet())
}

export const SENTRY_FILTERED_VALUE = FILTERED_VALUE
