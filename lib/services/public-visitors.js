import process from 'node:process'

import {resolvePublicStatsMonth, shiftPublicStatsMonth} from '../models/public-stats.js'

const WEBSITE = 'https://partageonsleau.beta.gouv.fr/'
const SEGMENT = [WEBSITE, WEBSITE.replace('https:', 'http:')]
  .map(url => `pageUrl=^${encodeURIComponent(url)}`).join(',')
const CACHE_TTL_MS = 60 * 60 * 1000
const RETRY_TTL_MS = 60 * 1000

export function unavailablePublicVisitors(now = new Date()) {
  const lastMonth = resolvePublicStatsMonth(undefined, now)
  return {
    website: WEBSITE,
    months: Array.from({length: 6}, (_, index) => ({
      month: shiftPublicStatsMonth(lastMonth, index - 5),
      uniqueVisitors: null,
      status: 'unavailable'
    })),
    fetchedAt: null
  }
}

function reportingEndpoint(value) {
  try {
    const url = new URL(value)
    // Never send a credential in cleartext, to a redirect, or through a URL query.
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      return null
    }

    return new URL('index.php', url.href.endsWith('/') ? url : `${url.href}/`).href
  } catch {
    return null
  }
}

function uniqueVisitorCount(result) {
  const value = typeof result === 'number' ? result : result?.value
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

export function createPublicVisitorsLoader({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000
} = {}) {
  // One rolling six-month snapshot; no visitor data or credentials are persisted.
  let cache

  return async function loadPublicVisitors({now = new Date()} = {}) {
    const unavailable = unavailablePublicVisitors(now)
    const endpoint = reportingEndpoint(env.MATOMO_REPORTING_URL)
    const siteId = env.MATOMO_REPORTING_SITE_ID?.trim()
    const token = env.MATOMO_REPORTING_TOKEN?.trim()
    if (!endpoint || !/^[1-9]\d*$/.test(siteId || '') || !token) {
      return unavailable
    }

    const lastMonth = unavailable.months.at(-1).month
    if (cache && cache.endpoint === endpoint && cache.siteId === siteId && cache.token === token
      && cache.month === lastMonth && (cache.pending || cache.expiresAt > now.getTime())) {
      return cache.promise
    }

    const entry = {endpoint, siteId, token, month: lastMonth, pending: true}
    cache = entry
    entry.promise = (async () => {
      // Install the cache entry before invoking the network, including test doubles.
      await Promise.resolve()
      let snapshot = unavailable
      try {
        const body = new URLSearchParams({module: 'API', method: 'API.getBulkRequest', format: 'JSON', token_auth: token})
        for (const [index, {month}] of unavailable.months.entries()) {
          body.set(`urls[${index}]`, new URLSearchParams({
            method: 'VisitsSummary.getUniqueVisitors',
            idSite: siteId,
            period: 'month',
            date: `${month}-01`,
            segment: SEGMENT,
            format_metrics: '0'
          }).toString())
        }

        const response = await fetchImpl(endpoint, {
          method: 'POST',
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs)
        })
        if (response.ok) {
          const results = await response.json()
          if (Array.isArray(results) && results.length === unavailable.months.length) {
            const months = unavailable.months.map((row, index) => {
              const uniqueVisitors = uniqueVisitorCount(results[index])
              return {...row, uniqueVisitors, status: uniqueVisitors === null ? 'unavailable' : 'complete'}
            })
            snapshot = {...unavailable, months, fetchedAt: months.some(row => row.status === 'complete') ? now.toISOString() : null}
          }
        }
      } catch {
        // Matomo errors must not break business statistics or disclose request bodies.
      }

      entry.pending = false
      entry.expiresAt = now.getTime() + (snapshot.months.every(row => row.status === 'complete') ? CACHE_TTL_MS : RETRY_TTL_MS)
      return snapshot
    })()
    return entry.promise
  }
}

export const getPublicVisitors = createPublicVisitorsLoader()
