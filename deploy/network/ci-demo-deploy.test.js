import test from 'ava'
import {readFile} from 'node:fs/promises'
import {DEMO, deployDemo, readDemoConfiguration} from './ci-demo-deploy.js'

test('le nom de l’exécuteur respecte la limite Scaleway sans changer le namespace', t => {
  t.is(DEMO.migrationName, 'demo-api-migrations')
  t.true(DEMO.migrationName.length <= 34)
  t.is(DEMO.migrationNamespaceName, 'demo-partageons-leau-migrations')
})

const MIGRATION_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const MIGRATION_NAMESPACE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const OLD_RELEASE = '1'.repeat(40)
const RELEASE = '2'.repeat(40)
const IMAGE = `${DEMO.registry}@sha256:${'3'.repeat(64)}`
const OPERATION_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const AUTH = 'test-scaleway-key'
const INVOKE_SECRET = 's'.repeat(32)
const configuration = () => readDemoConfiguration({
  GITHUB_REF: 'refs/heads/demo', GITHUB_SHA: RELEASE, IMAGE_REF: IMAGE,
  SCW_REGION: 'fr-par', SCW_DEFAULT_PROJECT_ID: DEMO.projectId,
  SCW_SERVERLESS_CONTAINER_ID_DEMO_API: DEMO.apiId,
  SCW_SERVERLESS_CONTAINER_ID_DEMO_WORKER: DEMO.workerId,
  SCW_DEMO_MIGRATION_CONTAINER_ID: MIGRATION_ID,
  SCW_DEMO_MIGRATION_NAMESPACE_ID: MIGRATION_NAMESPACE_ID,
  SCW_SECRET_KEY: AUTH, DEMO_MIGRATION_INVOKE_SECRET: INVOKE_SECRET
})

