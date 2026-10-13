import assert from 'node:assert/strict'
import {pathToFileURL} from 'node:url'

const endpoint = 'rg.fr-par.scw.cloud/prelevements-deau-api'
const imageName = 'prelevements-deau-api'
const projectId = '8b2f67a8-b474-4596-967f-fe1e0adba1b3'

export async function checkPrivateRegistry(environment, fetchRequest = fetch) {
  assert.equal(environment.SCW_REGION, 'fr-par')
  assert.equal(environment.SCW_DEFAULT_PROJECT_ID, projectId)
  assert.equal(environment.SCW_REGISTRY_ENDPOINT, endpoint)
  assert.equal(environment.SCW_IMAGE_NAME, imageName)
  assert.ok(environment.SCW_SECRET_KEY)
  const get = async (resource, params) => {
    const url = new URL(`https://api.scaleway.com/registry/v1/regions/fr-par/${resource}`)
    url.search = new URLSearchParams({...params, page_size: '100'})
    const response = await fetchRequest(url, {headers: {'X-Auth-Token': environment.SCW_SECRET_KEY}, redirect: 'error', signal: AbortSignal.timeout(30_000)})
    assert.equal(response.status, 200, 'Private registry verification failed')
    return response.json()
  }
  const namespaces = await get('namespaces', {project_id: projectId, name: imageName})
  assert.equal(namespaces.total_count, 1, 'Ambiguous registry namespace')
  assert.equal(namespaces.namespaces?.length, 1)
  const namespace = namespaces.namespaces[0]
  assert.equal(namespace.project_id, projectId)
  assert.equal(namespace.name, imageName)
  assert.equal(namespace.endpoint, endpoint)
  assert.equal(namespace.region, 'fr-par')
  assert.equal(namespace.status, 'ready')
  assert.equal(namespace.is_public, false, 'Private data must never be cached in a public namespace')
  assert.match(namespace.id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
  const images = await get('images', {namespace_id: namespace.id, name: imageName})
  // This delivery targets the existing API repository; never create another repository by typo.
  assert.equal(images.total_count, 1)
  assert.equal(images.images?.length, 1)
  assert.equal(images.images[0].namespace_id, namespace.id)
  assert.equal(images.images[0].name, imageName)
  assert.equal(images.images[0].status, 'ready')
  assert.ok(['private', 'inherit'].includes(images.images[0].visibility), 'API image visibility must remain private')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await checkPrivateRegistry(process.env)
    console.log('Private API registry verified for image and environment-scoped cache.')
  } catch {
    console.error('Private registry verification failed; no image/cache push is permitted.')
    process.exitCode = 1
  }
}
