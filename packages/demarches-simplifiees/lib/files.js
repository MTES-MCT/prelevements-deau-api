import {hashSync} from 'hasha'

function convertChecksum(checksum) {
  return hashSync(checksum, {algorithm: 'sha256'}).slice(0, 8)
}

function computeStorageKey({filename, checksum}) {
  return `${convertChecksum(checksum)}-${filename}`
}

export function transformUrlsDeep(obj, urlCollector) {
  if (Array.isArray(obj)) {
    return obj.map(item => transformUrlsDeep(item, urlCollector))
  }

  if (obj && typeof obj === 'object') {
    const entries = Object.entries(obj).map(([key, value]) => [
      key,
      transformUrlsDeep(value, urlCollector)
    ])

    const transformed = Object.fromEntries(entries)

    const {filename, checksum, url} = transformed

    if (typeof url === 'string' && typeof filename === 'string' && typeof checksum === 'string') {
      const {url: _, ...rest} = transformed
      const storageKey = computeStorageKey(transformed)
      urlCollector.set(storageKey, {url, filename, type: transformed.contentType})
      return {...rest, storageKey}
    }

    return transformed
  }

  return obj
}