function fixture(options = {}) {
  const namespace = (id, name) => ({
    id, name, region: 'fr-par', project_id: DEMO.projectId,
    environment_variables: {KEEP_NAMESPACE: 'unchanged'}, secret_environment_variables: {}
  })
  const namespaces = {
    [DEMO.namespaceId]: namespace(DEMO.namespaceId, DEMO.namespaceName),
    [MIGRATION_NAMESPACE_ID]: namespace(MIGRATION_NAMESPACE_ID, DEMO.migrationNamespaceName)
  }
  const container = (id, name, namespaceId) => ({
    id, name, namespace_id: namespaceId, region: 'fr-par',
    private_network_id: DEMO.privateNetworkId, privacy: 'public', status: 'ready',
    image: `${DEMO.registry}:demo-${OLD_RELEASE}`,
    public_endpoint: `${id}.containers.fnc.fr-par.scw.cloud`,
    environment_variables: {KEEP_CONTAINER: 'unchanged'}, secret_environment_variables: {EXISTING_SECRET: 'redacted'}
  })
  const containers = {
    [DEMO.apiId]: container(DEMO.apiId, 'demo-prelevement-deau-api', DEMO.namespaceId),
    [DEMO.workerId]: container(DEMO.workerId, 'demo-prelevement-deau-api-worker', DEMO.namespaceId),
    [MIGRATION_ID]: {
      ...container(MIGRATION_ID, DEMO.migrationName, MIGRATION_NAMESPACE_ID),
      privacy: 'private', min_scale: 0, max_scale: 1, port: 8080, timeout: '1200s',
      command: ['node', 'scripts/network/migration-service.js'], args: [],
      environment_variables: {APP_ENV: 'demo', MIGRATION_RELEASE_SHA: OLD_RELEASE, KEEP_CONTAINER: 'unchanged'},
      secret_environment_variables: {DATABASE_URL: 'redacted', MIGRATION_INVOKE_SECRET: 'redacted'}
    }
  }
  const ledger = () => ({pending: [], unfinished: options.unfinished ? ['failed.sql'] : []})
  let operation = null
  const migrationStatus = () => ({
    release: containers[MIGRATION_ID].environment_variables.MIGRATION_RELEASE_SHA,
    state: operation?.state ?? 'idle', operation, database: ledger()
  })
  const calls = []
  const json = (value, status = 200) => Response.json(value, {status})

  const fetch = async (input, request = {}) => {
    const url = new URL(input)
    const method = request.method ?? 'GET'
    const body = request.body ? JSON.parse(request.body) : undefined
    calls.push({url: url.href, method, body, headers: request.headers})
    if (url.hostname === 'api.scaleway.com') {
      if (request.headers?.['X-Auth-Token'] !== AUTH) {
        return json({}, 403)
      }

      const id = url.pathname.split('/').at(-1)
      if (url.pathname.includes('/private-networks/')) {
        return json({id: DEMO.privateNetworkId, project_id: DEMO.projectId, vpc_id: DEMO.vpcId})
      }

      if (url.pathname.includes('/namespaces/')) {
        return json(namespaces[id])
      }

      if (method === 'PATCH') {
        if (id === MIGRATION_ID && options.patchFailure) {
          return json({detail: INVOKE_SECRET}, 503)
        }

        Object.assign(containers[id], body)
        if (id === MIGRATION_ID && options.secretDrift) {
          containers[id].secret_environment_variables.UNEXPECTED = 'redacted'
        }

        if (id === MIGRATION_ID && options.businessDrift) {
          containers[DEMO.apiId].environment_variables.KEEP_CONTAINER = 'modified concurrently'
        }

        if (id === MIGRATION_ID && options.environmentLost) {
          delete containers[MIGRATION_ID].environment_variables.KEEP_CONTAINER
        }

        if (id === DEMO.workerId && options.settingsDrift) {
          containers[DEMO.workerId].max_scale = 999
        }
      }

      return json(containers[id])
    }

    if (url.hostname === `${MIGRATION_ID}.containers.fnc.fr-par.scw.cloud`) {
      if (request.headers?.['X-Auth-Token'] !== AUTH || options.ciDenied) {
        return json({}, 403)
      }

      if (url.pathname === '/healthz') {
        if (containers[MIGRATION_ID].environment_variables.MIGRATION_RELEASE_SHA === RELEASE && options.readFailures?.length) {
          const failure = options.readFailures.shift()
          if (failure instanceof Error) {
            throw failure
          }

          if (failure === 'invalid-json') {
            return new Response(INVOKE_SECRET, {status: 200})
          }

          return json({detail: INVOKE_SECRET}, failure)
        }

        return json({ok: true, release: containers[MIGRATION_ID].environment_variables.MIGRATION_RELEASE_SHA})
      }

      if (request.headers?.['X-Migration-Secret'] !== INVOKE_SECRET) {
        return json({}, 403)
      }

      if (url.pathname === '/status') {
        if (options.wrongRelease && containers[MIGRATION_ID].environment_variables.MIGRATION_RELEASE_SHA === RELEASE) {
          return json({...migrationStatus(), release: OLD_RELEASE})
        }

        return json(migrationStatus())
      }

      if (url.pathname === '/migrate') {
        if (options.postFailure) {
          return json({detail: INVOKE_SECRET}, 503)
        }

        if (options.lostResponse === 'before') {
          throw new Error('Simulated lost response')
        }

        operation = {
          id: OPERATION_ID, release: RELEASE,
          state: options.migrationFailure ? 'failed' : (options.lostResponse === 'running' ? 'running' : 'succeeded'),
          exitCode: options.migrationFailure ? 1 : 0, database: ledger()
        }
        if (options.lostResponse) {
          throw new Error('Simulated lost response')
        }

        return json(migrationStatus(), options.migrationFailure ? 503 : 200)
      }
    }

    if (options.workerUnhealthy && url.pathname === '/health') {
      return json({}, 503)
    }

    return json({ok: true})
  }

  return {fetch, calls, namespaces, containers, async wait() {}, log() {}}
}

test('la configuration refuse branche, cible ou image non demo', t => {
  t.is(configuration().image, IMAGE)
  const env = {
    GITHUB_REF: 'refs/heads/prod', GITHUB_SHA: RELEASE, IMAGE_REF: IMAGE,
    SCW_REGION: 'fr-par', SCW_DEFAULT_PROJECT_ID: DEMO.projectId
  }
  t.throws(() => readDemoConfiguration(env), {message: /branche demo/})
  t.throws(() => readDemoConfiguration({...env, SCW_DEFAULT_PROJECT_ID: 'another-project'}), {message: /Projet Scaleway/})
  t.throws(() => readDemoConfiguration({...env, GITHUB_REF: 'refs/heads/demo', IMAGE_REF: `${DEMO.registry}:demo-latest`}), {message: /image immuable/})
})

