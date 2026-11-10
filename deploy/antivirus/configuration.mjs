import assert from 'node:assert/strict'

export const PROJECT_ID = '8b2f67a8-b474-4596-967f-fe1e0adba1b3'
export const REGISTRY = 'rg.fr-par.scw.cloud/prelevements-deau-api'
export const IMAGE_NAME = 'upload-antivirus'
export const NETWORKS = Object.freeze({
  testing: '106f8ec1-1be9-4f0e-826b-a9fdcc157319',
  demo: 'a600027e-6936-4538-acd7-3f2860113fc3',
  prod: '3a4a5621-4e6a-4195-b202-af3fc351e81c'
})
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/

export function readConfiguration(environment = process.env) {
  const name = environment.DEPLOY_ENV
  assert(Object.hasOwn(NETWORKS, name), 'Unknown antivirus deployment environment')
  assert.equal(environment.SCW_DEFAULT_PROJECT_ID, PROJECT_ID, 'Unexpected Scaleway project')
  assert.match(environment.CLAMAV_NAMESPACE_ID ?? '', uuid, 'Antivirus namespace ID required')
  assert(environment.SCW_SECRET_KEY, 'Deployment credential required')
  const imagePrefix = `${REGISTRY}/${IMAGE_NAME}@`
  assert((environment.IMAGE_REF ?? '').startsWith(imagePrefix)
    && /^sha256:[a-f0-9]{64}$/.test(environment.IMAGE_REF.slice(imagePrefix.length)), 'Checked immutable antivirus image required')
  return {environment: name, namespaceId: environment.CLAMAV_NAMESPACE_ID,
    namespaceName: `${name}-partageons-leau-antivirus`, containerName: `${name}-upload-antivirus`,
    networkId: NETWORKS[name], image: environment.IMAGE_REF, credential: environment.SCW_SECRET_KEY}
}

export function expectedSettings(config) {
  return {
    namespace_id: config.namespaceId, name: config.containerName, private_network_id: config.networkId,
    min_scale: 0, max_scale: 1, memory_limit_bytes: 4096000000, mvcpu_limit: 2000,
    privacy: 'public', protocol: 'http1', port: 8080, sandbox: 'v2', https_connections_only: true,
    // Public exposure is disabled; the scanner authenticates every scan with its own scoped token.
    enable_private_endpoint: true, enable_default_public_endpoint: false,
    scaling_option: {concurrent_requests_threshold: 2}, timeout: '180s',
    // Scaleway requires probe intervals >= 5s; retain a 120s startup allowance.
    startup_probe: {http: {path: '/readyz'}, interval: '5s', timeout: '2s', failure_threshold: 24},
    liveness_probe: {http: {path: '/readyz'}, interval: '30s', timeout: '2s', failure_threshold: 3},
    environment_variables: {}, secret_environment_variables: {}, command: [], args: [],
    tags: ['partageonsleau', 'antivirus', 'managed:antivirus-ci']
  }
}

export function assertNamespace(namespace, config) {
  assert.equal(namespace.id, config.namespaceId)
  assert.equal(namespace.name, config.namespaceName)
  assert.equal(namespace.project_id, PROJECT_ID)
  assert.equal(namespace.region, 'fr-par')
  assert.equal(namespace.status, 'ready')
  assert.deepEqual(namespace.environment_variables, {APP_ENV: config.environment})
  assert.deepEqual(Object.keys(namespace.secret_environment_variables ?? {}).sort(), ['CLAMAV_INVOKE_TOKEN'])
}

export function assertContainer(container, config) {
  const expected = expectedSettings(config)
  for (const key of ['namespace_id', 'name', 'private_network_id', 'min_scale', 'max_scale',
    'memory_limit_bytes', 'mvcpu_limit', 'privacy', 'protocol', 'port', 'sandbox', 'https_connections_only']) {
    assert.equal(container[key], expected[key], `Antivirus configuration drift: ${key}`)
  }
  assert.equal(container.region, 'fr-par')
  assert.equal(container.default_public_endpoint_enabled, false, 'Antivirus public endpoint must remain disabled')
  assert(container.private_endpoint?.includes(`${container.id}.${config.networkId}.internal`), 'Expected private endpoint missing')
  assert.equal(Number.parseFloat(container.timeout), 180)
  assert.deepEqual(container.scaling_option, expected.scaling_option)
  assert.deepEqual(container.environment_variables, {})
  assert.deepEqual(container.secret_environment_variables, {})
  assert.deepEqual(container.command ?? [], [])
  assert.deepEqual(container.args ?? [], [])
  for (const key of ['liveness_probe', 'startup_probe']) {
    assert.equal(container[key]?.http?.path, '/readyz')
    assert.equal(Number.parseFloat(container[key]?.interval), Number.parseFloat(expected[key].interval))
    assert.equal(Number.parseFloat(container[key]?.timeout), 2)
    assert.equal(container[key]?.failure_threshold, expected[key].failure_threshold)
  }
}
