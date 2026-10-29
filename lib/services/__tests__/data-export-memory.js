import process from 'node:process'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
import {performance} from 'node:perf_hooks'
import test from 'ava'

// The failing testing shape had ~28k rows × 45 columns. The ordinary
// Workbook DOM cannot fit this shape in 128 MiB. Exercise the full native cap
// and sample actual RSS (resourceUsage.maxRSS can predate exec in CI launchers).
test('100 000 lignes de 45 colonnes sont écrites et relues sous un heap de 128 Mio', async t => {
  const script = fileURLToPath(new URL('./__fixtures__/data-export-memory.js', import.meta.url))
  const startedAt = performance.now()
  // V8 coverage also instruments the XLSX reader. Allow slower CI runners
  // without changing the memory limits or exceeding AVA's 180-second timeout.
  const {stdout} = await promisify(execFile)(process.execPath, ['--max-old-space-size=128', script, '100000'], {
    env: {...process.env, NODE_ENV: 'test'}, timeout: 150_000, maxBuffer: 1024 * 1024
  })
  const result = JSON.parse(stdout.trim())
  t.is(result.rowCount, 100_000)
  t.is(result.readCount, 100_000)
  t.is(result.columnCount, 45)
  t.true(result.bytes > 0)
  t.true(result.writeMaxRssBytes < 512 * 1024 * 1024)
  t.log(`Durée : ${((performance.now() - startedAt) / 1000).toFixed(1)} s ; pic RSS : ${(result.observedRssBytes / 1024 / 1024).toFixed(1)} Mio ; fichier : ${result.bytes} octets`)
})