test('migration puis API et worker utilisent le même digest sans réécrire les secrets', async t => {
  const fake = fixture()
  const result = await deployDemo(configuration(), fake)
  const patches = fake.calls.filter(call => call.method === 'PATCH')
  t.deepEqual(patches.map(call => call.url.split('/').at(-1)), [MIGRATION_ID, DEMO.apiId, DEMO.workerId])
  t.true(patches.every(call => call.body.image === IMAGE))
  t.true(patches.every(call => !Object.hasOwn(call.body, 'secret_environment_variables')))
  t.deepEqual(patches[0].body.environment_variables, {
    APP_ENV: 'demo', KEEP_CONTAINER: 'unchanged', MIGRATION_RELEASE_SHA: RELEASE
  })
  t.true(patches.slice(1).every(call => !Object.hasOwn(call.body, 'environment_variables')))
  t.true(patches.slice(1).every(call => Object.keys(call.body).length === 1))
  const posts = fake.calls.filter(call => call.method === 'POST')
  t.is(posts.length, 1)
  t.deepEqual(posts[0].body, {expectedRelease: RELEASE})
  t.is(posts[0].headers['X-Auth-Token'], AUTH)
  t.is(posts[0].headers['X-Migration-Secret'], INVOKE_SECRET)
  t.is(result.migrationOperationId, OPERATION_ID)
})

for (const status of [502, 503, 504]) {
  test(`un GET ${status} après redéploiement migration est retenté sans répéter les écritures`, async t => {
    const fake = fixture({readFailures: [status]})
    const waits = []
    await deployDemo(configuration(), {...fake, async wait(duration) {
      waits.push(duration)
    }})

    t.deepEqual(waits, [5000])
    t.is(fake.calls.filter(call => call.method === 'POST').length, 1)
    t.deepEqual(fake.calls.filter(call => call.method === 'PATCH').map(call => call.url.split('/').at(-1)), [MIGRATION_ID, DEMO.apiId, DEMO.workerId])
  })
}

test('les erreurs réseau transitoires d’un GET peuvent être retentées', async t => {
  const reset = new TypeError('fetch failed', {cause: Object.assign(new Error(INVOKE_SECRET), {code: 'ECONNRESET'})})
  const timeout = new DOMException(INVOKE_SECRET, 'TimeoutError')
  const fake = fixture({readFailures: [reset, timeout]})
  const waits = []
  await deployDemo(configuration(), {...fake, async wait(duration) {
    waits.push(duration)
  }})

  t.deepEqual(waits, [5000, 5000])
  t.is(fake.calls.filter(call => call.method === 'POST').length, 1)
})

test('une lecture 503 persistante est bornée et bloque avant tout déploiement métier', async t => {
  const fake = fixture({readFailures: Array.from({length: 6}, () => 503)})
  const waits = []
  const error = await t.throwsAsync(deployDemo(configuration(), {...fake, async wait(duration) {
    waits.push(duration)
  }}), {message: /GET \/healthz refusée \(HTTP 503\)/})

  t.is(waits.length, 5)
  t.false(error.message.includes(INVOKE_SECRET))
  t.is(fake.calls.filter(call => call.url.endsWith('/healthz') && call.headers?.['X-Auth-Token'] === AUTH).length, 7)
  t.false(fake.calls.some(call => call.method === 'POST'))
  t.deepEqual(fake.calls.filter(call => call.method === 'PATCH').map(call => call.url.split('/').at(-1)), [MIGRATION_ID])
})

for (const status of [401, 403]) {
  test(`un GET ${status} ne peut pas être retenté`, async t => {
    const fake = fixture({readFailures: [status]})
    const waits = []
    const error = await t.throwsAsync(deployDemo(configuration(), {...fake, async wait(duration) {
      waits.push(duration)
    }}), {message: new RegExp(`GET /healthz refusée \\(HTTP ${status}\\)`)})

    t.deepEqual(waits, [])
    t.false(error.message.includes(INVOKE_SECRET))
    t.false(fake.calls.some(call => call.method === 'POST'))
  })
}

test('un JSON invalide n’est pas retenté et son contenu reste masqué', async t => {
  const fake = fixture({readFailures: ['invalid-json']})
  const waits = []
  const error = await t.throwsAsync(deployDemo(configuration(), {...fake, async wait(duration) {
    waits.push(duration)
  }}), {message: /JSON invalide pour GET \/healthz/})

  t.deepEqual(waits, [])
  t.false(error.message.includes(INVOKE_SECRET))
  t.false(fake.calls.some(call => call.method === 'POST'))
})

