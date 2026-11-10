import test from 'node:test'
import assert from 'node:assert/strict'
import {readConfiguration, expectedSettings, assertContainer, PROJECT_ID, REGISTRY} from './configuration.mjs'

const env = {DEPLOY_ENV: 'testing', SCW_DEFAULT_PROJECT_ID: PROJECT_ID,
  CLAMAV_NAMESPACE_ID: '11111111-1111-4111-8111-111111111111', SCW_SECRET_KEY: 'synthetic-not-a-credential',
  IMAGE_REF: `${REGISTRY}/upload-antivirus@sha256:${'a'.repeat(64)}`}
const config = readConfiguration(env)
function container() {
  return {...expectedSettings(config), id: '22222222-2222-4222-8222-222222222222', region: 'fr-par',
    private_endpoint: `http://22222222-2222-4222-8222-222222222222.${config.networkId}.internal`,
    default_public_endpoint_enabled: false}
}
test('only named environments and immutable scanner image are deployable', () => {
  for (const override of [{DEPLOY_ENV: 'staging'}, {SCW_DEFAULT_PROJECT_ID: 'other'},
    {IMAGE_REF: `${REGISTRY}/upload-antivirus:latest`}, {CLAMAV_NAMESPACE_ID: ''}, {SCW_SECRET_KEY: ''}]) {
    assert.throws(() => readConfiguration({...env, ...override}))
  }
})
test('private-only scale-to-zero scanner configuration is mandatory', () => {
  assert.doesNotThrow(() => assertContainer(container(), config))
  for (const override of [{min_scale: 1}, {max_scale: 2}, {default_public_endpoint_enabled: true},
    {private_endpoint: null}, {private_network_id: 'other'}, {namespace_id: 'other'},
    {secret_environment_variables: {DATABASE_URL: 'unexpected'}}, {environment_variables: {extra: 'unexpected'}},
    {scaling_option: {concurrent_requests_threshold: 80}}]) {
    assert.throws(() => assertContainer({...container(), ...override}, config))
  }
})
