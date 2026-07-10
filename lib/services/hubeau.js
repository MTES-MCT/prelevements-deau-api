import process from 'node:process'
import {setTimeout as sleep} from 'node:timers/promises'

/* External pagination and retry attempts are intentionally sequential. */
/* eslint-disable no-await-in-loop */

const DEFAULT_PIEZOMETRY_BASE_URL = 'https://hubeau.eaufrance.fr/api/v1/niveaux_nappes'
const DEFAULT_HYDROMETRY_BASE_URL = 'https://hubeau.eaufrance.fr/api/v2/hydrometrie'
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_RETRIES = 3
const PIEZOMETRY_PAGE_SIZE = 5000
const HYDROMETRY_PAGE_SIZE = 20_000

export class HubeauError extends Error {
  constructor(message, {status = null, cause = null} = {}) {
    super(message, {cause})
    this.name = 'HubeauError'
    this.status = status
  }
}

function optionalValue(value) {
  return value === undefined || value === null || value === '' ? null : value
}

function buildURL(baseURL, operation, parameters = {}) {
  const url = new URL(`${baseURL.replace(/\/$/, '')}/${operation}`)
  url.searchParams.set('format', 'json')

  for (const [key, rawValue] of Object.entries(parameters)) {
    const value = optionalValue(rawValue)
    if (value !== null) {
      url.searchParams.set(key, String(value))
    }
  }

  return url
}

function getRetryDelay(response, attempt) {
  const retryAfter = Number(response?.headers?.get?.('retry-after'))
  return Number.isFinite(retryAfter) && retryAfter > 0
    ? retryAfter * 1000
    : attempt * 1000
}

function createRequester({fetchImpl, retries, sleepImpl, timeoutMs}) {
  return async url => {
    let lastError

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const response = await fetchImpl(url, {
          signal: controller.signal,
          headers: {
            accept: 'application/json',
            'user-agent': 'partageonsleau-api/1.0'
          }
        })

        if (response.ok) {
          return await response.json()
        }

        const responseBody = await response.text()
        const error = new HubeauError(
          `Hub’Eau a répondu HTTP ${response.status} pour ${url.pathname}: ${responseBody.slice(0, 300)}`,
          {status: response.status}
        )

        if (response.status !== 429 && response.status < 500) {
          throw error
        }

        lastError = error
        if (attempt < retries) {
          await sleepImpl(getRetryDelay(response, attempt))
        }
      } catch (error) {
        if (error instanceof HubeauError && error.status && error.status < 500 && error.status !== 429) {
          throw error
        }

        lastError = error
        if (attempt < retries) {
          await sleepImpl(attempt * 1000)
        }
      } finally {
        clearTimeout(timeout)
      }
    }

    throw new HubeauError(`Impossible de joindre Hub’Eau pour ${url.pathname}.`, {cause: lastError})
  }
}

function assertNextURL(nextURL, expectedBaseURL) {
  const url = new URL(nextURL)
  const expected = new URL(expectedBaseURL)

  if (url.host !== expected.host) {
    throw new HubeauError('Hub’Eau a retourné une URL de pagination inattendue.')
  }

  return url
}

function createPaginator(request) {
  return async (baseURL, operation, parameters) => {
    let url = buildURL(baseURL, operation, parameters)
    const rows = []
    let pageCount = 0

    while (url) {
      const payload = await request(url)
      rows.push(...(Array.isArray(payload.data) ? payload.data : []))
      pageCount += 1

      if (!payload.next) {
        break
      }

      if (pageCount >= 100) {
        throw new HubeauError(`Pagination Hub’Eau interrompue après ${pageCount} pages.`)
      }

      url = assertNextURL(payload.next, baseURL)
    }

    return rows
  }
}

function requiredStation(rows, stationCode, typeLabel) {
  const station = rows[0]
  if (!station) {
    throw new HubeauError(`${typeLabel} introuvable pour le code ${stationCode}.`, {status: 404})
  }

  return station
}

function getPiezometerIdentifierParameters(identifier) {
  const value = String(identifier).trim().toUpperCase()
  return /^BSS[\dA-Z]+$/.test(value)
    ? {bss_id: value}
    : {code_bss: value}
}

export function createHubeauClient({
  fetchImpl = globalThis.fetch,
  hydrometryBaseURL = process.env.HUBEAU_HYDROMETRY_BASE_URL || DEFAULT_HYDROMETRY_BASE_URL,
  piezometryBaseURL = process.env.HUBEAU_PIEZOMETRY_BASE_URL || DEFAULT_PIEZOMETRY_BASE_URL,
  retries = Number(process.env.HUBEAU_REQUEST_RETRIES || DEFAULT_RETRIES),
  sleepImpl = sleep,
  timeoutMs = Number(process.env.HUBEAU_REQUEST_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
} = {}) {
  const request = createRequester({fetchImpl, retries, sleepImpl, timeoutMs})
  const paginate = createPaginator(request)

  return {
    async getPiezometer(stationCode) {
      const payload = await request(buildURL(piezometryBaseURL, 'stations', {
        ...getPiezometerIdentifierParameters(stationCode),
        size: 1
      }))

      return requiredStation(payload.data ?? [], stationCode, 'Piézomètre')
    },

    async getFlowStation(stationCode) {
      const payload = await request(buildURL(hydrometryBaseURL, 'referentiel/stations', {
        code_station: stationCode,
        size: 1
      }))

      return requiredStation(payload.data ?? [], stationCode, 'Station hydrométrique')
    },

    listGroundwaterChronicles(stationCode, {bssId, startDate, endDate} = {}) {
      return paginate(piezometryBaseURL, 'chroniques', {
        ...(bssId
          ? {bss_id: bssId}
          : {code_bss: stationCode}),
        date_debut_mesure: startDate,
        date_fin_mesure: endDate,
        sort: 'asc',
        size: PIEZOMETRY_PAGE_SIZE
      })
    },

    listGroundwaterRealtime(stationCode, {bssId, startDate, endDate} = {}) {
      return paginate(piezometryBaseURL, 'chroniques_tr', {
        ...(bssId
          ? {bss_id: bssId}
          : {code_bss: stationCode}),
        date_debut_mesure: startDate,
        date_fin_mesure: endDate,
        sort: 'asc',
        size: PIEZOMETRY_PAGE_SIZE
      })
    },

    listFlowRealtime(stationCode, {startDate, endDate} = {}) {
      return paginate(hydrometryBaseURL, 'observations_tr', {
        code_entite: stationCode,
        grandeur_hydro: 'Q',
        date_debut_obs: startDate,
        date_fin_obs: endDate,
        sort: 'asc',
        size: HYDROMETRY_PAGE_SIZE
      })
    },

    listFlowDaily(stationCode, {startDate, endDate} = {}) {
      return paginate(hydrometryBaseURL, 'obs_elab', {
        code_entite: stationCode,
        grandeur_hydro_elab: 'QmnJ',
        date_debut_obs_elab: startDate,
        date_fin_obs_elab: endDate,
        size: HYDROMETRY_PAGE_SIZE
      })
    },

    listFlowMonthly(stationCode, {startDate, endDate} = {}) {
      return paginate(hydrometryBaseURL, 'obs_elab', {
        code_entite: stationCode,
        grandeur_hydro_elab: 'QmM',
        date_debut_obs_elab: startDate,
        date_fin_obs_elab: endDate,
        size: HYDROMETRY_PAGE_SIZE
      })
    }
  }
}

export const hubeau = createHubeauClient()

/* eslint-enable no-await-in-loop */
