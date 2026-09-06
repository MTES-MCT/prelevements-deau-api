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
  const json = (value, status = 200) => new Response(JSON.stringify(value), {status})

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
        Object.assign(containers[id], body)
        if (id === MIGRATION_ID && options.secretDrift) {
          containers[id].secret_environment_variables.UNEXPECTED = 'redacted'
        }

        if (id === MIGRATION_ID && options.businessDrift) {
          containers[DEMO.apiId].environment_variables.KEEP_CONTAINER = 'modified concurrently'
        }
      }

      return json(containers[id])
    }

    if (url.hostname === `${MIGRATION_ID}.containers.fnc.fr-par.scw.cloud`) {
      if (request.headers?.['X-Auth-Token'] !== AUTH || options.ciDenied) {
        return json({}, 403)
      }

      if (url.pathname === '/healthz') {
        return json({ok: true, release: containers[MIGRATION_ID].environment_variables.MIGRATION_RELEASE_SHA})
      }

      if (request.headers?.['X-Migration-Secret'] !== INVOKE_SECRET) {
        return json({}, 403)
      }

      if (url.pathname === '/status') {
        return json(migrationStatus())
      }

      if (url.pathname === '/migrate') {
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
  const posts = fake.calls.filter(call => call.method === 'POST')
  t.is(posts.length, 1)
  t.deepEqual(posts[0].body, {expectedRelease: RELEASE})
  t.is(posts[0].headers['X-Auth-Token'], AUTH)
  t.is(posts[0].headers['X-Migration-Secret'], INVOKE_SECRET)
  t.is(result.migrationOperationId, OPERATION_ID)
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
  t.regex(workflow, /id: build/)
  t.regex(workflow, /@\${{ steps\.build\.outputs\.digest }}/)
  t.regex(workflow, /run: node deploy\/network\/ci-demo-deploy\.js/)
  t.notRegex(workflow, /jobs definition start|SCW_JOB_DEFINITION_ID|continue-on-error/)
  t.true(workflow.indexOf('Publish demo-latest after successful deployment') > workflow.indexOf('run: node deploy/network/ci-demo-deploy.js'))
})
