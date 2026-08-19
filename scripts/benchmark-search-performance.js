import process from 'node:process'
import {performance} from 'node:perf_hooks'

const DEFAULT_ITERATIONS = 12
const DEFAULT_WARMUPS = 2
const DEFAULT_CONCURRENCY = 1

function readPositiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function percentile(values, ratio) {
  if (values.length === 0) {
    return null
  }

  const sorted = values.toSorted((left, right) => left - right)
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1)
  return Math.round(sorted[index] * 10) / 10
}

function parseServerTiming(header) {
  const timings = {}

  for (const item of (header || '').split(',')) {
    const [name, ...parameters] = item.trim().split(';')
    const duration = parameters
      .map(parameter => parameter.trim().match(/^dur=(?<duration>[\d.]+)$/v))
      .find(Boolean)

    if (name && duration) {
      timings[name] = Number(duration.groups.duration)
    }
  }

  return timings
}

function buildScenarios() {
  const exactQuery = process.env.BENCHMARK_EXACT_QUERY || 'ferme'
  const fuzzyQuery = process.env.BENCHMARK_FUZZY_QUERY || 'ferne'
  const base = 'api/declarants/search?format=compact&page=1&pageSize=25'

  return [
    {name: 'declarants_default', path: base},
    {name: 'declarants_exact', path: `${base}&query=${encodeURIComponent(exactQuery)}`},
    {name: 'declarants_fuzzy', path: `${base}&query=${encodeURIComponent(fuzzyQuery)}`},
    {name: 'points_map', path: 'api/points-prelevement/map'}
  ]
}

async function runRequest(baseUrl, token, scenario) {
  const startedAt = performance.now()
  const response = await fetch(`${baseUrl}/${scenario.path}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`
    }
  })
  const body = await response.arrayBuffer()
  if (!response.ok) {
    throw new Error(`${scenario.name}: HTTP ${response.status}`)
  }

  const durationMs = performance.now() - startedAt

  return {
    apiTimings: parseServerTiming(response.headers.get('server-timing')),
    contentEncoding: response.headers.get('content-encoding') || 'identity',
    durationMs,
    logicalBytes: body.byteLength
  }
}

async function runConcurrent(count, concurrency, operation) {
  const results = Array.from({length: count})
  let nextIndex = 0

  const worker = async () => {
    while (nextIndex < count) {
      const index = nextIndex++
      results[index] = await operation()
    }
  }

  await Promise.all(
    Array.from({length: Math.min(count, concurrency)}, async () => worker())
  )
  return results
}

function summarize(scenario, samples) {
  const totalDurations = samples.map(sample => sample.durationMs)
  const apiDurations = samples
    .map(sample => sample.apiTimings.api)
    .filter(Number.isFinite)
  const logicalBytes = samples.map(sample => sample.logicalBytes)

  return {
    scenario: scenario.name,
    requests: samples.length,
    totalMs: {
      p50: percentile(totalDurations, 0.5),
      p95: percentile(totalDurations, 0.95),
      max: percentile(totalDurations, 1)
    },
    apiMs: {
      p50: percentile(apiDurations, 0.5),
      p95: percentile(apiDurations, 0.95),
      max: percentile(apiDurations, 1)
    },
    logicalBytes: percentile(logicalBytes, 0.5),
    contentEncodings: [...new Set(samples.map(sample => sample.contentEncoding))]
  }
}

async function main() {
  const baseUrl = (process.env.BENCHMARK_API_URL || '').replace(/\/$/v, '')
  const token = process.env.BENCHMARK_TOKEN

  if (!baseUrl || !token) {
    throw new Error('BENCHMARK_API_URL and BENCHMARK_TOKEN are required')
  }

  const iterations = readPositiveInteger(
    process.env.BENCHMARK_ITERATIONS,
    DEFAULT_ITERATIONS
  )
  const warmups = readPositiveInteger(process.env.BENCHMARK_WARMUPS, DEFAULT_WARMUPS)
  const concurrency = readPositiveInteger(
    process.env.BENCHMARK_CONCURRENCY,
    DEFAULT_CONCURRENCY
  )
  const summaries = []

  for (const scenario of buildScenarios()) {
    await runConcurrent(warmups, 1, async () => runRequest(baseUrl, token, scenario))
    const samples = await runConcurrent(
      iterations,
      concurrency,
      async () => runRequest(baseUrl, token, scenario)
    )
    summaries.push(summarize(scenario, samples))
  }

  console.log(JSON.stringify({
    measuredAt: new Date().toISOString(),
    iterations,
    concurrency,
    summaries
  }, null, 2))
}

await main()
