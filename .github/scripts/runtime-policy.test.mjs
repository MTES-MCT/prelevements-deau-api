import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import process from 'node:process'
import test from 'node:test'

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const manifest = JSON.parse(read('package.json'))
const lockfile = JSON.parse(read('package-lock.json'))

test('Scalingo, CI and local tooling require the same patched Node release', () => {
  const version = read('.nvmrc').trim()
  assert.match(version, /^\d+\.\d+\.\d+$/)
  assert.equal(manifest.engines.node, version)
  assert.equal(process.versions.node, version)
  assert.deepEqual(lockfile.packages[''].engines, manifest.engines)
})

test('Scalingo and CI use the same locked npm release', () => {
  assert.equal(manifest.packageManager, `npm@${manifest.engines.npm}`)
  assert.equal(execFileSync('npm', ['--version'], {encoding: 'utf8'}).trim(), manifest.engines.npm)
})
