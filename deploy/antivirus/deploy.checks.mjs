import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {deployAntivirus} from './deploy.mjs'
import {readConfiguration, expectedSettings, PROJECT_ID, REGISTRY} from './configuration.mjs'

const config = readConfiguration({DEPLOY_ENV: 'testing', SCW_DEFAULT_PROJECT_ID: PROJECT_ID,
  CLAMAV_NAMESPACE_ID: '11111111-1111-4111-8111-111111111111', SCW_SECRET_KEY: 'synthetic-not-a-credential',
  IMAGE_REF: `${REGISTRY}/upload-antivirus@sha256:${'a'.repeat(64)}`})
const scannerId = '22222222-2222-4222-8222-222222222222'
function fixture({existing = false, drift, failWrite = false} = {}) {
  const calls = []
  const namespace = {id: config.namespaceId, name: config.namespaceName, project_id: PROJECT_ID,
    region: 'fr-par', status: 'ready', environment_variables: {APP_ENV: 'testing'},
    secret_environment_variables: {CLAMAV_INVOKE_TOKEN: 'synthetic-hash'}}
  const scanner = {...expectedSettings(config), id: scannerId, region: 'fr-par', status: 'ready',
    image: `${REGISTRY}/upload-antivirus@sha256:${'b'.repeat(64)}`,
    private_endpoint: `http://${scannerId}.${config.networkId}.internal`,
    public_endpoint: 'https://scanner.example.test', default_public_endpoint_enabled: false, ...drift}
  const fetchRequest = async (url, options = {}) => {
    const parsed = new URL(url)
    const method = options.method ?? 'GET'
    const body = options.body && JSON.parse(options.body)
    calls.push({method, pathname: parsed.pathname, body})
    if (parsed.hostname === 'scanner.example.test') return new Response('', {status: 404})
    assert.equal(parsed.origin, 'https://api.scaleway.com')
    assert.equal(options.headers['X-Auth-Token'], config.credential)
    assert.equal(options.redirect, 'error')
    if (method !== 'GET' && failWrite) return new Response('private upstream diagnostics', {status: 503})
    if (parsed.pathname.endsWith(`/namespaces/${config.namespaceId}`)) return Response.json(namespace)
    if (method === 'GET' && parsed.pathname.endsWith('/containers')) return Response.json({total_count: existing ? 1 : 0, containers: existing ? [scanner] : []})
    if (method === 'POST' && parsed.pathname.endsWith('/containers')) {
      Object.assign(scanner, body)
      return Response.json(scanner)
    }
    if (parsed.pathname.endsWith(`/containers/${scannerId}`)) {
      if (method === 'PATCH') Object.assign(scanner, body)
      return Response.json(scanner)
    }
    if (method === 'POST' && parsed.pathname.endsWith(`/containers/${scannerId}/deploy`)) return Response.json(scanner)
    throw new Error('Unexpected resource access')
  }
  return {calls, fetchRequest}
}
async function run(t, options) {
  const proofDirectory = await mkdtemp(join(tmpdir(), 'antivirus-deploy-check-'))
  t.after(() => rm(proofDirectory, {recursive: true, force: true}))
  const f = fixture(options)
  return {fixture: f, deploy: () => deployAntivirus(config, {fetchRequest: f.fetchRequest, wait: async () => {}, proofDirectory})}
}
test('initial deployment creates only the private on-demand scanner', async t => {
  const {fixture: f, deploy} = await run(t)
  const proof = await deploy()
  assert.equal(proof.created, true)
  assert.equal(proof.publicEndpointDisabled, true)
  const creation = f.calls.find(call => call.method === 'POST' && call.pathname.endsWith('/containers'))
  assert.equal(creation.body.enable_default_public_endpoint, false)
  assert.equal(creation.body.enable_private_endpoint, true)
  assert.equal(creation.body.min_scale, 0)
  assert.deepEqual(creation.body.secret_environment_variables, {})
  assert(!f.calls.some(call => call.method === 'PATCH'))
})
test('signature refresh patches only the immutable image and preserves secrets', async t => {
  const {fixture: f, deploy} = await run(t, {existing: true})
  assert.equal((await deploy()).created, false)
  assert.deepEqual(f.calls.filter(call => call.method === 'PATCH').map(call => call.body), [{image: config.image}])
  assert(!f.calls.some(call => call.method !== 'GET' && call.pathname.includes('/namespaces/')))
})
test('configuration drift blocks a refresh before writes', async t => {
  const {fixture: f, deploy} = await run(t, {existing: true, drift: {min_scale: 1}})
  await assert.rejects(deploy(), /configuration drift/)
  assert(f.calls.every(call => call.method === 'GET'))
})
test('failed mutation is not automatically replayed and error body stays private', async t => {
  const {fixture: f, deploy} = await run(t, {existing: true, failWrite: true})
  await assert.rejects(deploy(), error => /HTTP 503/.test(error.message) && !error.message.includes('private upstream'))
  assert.equal(f.calls.filter(call => call.method !== 'GET').length, 1)
})
