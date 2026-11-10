import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {deployAntivirus} from './deploy.mjs'
import {readConfiguration, expectedSettings, PROJECT_ID, REGISTRY} from './configuration.mjs'

const configuration = environment => readConfiguration({DEPLOY_ENV: environment, SCW_DEFAULT_PROJECT_ID: PROJECT_ID,
  CLAMAV_NAMESPACE_ID: '11111111-1111-4111-8111-111111111111', SCW_SECRET_KEY: 'synthetic-not-a-credential',
  IMAGE_REF: `${REGISTRY}/upload-antivirus@sha256:${'a'.repeat(64)}`})
const scannerId = '22222222-2222-4222-8222-222222222222'
const rejectedAllocation = candidate => candidate.mvcpu_limit === 500
  && !(candidate.memory_limit_bytes >= 500000000 && candidate.memory_limit_bytes <= 2000000000)
const allocationError = () => Response.json({type: 'invalid_arguments',
  details: [{argument_name: 'memory_limit_bytes', reason: 'constraint'}]}, {status: 400})
function fixture({existing = false, drift, failWrite = false, environment = 'testing', previousSizing = false} = {}) {
  const config = configuration(environment)
  const calls = []
  const namespace = {id: config.namespaceId, name: config.namespaceName, project_id: PROJECT_ID,
    region: 'fr-par', status: 'ready', environment_variables: {APP_ENV: environment},
    secret_environment_variables: {CLAMAV_INVOKE_TOKEN: 'synthetic-hash'}}
  const scanner = {...expectedSettings(config), id: scannerId, region: 'fr-par', status: 'ready',
    image: `${REGISTRY}/upload-antivirus@sha256:${'b'.repeat(64)}`,
    private_endpoint: `http://${scannerId}.${config.networkId}.internal`,
    public_endpoint: 'https://scanner.example.test', default_public_endpoint_enabled: false,
    ...(previousSizing ? {memory_limit_bytes: 4096000000, mvcpu_limit: 2000, min_scale: 0} : {}), ...drift}
  const applyScannerUpdate = body => {
    if (rejectedAllocation({...scanner, ...body})) return allocationError()
    Object.assign(scanner, body)
    return Response.json(scanner)
  }
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
      // Real v1 API contract: 3s was rejected before creating any resource.
      const interval = Number.parseFloat(body.startup_probe?.interval)
      if (!(interval >= 5 && interval <= 120)) return Response.json({type: 'invalid_arguments',
        details: [{argument_name: 'startup_probe.interval', reason: 'constraint'}]}, {status: 400})
      return applyScannerUpdate(body)
    }
    if (parsed.pathname.endsWith(`/containers/${scannerId}`)) {
      if (method === 'PATCH') return applyScannerUpdate(body)
      return Response.json(scanner)
    }
    throw new Error('Unexpected resource access')
  }
  return {config, calls, fetchRequest}
}
async function run(t, options) {
  const proofDirectory = await mkdtemp(join(tmpdir(), 'antivirus-deploy-check-'))
  t.after(() => rm(proofDirectory, {recursive: true, force: true}))
  const f = fixture(options)
  return {fixture: f, deploy: () => deployAntivirus(f.config, {fetchRequest: f.fetchRequest, wait: async () => {}, proofDirectory})}
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
  assert.equal(Number.parseFloat(creation.body.startup_probe.interval) * creation.body.startup_probe.failure_threshold, 120)
  assert.deepEqual(creation.body.secret_environment_variables, {})
  assert(!f.calls.some(call => call.method === 'PATCH'))
})
test('signature refresh patches only the immutable image and preserves secrets', async t => {
  await Promise.all(['testing', 'demo', 'prod'].map(async environment => {
    const {fixture: f, deploy} = await run(t, {existing: true, environment})
    assert.equal((await deploy()).created, false)
    assert.deepEqual(f.calls.filter(call => call.method === 'PATCH').map(call => call.body), [{image: f.config.image}])
    assert(!f.calls.some(call => call.method !== 'GET' && call.pathname.includes('/namespaces/')))
  }))
})
test('only the complete original sizing transitions, without rewriting variables or secrets', async t => {
  await Promise.all(['testing', 'demo', 'prod'].map(async environment => {
    const {fixture: f, deploy} = await run(t, {existing: true, previousSizing: true, environment})
    const proof = await deploy()
    const minimum = environment === 'prod' ? 1 : 0
    assert.deepEqual(f.calls.filter(call => call.method !== 'GET').map(call => call.body), [{
      image: f.config.image, memory_limit_bytes: 2000000000, mvcpu_limit: 500, min_scale: minimum
    }])
    assert.deepEqual(proof.previousSizing, {memoryLimitBytes: 4096000000, mvcpuLimit: 2000, minScale: 0})
    assert.equal(proof.minScale, minimum)
    assert.equal(proof.memoryLimitBytes, 2000000000)
    assert.equal(proof.mvcpuLimit, 500)
  }))
})
test('Scaleway rejects 2048 MB at 500 mvCPU before changing the resource', async () => {
  const f = fixture({existing: true, previousSizing: true})
  const url = `https://api.scaleway.com/containers/v1/regions/fr-par/containers/${scannerId}`
  const options = {headers: {'X-Auth-Token': f.config.credential}, redirect: 'error'}
  const rejected = await f.fetchRequest(url, {...options, method: 'PATCH', body: JSON.stringify({
    image: f.config.image, memory_limit_bytes: 2048000000, mvcpu_limit: 500, min_scale: 0
  })})
  assert.equal(rejected.status, 400)
  const unchanged = await (await f.fetchRequest(url, options)).json()
  assert.equal(unchanged.memory_limit_bytes, 4096000000)
  assert.equal(unchanged.mvcpu_limit, 2000)
})
test('configuration drift blocks a refresh before writes', async t => {
  const cases = [{drift: {min_scale: 1}}, {environment: 'prod', drift: {min_scale: 0}},
    {drift: {memory_limit_bytes: 2048000000}},
    {previousSizing: true, drift: {mvcpu_limit: 500}}, {previousSizing: true, drift: {memory_limit_bytes: 2000000000}},
    {previousSizing: true, drift: {max_scale: 2}}, {previousSizing: true, drift: {default_public_endpoint_enabled: true}},
    {previousSizing: true, drift: {secret_environment_variables: {OTHER_SECRET: 'unexpected'}}},
    {previousSizing: true, drift: {environment_variables: {DATABASE_URL: 'unexpected'}}}]
  await Promise.all(cases.map(async options => {
    const {fixture: f, deploy} = await run(t, {existing: true, ...options})
    await assert.rejects(deploy())
    assert(f.calls.every(call => call.method === 'GET'))
  }))
})
test('failed mutation is not automatically replayed and error body stays private', async t => {
  const {fixture: f, deploy} = await run(t, {existing: true, failWrite: true})
  await assert.rejects(deploy(), error => /HTTP 503/.test(error.message) && !error.message.includes('private upstream'))
  assert.equal(f.calls.filter(call => call.method !== 'GET').length, 1)
})
