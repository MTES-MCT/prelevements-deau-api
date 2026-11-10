/* eslint-disable no-await-in-loop -- Control-plane retries and deployment polling must remain sequential. */
import assert from 'node:assert/strict'
import {appendFile, mkdir, writeFile} from 'node:fs/promises'
import {setTimeout as sleep} from 'node:timers/promises'
import {pathToFileURL} from 'node:url'
import {readConfiguration, expectedSettings, assertNamespace, assertContainer, PROJECT_ID} from './configuration.mjs'

const origin = 'https://api.scaleway.com/containers/v1/regions/fr-par'

export async function deployAntivirus(config, {fetchRequest = fetch, wait = sleep, proofDirectory = '.artifacts/antivirus'} = {}) {
  const request = async (method, path, body) => {
    const attempts = method === 'GET' ? 4 : 1
    for (let attempt = 0; attempt < attempts; attempt++) {
      let response
      try {
        response = await fetchRequest(`${origin}${path}`, {method,
          headers: {'X-Auth-Token': config.credential, 'Content-Type': 'application/json'},
          ...(body === undefined ? {} : {body: JSON.stringify(body)}), redirect: 'error', signal: AbortSignal.timeout(30000)})
      } catch {
        if (attempt + 1 < attempts) { await wait(3000); continue }
        throw new Error(`${method} ${path}: network error; no automatic write retry`)
      }
      if (!response.ok) {
        await response.body?.cancel()
        if ([429, 500, 502, 503, 504].includes(response.status) && attempt + 1 < attempts) { await wait(3000); continue }
        throw new Error(`${method} ${path}: HTTP ${response.status}; response body withheld`)
      }
      return response.status === 204 ? null : response.json()
    }
    throw new Error('Antivirus request did not complete')
  }

  const namespace = await request('GET', `/namespaces/${config.namespaceId}`)
  assertNamespace(namespace, config)
  const listing = await request('GET', `/containers?namespace_id=${config.namespaceId}&page_size=100`)
  assert.equal(listing.total_count, listing.containers.length)
  assert(listing.containers.length <= 1, 'Dedicated antivirus namespace contains unexpected resources')
  let before = listing.containers[0]
  let candidate
  if (before) {
    assertContainer(before, config)
    assert.equal(before.status, 'ready', 'Resolve previous scanner deployment before continuing')
    candidate = await request('PATCH', `/containers/${before.id}`, {image: config.image})
  } else {
    candidate = await request('POST', '/containers', {...expectedSettings(config), image: config.image,
      description: 'On-demand antivirus for new uploads only; authenticated private endpoint'})
  }
  assert(candidate.id && candidate.name === config.containerName)
  const operation = {environment: config.environment, containerId: candidate.id, namespaceId: config.namespaceId,
    created: !before, previousImage: before?.image ?? null, image: config.image, startedAt: new Date().toISOString()}
  await mkdir(proofDirectory, {recursive: true})
  const proofPath = `${proofDirectory}/${config.environment}-deployment.json`
  await writeFile(proofPath, JSON.stringify(operation, null, 2))
  // v1 create/PATCH deploys automatically. There is no v1 /deploy operation.
  // After a lost response, inspect the existing resource before starting a new run.
  let current
  for (let attempt = 0; attempt < 90; attempt++) {
    current = await request('GET', `/containers/${candidate.id}`)
    assert(!['error', 'locked', 'deleting'].includes(current.status), 'Scanner deployment failed; retain previous application configuration')
    if (current.status === 'ready' && current.image === config.image) break
    await wait(5000)
  }
  assert.equal(current.status, 'ready', 'Scanner deployment deadline exceeded')
  assert.equal(current.image, config.image)
  assertContainer(current, config)
  const namespaceAfter = await request('GET', `/namespaces/${config.namespaceId}`)
  assertNamespace(namespaceAfter, config)
  assert.deepEqual(namespaceAfter.secret_environment_variables, namespace.secret_environment_variables,
    'Scanner namespace secrets changed during deployment')
  if (current.public_endpoint) {
    const publicResponse = await fetchRequest(`${current.public_endpoint.replace(/\/$/, '')}/scan`, {
      redirect: 'error', signal: AbortSignal.timeout(30000)})
    await publicResponse.body?.cancel()
    assert.equal(publicResponse.status, 404, 'Scanner default public endpoint must be inaccessible')
  }
  Object.assign(operation, {ready: true, privateEndpoint: current.private_endpoint,
    publicEndpointDisabled: true, minScale: 0, maxScale: 1, completedAt: new Date().toISOString()})
  await writeFile(proofPath, JSON.stringify(operation, null, 2))
  return operation
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const proof = await deployAntivirus(readConfiguration())
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `Antivirus ${proof.environment}: immutable image ready, public endpoint disabled, scale 0–1. Existing applications and secrets untouched.\n`)
    console.log(JSON.stringify({environment: proof.environment, ready: true, project: PROJECT_ID, publicEndpointDisabled: true}))
  } catch (error) {
    console.error(`Antivirus deployment blocked: ${error.message}`)
    process.exitCode = 1
  }
}
