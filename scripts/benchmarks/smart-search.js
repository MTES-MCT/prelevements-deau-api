import {performance} from 'node:perf_hooks'
import process from 'node:process'

import {rankSearchDocuments} from '../../lib/services/smart-search.js'

const ITERATIONS = Number.parseInt(process.env.BENCHMARK_ITERATIONS ?? '100', 10)
const SIZES = [444, 1200]
const QUERIES = [
  'ferme beauvert',
  'femre beauvert',
  'BSS-00123',
  'exploitation agricole',
  'terme absent'
]

function createDocuments(size) {
  return Array.from({length: size}, (_, index) => {
    const number = String(index).padStart(5, '0')
    const isTarget = index === Math.floor(size / 2)

    return {
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      primaryLabel: isTarget ? 'Ferme de Beauvert' : `Exploitation ${number}`,
      humanText: isTarget
        ? 'Ferme de Beauvert irrigation Saint Martin'
        : `Exploitation agricole commune ${number} irrigation`,
      identifierText: isTarget
        ? 'BSS-00123 12345678901234 contact@example.test'
        : `BSS-${number} contact-${number}@example.test`
    }
  })
}

function percentile(samples, ratio) {
  return samples[Math.floor((samples.length - 1) * ratio)]
}

const rows = []

for (const size of SIZES) {
  const documents = createDocuments(size)

  for (const query of QUERIES) {
    for (let index = 0; index < 10; index++) {
      rankSearchDocuments(documents, query)
    }

    const samples = []
    let matchCount = 0

    for (let index = 0; index < ITERATIONS; index++) {
      const startedAt = performance.now()
      const matches = rankSearchDocuments(documents, query)
      samples.push(performance.now() - startedAt)
      matchCount = matches.length
    }

    samples.sort((left, right) => left - right)
    rows.push({
      documents: size,
      query,
      matches: matchCount,
      p50Ms: percentile(samples, 0.5).toFixed(2),
      p95Ms: percentile(samples, 0.95).toFixed(2),
      maxMs: samples.at(-1).toFixed(2)
    })
  }
}

console.table(rows)
