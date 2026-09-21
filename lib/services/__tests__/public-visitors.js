import test from 'ava'

import {createPublicVisitorsLoader, unavailablePublicVisitors} from '../public-visitors.js'

const NOW = new Date('2026-09-21T12:00:00Z')
const ENV = {MATOMO_REPORTING_URL: 'https://analytics.example.test/', MATOMO_REPORTING_SITE_ID: '263', MATOMO_REPORTING_TOKEN: 'test-only-token'}
const response = values => ({ok: true, json: async () => values})

test('six mois terminés, uniques mensuels et segment limité au domaine vitrine, secret uniquement en POST', async t => {
  const load = createPublicVisitorsLoader({env: ENV, fetchImpl: async (url, options) => {
    t.is(url, 'https://analytics.example.test/index.php')
    t.is(options.method, 'POST')
    t.is(options.redirect, 'error')
    t.truthy(options.signal)
    t.is(options.body.get('token_auth'), ENV.MATOMO_REPORTING_TOKEN)
    t.is(options.body.get('method'), 'API.getBulkRequest')
    for (let index = 0; index < 6; index++) {
      const query = new URLSearchParams(options.body.get(`urls[${index}]`))
      t.is(query.get('method'), 'VisitsSummary.getUniqueVisitors')
      t.is(query.get('idSite'), '263')
      t.is(query.get('period'), 'month')
      t.is(query.get('date'), `2026-0${index + 3}-01`)
      t.is(query.get('segment'), 'pageUrl=^https%3A%2F%2Fpartageonsleau.beta.gouv.fr%2F,pageUrl=^http%3A%2F%2Fpartageonsleau.beta.gouv.fr%2F')
      t.false(query.has('token_auth'))
    }

    return response([0, {value: 12}, {value: 14}, 18, 20, {value: 37}])
  }})
  const result = await load({now: NOW})
  t.is(result.website, 'https://partageonsleau.beta.gouv.fr/')
  t.deepEqual(result.months.map(row => row.uniqueVisitors), [0, 12, 14, 18, 20, 37])
  t.true(result.months.every(row => row.status === 'complete'))
  t.is(result.fetchedAt, NOW.toISOString())
  t.false(JSON.stringify(result).includes(ENV.MATOMO_REPORTING_TOKEN))
})

test('une métrique absente ou invalide ne devient ni un zéro ni un nombre de visites', async t => {
  const load = createPublicVisitorsLoader({env: ENV, fetchImpl: async () => response([
    null, {nb_visits: 42}, {value: -1}, {value: '12'}, {value: 1.5}, {result: 'error', message: ENV.MATOMO_REPORTING_TOKEN}
  ])})
  t.deepEqual(await load({now: NOW}), unavailablePublicVisitors(NOW))
})

test('les erreurs partielles conservent les mois disponibles', async t => {
  const load = createPublicVisitorsLoader({env: ENV, fetchImpl: async () => response([0, 1, 2, 3, {result: 'error'}, 5])})
  const result = await load({now: NOW})
  t.is(result.months[0].status, 'complete')
  t.is(result.months[4].status, 'unavailable')
  t.is(result.months[4].uniqueVisitors, null)
  t.is(result.months[5].uniqueVisitors, 5)
})

test('configuration manquante ou URL non sûre : aucun appel', async t => {
  await Promise.all([{}, {...ENV, MATOMO_REPORTING_TOKEN: ''}, {...ENV, MATOMO_REPORTING_SITE_ID: '263,264'},
    {...ENV, MATOMO_REPORTING_URL: 'http://analytics.example.test'},
    {...ENV, MATOMO_REPORTING_URL: 'https://analytics.example.test/?token_auth=private'},
    {...ENV, MATOMO_REPORTING_URL: 'https://user:password@analytics.example.test'}].map(async env => {
    const load = createPublicVisitorsLoader({env, fetchImpl: () => t.fail('No request expected')})
    t.deepEqual(await load({now: NOW}), unavailablePublicVisitors(NOW))
  }))
})

test('401, réponse invalide et exception restent indisponibles sans divulgation', async t => {
  await Promise.all([async () => ({ok: false}), async () => response({result: 'error'}),
    async () => response([0]), async () => { throw new Error(ENV.MATOMO_REPORTING_TOKEN) }].map(async fetchImpl => {
    const load = createPublicVisitorsLoader({env: ENV, fetchImpl})
    t.deepEqual(await load({now: NOW}), unavailablePublicVisitors(NOW))
  }))
})

test('la requête est interrompue au délai et ne bloque pas indéfiniment les statistiques', async t => {
  const load = createPublicVisitorsLoader({env: ENV, timeoutMs: 10, fetchImpl: async (_, {signal}) => new Promise((resolve, reject) => {
    // Keep the test process alive: AbortSignal.timeout itself is unrefed in Node.
    const timer = setTimeout(() => resolve(response([0, 0, 0, 0, 0, 0])), 1000)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, {once: true})
  })})
  t.deepEqual(await load({now: NOW}), unavailablePublicVisitors(NOW))
})

test('cache borné à une heure, mutualisation et renouvellement au changement de mois', async t => {
  let requests = 0
  const load = createPublicVisitorsLoader({env: ENV, fetchImpl: async () => {
    requests++
    return response([1, 2, 3, 4, 5, 6])
  }})
  await Promise.all([load({now: NOW}), load({now: NOW}), load({now: NOW})])
  t.is(requests, 1)
  await load({now: new Date(NOW.getTime() + 3_599_999)})
  t.is(requests, 1)
  await load({now: new Date(NOW.getTime() + 3_600_000)})
  t.is(requests, 2)
  const october = await load({now: new Date('2026-09-30T22:00:00Z')})
  t.is(requests, 3)
  t.is(october.months.at(-1).month, '2026-09')
})

test('une panne est réessayée après une minute et une rotation de jeton invalide le cache', async t => {
  let requests = 0
  const env = {...ENV}
  const load = createPublicVisitorsLoader({env, fetchImpl: async () => {
    requests++
    return requests === 1 ? {ok: false} : response([0, 0, 0, 0, 0, 0])
  }})
  await load({now: NOW})
  await load({now: new Date(NOW.getTime() + 59_999)})
  t.is(requests, 1)
  await load({now: new Date(NOW.getTime() + 60_000)})
  t.is(requests, 2)
  env.MATOMO_REPORTING_TOKEN = 'rotated-test-token'
  await load({now: new Date(NOW.getTime() + 60_001)})
  t.is(requests, 3)
})