test('une erreur TLS non transitoire échoue sans retry ni détails sensibles', async t => {
  const tlsError = new TypeError('fetch failed', {cause: Object.assign(new Error(INVOKE_SECRET), {code: 'CERT_HAS_EXPIRED'})})
  const fake = fixture({readFailures: [tlsError]})
  const waits = []
  const error = await t.throwsAsync(deployDemo(configuration(), {...fake, async wait(duration) {
    waits.push(duration)
  }}), {message: /Réponse réseau absente pour GET \/healthz/})

  t.deepEqual(waits, [])
  t.false(error.message.includes(INVOKE_SECRET))
  t.false(fake.calls.some(call => call.method === 'POST'))
})

test('un PATCH 503 n’est jamais retenté', async t => {
  const fake = fixture({patchFailure: true})
  const error = await t.throwsAsync(deployDemo(configuration(), fake), {message: /PATCH \/containers\/v1\/regions\/fr-par\/containers\/.*HTTP 503/})

  t.false(error.message.includes(INVOKE_SECRET))
  t.is(fake.calls.filter(call => call.method === 'PATCH').length, 1)
  t.false(fake.calls.some(call => call.method === 'POST'))
})

test('un POST 503 est suivi seulement d’une lecture de statut, jamais d’un second POST', async t => {
  const fake = fixture({postFailure: true})
  await t.throwsAsync(deployDemo(configuration(), fake), {message: /opération non identifiable/})

  t.is(fake.calls.filter(call => call.method === 'POST').length, 1)
  t.is(fake.calls.filter(call => call.method === 'PATCH').length, 1)
  t.true(fake.calls.at(-1).url.endsWith('/status'))
})

test('un namespace hors projet bloque avant toute écriture', async t => {
  const fake = fixture()
  fake.namespaces[MIGRATION_NAMESPACE_ID].project_id = 'other-project'
  await t.throwsAsync(deployDemo(configuration(), fake), {message: /Namespace demo inattendu/})
  t.true(fake.calls.every(call => call.method === 'GET'))
})

test('un mauvais réseau métier bloque avant toute écriture', async t => {
  const fake = fixture()
  fake.containers[DEMO.workerId].private_network_id = null
  await t.throwsAsync(deployDemo(configuration(), fake), {message: /réseau/})
  t.true(fake.calls.every(call => call.method === 'GET'))
})

test('un exécuteur public est refusé avant toute écriture', async t => {
  const fake = fixture()
  fake.containers[MIGRATION_ID].privacy = 'public'
  await t.throwsAsync(deployDemo(configuration(), fake), {message: /confidentialité/})
  t.true(fake.calls.every(call => call.method === 'GET'))
})

test('les credentials GitHub réels doivent pouvoir invoquer le service privé', async t => {
  const fake = fixture({ciDenied: true})
  await t.throwsAsync(deployDemo(configuration(), fake), {message: /HTTP 403/})
  t.true(fake.calls.every(call => call.method === 'GET'))
})

test('une destination arbitraire ne reçoit jamais les credentials', async t => {
  const fake = fixture()
  fake.containers[MIGRATION_ID].public_endpoint = 'https://attacker.invalid'
  await t.throwsAsync(deployDemo(configuration(), fake), {message: /Endpoint Scaleway/})
  t.true(fake.calls.every(call => new URL(call.url).hostname === 'api.scaleway.com'))
})

test('les domaines historiques functions restent compatibles pour les applications demo', async t => {
  const fake = fixture()
  fake.containers[DEMO.apiId].public_endpoint = `https://${DEMO.apiId}.functions.fnc.fr-par.scw.cloud`
  const result = await deployDemo(configuration(), fake)
  t.is(result.image, IMAGE)
  t.true(fake.calls.some(call => call.url === `https://${DEMO.apiId}.functions.fnc.fr-par.scw.cloud/healthz`))
})

test('un registre Prisma avec migration inachevée bloque avant toute écriture', async t => {
  const fake = fixture({unfinished: true})
  await t.throwsAsync(deployDemo(configuration(), fake), {message: /migrations PostgreSQL/})
  t.true(fake.calls.every(call => call.method === 'GET'))
})

