import assert from 'node:assert/strict'
import {setTimeout as sleep} from 'node:timers/promises'

// The fixed wrappers own environment identities and exceptional historical settings.
// This shared path keeps read retries, write-once operations and secret preservation aligned.
export function createEnvironmentDeployment({
  environmentName,
  resources,
  migrationCommand,
  apiName,
  workerName,
  apiPatch = {},
  workerPatch = {}
}) {
  const SHA = /^[\da-f]{40}$/
  const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/
  const API = 'https://api.scaleway.com/containers/v1/regions/fr-par'
  const READ_ATTEMPTS = 6
  const TRANSIENT_HTTP_STATUSES = new Set([502, 503, 504])
  const TRANSIENT_NETWORK_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPIPE',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET'
  ])

  function isTransientNetworkError(error) {
    return error?.name === 'TimeoutError'
      || TRANSIENT_NETWORK_CODES.has(error?.code ?? error?.cause?.code)
  }

  function requireCondition(condition, message) {
    if (!condition) {
      throw new Error(message)
    }
  }

  function equal(actual, expected) {
    try {
      assert.deepEqual(actual, expected)
      return true
    } catch {
      return false
    }
  }

  function readConfiguration(environment) {
    requireCondition(UUID.test(resources.privateNetworkId ?? '') && UUID.test(resources.vpcId ?? ''), `Cible réseau ${environmentName} non configurée : aucune écriture autorisée.`)
    requireCondition(environment.SCW_DEFAULT_PROJECT_ID === resources.projectId, 'Projet Scaleway différent du projet PE attendu.')
    requireCondition(environment.SCW_REGION === 'fr-par', `La région ${environmentName} doit être fr-par.`)
    requireCondition(environment.GITHUB_REF === `refs/heads/${environmentName}`, `Seule la branche ${environmentName} peut exécuter ce déploiement.`)
    requireCondition(SHA.test(environment.GITHUB_SHA ?? ''), 'La release doit être un SHA Git complet.')
    requireCondition(environment.IMAGE_REF?.startsWith(`${resources.registry}@sha256:`)
      && /^[\da-f]{64}$/.test(environment.IMAGE_REF.slice(`${resources.registry}@sha256:`.length)), 'Une image immuable du registre API PE est obligatoire.')
    requireCondition(environment[`SCW_SERVERLESS_CONTAINER_ID_${environmentName.toUpperCase()}_API`] === resources.apiId
      && environment[`SCW_SERVERLESS_CONTAINER_ID_${environmentName.toUpperCase()}_WORKER`] === resources.workerId, `Les identifiants API/worker ne correspondent pas à ${environmentName}.`)
    requireCondition(UUID.test(environment[`SCW_${environmentName.toUpperCase()}_MIGRATION_CONTAINER_ID`] ?? '')
      && UUID.test(environment[`SCW_${environmentName.toUpperCase()}_MIGRATION_NAMESPACE_ID`] ?? ''), `Identifiants du service de migration ${environmentName} manquants.`)
    requireCondition(environment.SCW_SECRET_KEY?.length > 0, 'Clé CI Scaleway manquante.')
    requireCondition(environment[`${environmentName.toUpperCase()}_MIGRATION_INVOKE_SECRET`]?.length >= 32, `Secret d’invocation ${environmentName} absent ou trop court.`)
    return {
      release: environment.GITHUB_SHA,
      image: environment.IMAGE_REF,
      key: environment.SCW_SECRET_KEY,
      migrationSecret: environment[`${environmentName.toUpperCase()}_MIGRATION_INVOKE_SECRET`],
      migrationId: environment[`SCW_${environmentName.toUpperCase()}_MIGRATION_CONTAINER_ID`],
      migrationNamespaceId: environment[`SCW_${environmentName.toUpperCase()}_MIGRATION_NAMESPACE_ID`]
    }
  }

  function assertNamespace(namespace, id, name) {
    requireCondition(namespace.id === id && namespace.name === name
      && namespace.project_id === resources.projectId && namespace.region === 'fr-par', `Namespace ${environmentName} inattendu : déploiement interrompu.`)
  }

  function secretKeys(resource) {
    return Object.keys(resource.secret_environment_variables ?? {}).sort()
  }

  function runtimeSettings(resource) {
    const fields = ['command',
      'args',
      'port',
      'privacy',
      'protocol',
      'https_connections_only',
      'min_scale',
      'max_scale',
      'memory_limit_bytes',
      'mvcpu_limit',
      'local_storage_limit_bytes',
      'timeout',
      'sandbox',
      'scaling_option',
      'liveness_probe',
      'startup_probe',
      'private_network_id']
    return Object.fromEntries(fields.map(field => [field, resource[field]]))
  }

  function assertContainer(container, {id, name, namespaceId, privacy}) {
    requireCondition(container.id === id && container.name === name && container.namespace_id === namespaceId
      && container.region === 'fr-par' && container.private_network_id === resources.privateNetworkId
      && container.privacy === privacy, `Identité, réseau ou confidentialité du conteneur ${environmentName} inattendus.`)
  }

  function endpoint(container) {
    const raw = container.public_endpoint ?? ''
    const url = new URL(raw.startsWith('https://') ? raw : `https://${raw}`)
    requireCondition(url.protocol === 'https:' && /\.(?:containers|functions)\.fnc\.fr-par\.scw\.cloud$/.test(url.hostname)
      && !url.username && !url.password && !url.port && url.pathname === '/' && !url.search && !url.hash,
    'Endpoint Scaleway non conforme : aucune clé ne sera transmise.')
    return url.origin
  }

  function assertRelease(status, release) {
    requireCondition(status.release === release, 'Le service de migration ne sert pas la release attendue.')
  }

  function assertLedger(database, requireComplete = false) {
    requireCondition(database && Array.isArray(database.pending) && Array.isArray(database.unfinished)
      && database.unfinished.length === 0 && (!requireComplete || database.pending.length === 0),
    'État des migrations PostgreSQL incomplet ou non vérifiable.')
  }

  function assertMigrationSuccess(result, release) {
    assertRelease(result, release)
    requireCondition(result.state === 'succeeded' && result.operation?.state === 'succeeded'
      && result.operation.release === release && UUID.test(result.operation.id ?? '')
      && result.operation.exitCode === 0, 'La migration n’a pas confirmé sa réussite.')
    assertLedger(result.operation.database, true)
  }

  async function deploy(configuration, {fetch: fetchRequest = globalThis.fetch, wait = sleep, log = console.log} = {}) {
    const {release, image, key, migrationSecret, migrationId, migrationNamespaceId} = configuration
    const headers = {'X-Auth-Token': key}
    const definitions = [
      {id: resources.apiId, name: apiName, namespaceId: resources.namespaceId, privacy: 'public'},
      {id: resources.workerId, name: workerName, namespaceId: resources.namespaceId, privacy: 'public'},
      {id: migrationId, name: resources.migrationName, namespaceId: migrationNamespaceId, privacy: 'private'}
    ]

    async function jsonRequest(url, options = {}, timeout = 30_000) {
      const method = options.method ?? 'GET'
      const label = `${method} ${new URL(url).pathname}`
      const attempts = method === 'GET' ? READ_ATTEMPTS : 1
      for (let attempt = 0; attempt < attempts; attempt++) {
        let response
        try {
          // eslint-disable-next-line no-await-in-loop
          response = await fetchRequest(url, {...options, redirect: 'error', signal: AbortSignal.timeout(timeout)})
        } catch (error) {
          if (attempt + 1 < attempts && isTransientNetworkError(error)) {
            // eslint-disable-next-line no-await-in-loop
            await wait(5000)
            continue
          }

          // eslint-disable-next-line preserve-caught-error -- Never attach a raw network cause that may contain credentials.
          throw new Error(`Réponse réseau absente pour ${label} ; déploiement interrompu, aucune répétition d’écriture.`)
        }

        if (!response.ok) {
          // Never consume or log error bodies, which may contain sensitive data.
          try {
            // eslint-disable-next-line no-await-in-loop
            await response.body?.cancel()
          } catch {
            // A failed body cancellation must not hide the original HTTP status.
          }

          if (attempt + 1 < attempts && TRANSIENT_HTTP_STATUSES.has(response.status)) {
            // eslint-disable-next-line no-await-in-loop
            await wait(5000)
            continue
          }

          throw new Error(`Requête ${label} refusée (HTTP ${response.status}), déploiement interrompu.`)
        }

        try {
          // eslint-disable-next-line no-await-in-loop
          return await response.json()
        } catch {
          throw new Error(`Réponse JSON invalide pour ${label} ; déploiement interrompu.`)
        }
      }

      throw new Error(`Lecture ${label} indisponible après ${attempts} tentatives.`)
    }

    const getContainer = id => jsonRequest(`${API}/containers/${id}`, {headers})
    const getNamespace = id => jsonRequest(`${API}/namespaces/${id}`, {headers})
    const patchContainer = (id, body) => jsonRequest(`${API}/containers/${id}`, {
      method: 'PATCH', headers: {...headers, 'Content-Type': 'application/json'}, body: JSON.stringify(body)
    })

    const [namespace, migrationNamespace, privateNetwork, ...before] = await Promise.all([
      getNamespace(resources.namespaceId),
      getNamespace(migrationNamespaceId),
      jsonRequest(`https://api.scaleway.com/vpc/v2/regions/fr-par/private-networks/${resources.privateNetworkId}`, {headers}),
      ...definitions.map(definition => getContainer(definition.id))
    ])
    assertNamespace(namespace, resources.namespaceId, resources.namespaceName)
    assertNamespace(migrationNamespace, migrationNamespaceId, resources.migrationNamespaceName)
    requireCondition(privateNetwork.id === resources.privateNetworkId && privateNetwork.project_id === resources.projectId
      && privateNetwork.vpc_id === resources.vpcId, `Le Private Network ne correspond pas à ${environmentName}.`)
    for (const [index, container] of before.entries()) {
      assertContainer(container, definitions[index])
      requireCondition(container.status === 'ready', `Un conteneur ${environmentName} n’est pas prêt avant déploiement.`)
    }

    const migrationBefore = before[2]
    requireCondition(migrationBefore.max_scale === 1 && migrationBefore.min_scale <= 1
      && migrationBefore.port === 8080 && Number.parseFloat(migrationBefore.timeout) >= 1200
      && equal(migrationBefore.command, migrationCommand) && equal(migrationBefore.args ?? [], [])
      && migrationBefore.environment_variables?.APP_ENV === environmentName, `Configuration du service de migration ${environmentName} incorrecte.`)
    requireCondition(SHA.test(migrationBefore.environment_variables?.MIGRATION_RELEASE_SHA ?? ''), 'Release initiale du service de migration invalide.')
    const availableSecrets = new Set([...secretKeys(migrationNamespace), ...secretKeys(migrationBefore)])
    requireCondition(availableSecrets.has('DATABASE_URL') && availableSecrets.has('MIGRATION_INVOKE_SECRET'), 'Secrets du service de migration absents.')
    const migrationEndpoint = endpoint(migrationBefore)
    const invokeHeaders = {...headers, 'X-Migration-Secret': migrationSecret}
    const getStatus = () => jsonRequest(`${migrationEndpoint}/status`, {headers: invokeHeaders}, 45_000)

    // This proves privacy and the actual GitHub credential before changing any image.
    const anonymous = await fetchRequest(`${migrationEndpoint}/healthz`, {redirect: 'error', signal: AbortSignal.timeout(30_000)})
    requireCondition([401, 403].includes(anonymous.status), 'Le service de migration est accessible sans IAM ou sa confidentialité est indéterminée.')
    await anonymous.body?.cancel()
    const health = await jsonRequest(`${migrationEndpoint}/healthz`, {headers: invokeHeaders}, 45_000)
    requireCondition(health.ok === true, 'Le service de migration ne répond pas à la sonde CI authentifiée.')
    assertRelease(health, migrationBefore.environment_variables.MIGRATION_RELEASE_SHA)
    const initialStatus = await getStatus()
    assertRelease(initialStatus, health.release)
    requireCondition(['idle', 'succeeded'].includes(initialStatus.state), 'Une migration précédente doit être résolue avant tout redéploiement.')
    assertLedger(initialStatus.database)

    async function waitReady(definition, expectedEnvironment, allowedPatch = {}) {
      for (let attempt = 0; attempt < 120; attempt++) {
        // eslint-disable-next-line no-await-in-loop
        const current = await getContainer(definition.id)
        assertContainer(current, definition)
        requireCondition(!['error', 'locked', 'deleting'].includes(current.status), `Scaleway signale un échec de déploiement ${environmentName}.`)
        if (current.status === 'ready' && current.image === image) {
          requireCondition(equal(current.environment_variables ?? {}, expectedEnvironment), 'Les variables ordinaires ont changé de manière inattendue.')
          const original = before.find(container => container.id === definition.id)
          requireCondition(equal(secretKeys(current), secretKeys(original)), 'La liste des secrets a changé de manière inattendue.')
          requireCondition(equal(runtimeSettings(current), runtimeSettings({...original, ...allowedPatch})),
            'La configuration du conteneur a changé de manière inattendue.')
          return current
        }

        // Only read operations are retried; a PATCH or POST is never repeated.
        // eslint-disable-next-line no-await-in-loop
        await wait(5000)
      }

      throw new Error(`Le conteneur ${environmentName} n’a pas confirmé sa disponibilité dans les dix minutes.`)
    }

    const migrationCurrent = await getContainer(migrationId)
    requireCondition(migrationCurrent.image === migrationBefore.image
      && equal(migrationCurrent.environment_variables, migrationBefore.environment_variables)
      && equal(secretKeys(migrationCurrent), secretKeys(migrationBefore))
      && equal(runtimeSettings(migrationCurrent), runtimeSettings(migrationBefore)),
    'Configuration migration modifiée pendant les contrôles ; déploiement interrompu.')

    const migrationEnvironment = {...migrationBefore.environment_variables, MIGRATION_RELEASE_SHA: release}
    // No secret map is sent: write-only secret values cannot safely be reconstructed.
    await patchContainer(migrationId, {image, environment_variables: migrationEnvironment})
    await waitReady(definitions[2], migrationEnvironment)
    let refreshedHealth
    for (let attempt = 0; attempt < 60; attempt++) {
      // eslint-disable-next-line no-await-in-loop
      refreshedHealth = await jsonRequest(`${migrationEndpoint}/healthz`, {headers: invokeHeaders}, 45_000)
      if (refreshedHealth.ok === true && refreshedHealth.release === release) {
        break
      }

      // eslint-disable-next-line no-await-in-loop
      await wait(5000)
    }

    assertRelease(refreshedHealth, release)
    const readyStatus = await getStatus()
    assertRelease(readyStatus, release)
    requireCondition(['idle', 'succeeded'].includes(readyStatus.state), 'Le service de migration est occupé ou dans un état non résolu.')
    assertLedger(readyStatus.database)

    let migrated
    try {
      migrated = await jsonRequest(`${migrationEndpoint}/migrate`, {
        method: 'POST', headers: {...invokeHeaders, 'Content-Type': 'application/json'}, body: JSON.stringify({expectedRelease: release})
      }, 1_210_000)
    } catch {
      // A lost HTTP response does not authorize another Prisma invocation.
      const recovered = await getStatus()
      requireCondition(recovered.operation?.id && recovered.operation.id !== readyStatus.operation?.id,
        'Réponse de migration perdue et opération non identifiable : intervention requise, aucun redéploiement.')
      assertMigrationSuccess(recovered, release)
      migrated = recovered
    }

    assertMigrationSuccess(migrated, release)
    const verified = await getStatus()
    assertMigrationSuccess(verified, release)
    assertLedger(verified.database, true)
    requireCondition(verified.operation.id === migrated.operation.id, 'L’opération de migration a changé pendant sa vérification.')

    // Detect concurrent changes before touching either business container.
    const freshBusiness = await Promise.all(definitions.slice(0, 2).map(definition => getContainer(definition.id)))
    for (const [index, current] of freshBusiness.entries()) {
      assertContainer(current, definitions[index])
      requireCondition(current.status === 'ready' && current.image === before[index].image
        && equal(current.environment_variables, before[index].environment_variables)
        && equal(runtimeSettings(current), runtimeSettings(before[index]))
        && equal(secretKeys(current), secretKeys(before[index])), 'Configuration métier modifiée pendant les migrations ; déploiement interrompu.')
    }

    await patchContainer(resources.apiId, {image, ...apiPatch})
    const api = await waitReady(definitions[0], before[0].environment_variables ?? {}, apiPatch)
    await patchContainer(resources.workerId, {image, ...workerPatch})
    const worker = await waitReady(definitions[1], before[1].environment_variables ?? {}, workerPatch)
    const apiHealth = await jsonRequest(`${endpoint(api)}/healthz`)
    requireCondition(apiHealth.ok === true, `La sonde API ${environmentName} a échoué après le déploiement.`)
    let workerHealthy = false
    for (let attempt = 0; attempt < 24; attempt++) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const response = await fetchRequest(`${endpoint(worker)}/health`, {redirect: 'error', signal: AbortSignal.timeout(15_000)})
        // eslint-disable-next-line no-await-in-loop
        await response.body?.cancel()
        if (response.status === 200) {
          workerHealthy = true
          break
        }
      } catch {
        // Never log response bodies or network causes.
      }

      if (attempt < 23) {
        // eslint-disable-next-line no-await-in-loop
        await wait(5000)
      }
    }

    requireCondition(workerHealthy, `La sonde worker ${environmentName} a échoué après le déploiement.`)
    const namespaceAfter = await getNamespace(resources.namespaceId)
    const migrationNamespaceAfter = await getNamespace(migrationNamespaceId)
    for (const [original, current] of [[namespace, namespaceAfter], [migrationNamespace, migrationNamespaceAfter]]) {
      requireCondition(equal(original.environment_variables, current.environment_variables)
        && equal(secretKeys(original), secretKeys(current)), 'Une configuration de namespace a changé pendant le déploiement.')
    }

    const result = {environment: environmentName, release, image, migrationOperationId: verified.operation.id, containers: [api.id, worker.id, migrationId]}
    log(JSON.stringify(result))
    return result
  }

  return {readConfiguration, deploy}
}
