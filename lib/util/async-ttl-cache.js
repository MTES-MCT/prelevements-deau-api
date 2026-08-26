async function runLoader(loader) {
  return loader()
}

export function createAsyncTtlCache({ttlMs, now = Date.now}) {
  let cachedValue
  let expiresAt = 0
  let generation = 0
  let pendingRequest = null

  return {
    clear() {
      cachedValue = undefined
      expiresAt = 0
      generation += 1
      pendingRequest = null
    },
    async get(loader) {
      if (cachedValue !== undefined && expiresAt > now()) {
        return cachedValue
      }

      if (pendingRequest) {
        return pendingRequest
      }

      const requestGeneration = generation
      const request = runLoader(loader)
      pendingRequest = request

      try {
        const value = await request

        if (generation === requestGeneration) {
          cachedValue = value
          expiresAt = now() + ttlMs
        }

        return value
      } finally {
        if (pendingRequest === request) {
          pendingRequest = null
        }
      }
    }
  }
}