test('un échec de migration bloque les deux applications et ne relance pas Prisma', async t => {
  const fake = fixture({migrationFailure: true})
  await t.throwsAsync(deployDemo(configuration(), fake), {message: /réussite/})
  t.is(fake.calls.filter(call => call.method === 'POST').length, 1)
  t.deepEqual(fake.calls.filter(call => call.method === 'PATCH').map(call => call.url.split('/').at(-1)), [MIGRATION_ID])
})

test('réponse perdue : une nouvelle opération confirmée réussie permet de continuer sans second POST', async t => {
  const fake = fixture({lostResponse: 'succeeded'})
  await deployDemo(configuration(), fake)
  t.is(fake.calls.filter(call => call.method === 'POST').length, 1)
  t.is(fake.calls.filter(call => call.method === 'PATCH').length, 3)
})

for (const lostResponse of ['before', 'running']) {
  test(`réponse perdue ${lostResponse} : état inconnu ou actif bloque tout déploiement métier`, async t => {
    const fake = fixture({lostResponse})
    await t.throwsAsync(deployDemo(configuration(), fake))
    t.is(fake.calls.filter(call => call.method === 'POST').length, 1)
    t.is(fake.calls.filter(call => call.method === 'PATCH').length, 1)
    t.true(fake.calls.at(-1).url.endsWith('/status'))
  })
}

test('une dérive de noms de secrets arrête le déploiement sans les réinjecter', async t => {
  const fake = fixture({secretDrift: true})
  await t.throwsAsync(deployDemo(configuration(), fake), {message: /liste des secrets/})
  t.false(fake.calls.some(call => call.method === 'POST'))
})

test('une modification concurrente des variables métier bloque avant leur déploiement', async t => {
  const fake = fixture({businessDrift: true})
  await t.throwsAsync(deployDemo(configuration(), fake), {message: /Configuration métier modifiée/})
  t.is(fake.calls.filter(call => call.method === 'PATCH').length, 1)
})

test('le workflow demo bloque sur le service privé et transmet le digest du build', async t => {
  const workflow = await readFile(new URL('../../.github/workflows/deploy-demo.yml', import.meta.url), 'utf8')
  t.true(workflow.includes('branches: ["demo"]'))
  t.regex(workflow, /cancel-in-progress: false/)
  t.regex(workflow, /needs: quality/)
  t.regex(workflow, /uses: \.\/\.github\/workflows\/quality\.yml/)
  t.true(workflow.indexOf('Scan exact candidate image before any deployment') < workflow.indexOf('run: node deploy/network/ci-demo-deploy.js'))
  t.regex(workflow, /run: bash \.github\/scripts\/smoke-image\.sh "\$IMAGE_REF"\n/)
  t.true(workflow.indexOf('Smoke test native modules from the scanned image') < workflow.indexOf('run: node deploy/network/ci-demo-deploy.js'))
  t.regex(workflow, /id: build/)
  t.regex(workflow, /@\$\{\{ steps\.build\.outputs\.digest \}\}/)
  t.regex(workflow, /run: node deploy\/network\/ci-demo-deploy\.js/)
  t.notRegex(workflow, /jobs definition start|SCW_JOB_DEFINITION_ID|continue-on-error/)
  t.true(workflow.indexOf('Publish environment alias only after verified deployment') > workflow.indexOf('run: node deploy/network/ci-demo-deploy.js'))
})

test('une mauvaise release après mise à jour bloque avant toute migration', async t => {
  const fake = fixture({wrongRelease: true})
  await t.throwsAsync(deployDemo(configuration(), fake), {message: /release attendue/})
  t.false(fake.calls.some(call => call.method === 'POST'))
})

test('une variable de migration perdue bloque avant toute exécution', async t => {
  const fake = fixture({environmentLost: true})
  await t.throwsAsync(deployDemo(configuration(), fake), {message: /variables ordinaires/})
  t.false(fake.calls.some(call => call.method === 'POST'))
})

test('les réglages métier sont conservés et toute dérive est détectée', async t => {
  const fake = fixture({settingsDrift: true})
  await t.throwsAsync(deployDemo(configuration(), fake), {message: /configuration du conteneur/})
})

test('la santé du worker est requise avant publication du succès', async t => {
  const fake = fixture({workerUnhealthy: true})
  await t.throwsAsync(deployDemo(configuration(), fake), {message: /sonde worker/})
})
