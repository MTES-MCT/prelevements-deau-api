import assert from 'node:assert/strict'
import {PROJECT_ID, REGISTRY} from './configuration.mjs'

assert.equal(process.env.SCW_DEFAULT_PROJECT_ID, PROJECT_ID)
assert(process.env.SCW_SECRET_KEY)
const response = await fetch(`https://api.scaleway.com/registry/v1/regions/fr-par/namespaces?project_id=${PROJECT_ID}&name=prelevements-deau-api&page_size=100`, {
  headers: {'X-Auth-Token': process.env.SCW_SECRET_KEY}, redirect: 'error', signal: AbortSignal.timeout(30000)
})
assert.equal(response.status, 200, 'Unable to verify antivirus private registry')
const result = await response.json()
assert.equal(result.total_count, 1)
assert.equal(result.namespaces.length, 1)
const namespace = result.namespaces[0]
assert.equal(namespace.project_id, PROJECT_ID)
assert.equal(namespace.endpoint, REGISTRY)
assert.equal(namespace.name, 'prelevements-deau-api')
assert.equal(namespace.is_public, false)
assert.equal(namespace.status, 'ready')
console.log('Antivirus image registry is private and belongs to the expected project.')
