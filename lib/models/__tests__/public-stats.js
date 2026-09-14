import test from 'ava'

import {
  buildPublicStatsActiveUsersQuery,
  classifyPublicStatsChannel,
  createPublicStatsCache,
  getPublicStats,
  listPublicStatsMonths,
  loadPublicStats,
  resolvePublicStatsMonth,
  shiftPublicStatsMonth,
  summarizePublicStatsActiveUsers,
  summarizePublicStatsChannels,
  summarizePublicStatsConnections
} from '../public-stats.js'

const now = new Date('2026-09-09T15:00:00.000Z')

test('le mois par défaut est le dernier mois terminé à Paris, y compris au changement d’année', t => {
  t.is(resolvePublicStatsMonth(undefined, now), '2026-08')
  t.is(resolvePublicStatsMonth(undefined, new Date('2026-08-31T22:05:00.000Z')), '2026-08')
  t.is(resolvePublicStatsMonth(undefined, new Date('2026-01-01T00:00:00.000Z')), '2025-12')
  t.is(shiftPublicStatsMonth('2026-01', -1), '2025-12')
  t.is(resolvePublicStatsMonth('2025-12', now), '2025-12')
})

test('les périodes malformées, courantes et futures sont refusées', t => {
  for (const month of ['2026-00', '2026-13', '26-08', '2026-8', '0000-01', '0001-01', '1899-12', '', null, ['2026-08']]) {
    const error = t.throws(() => resolvePublicStatsMonth(month, now))
    t.is(error.statusCode, 400)
  }

  t.throws(() => resolvePublicStatsMonth('2026-09', now), {message: 'Sélectionnez un mois terminé.'})
  t.is(t.throws(() => resolvePublicStatsMonth('2027-01', now)).statusCode, 400)
  t.is(resolvePublicStatsMonth('1900-01', now), '1900-01')
})

test('les mois proposés conservent les trous de données et franchissent les années', t => {
  t.deepEqual(listPublicStatsMonths('2025-11', '2026-02'), ['2025-11', '2025-12', '2026-01', '2026-02'])
  t.deepEqual(listPublicStatsMonths(null, '2026-08'), [])
  t.deepEqual(listPublicStatsMonths('2026-09', '2026-08'), [])
  t.deepEqual(listPublicStatsMonths('0001-01', '1900-02'), ['1900-01', '1900-02'])
})

test('le canal suit la majorité des points, avec égalité et provenance incertaine explicites', t => {
  t.is(classifyPublicStatsChannel({direct: 3, thirdParty: 1, unknown: 1}), 'DIRECT')
  t.is(classifyPublicStatsChannel({direct: 1, thirdParty: 3, unknown: 1}), 'THIRD_PARTY')
  t.is(classifyPublicStatsChannel({direct: 2, thirdParty: 2}), 'MIXED')
  t.is(classifyPublicStatsChannel({direct: 2, thirdParty: 1, unknown: 1}), 'UNKNOWN')
  t.is(classifyPublicStatsChannel({unknown: 2}), 'UNKNOWN')
  t.is(classifyPublicStatsChannel({}), 'UNKNOWN')
})

test('les canaux additionnent les préleveurs agrégés, jamais les points ou les valeurs', t => {
  const result = summarizePublicStatsChannels([
    {direct: 12, thirdParty: 1, unknown: 0, count: 2},
    {direct: 1, thirdParty: 0, unknown: 0, count: 1},
    {direct: 0, thirdParty: 450, unknown: 0, count: 1},
    {direct: 1, thirdParty: 1, unknown: 0, count: 1},
    {direct: 0, thirdParty: 0, unknown: 1, count: 1}
  ])
  t.deepEqual(result.map(({key, count}) => ({key, count})), [
    {key: 'DIRECT', count: 3},
    {key: 'THIRD_PARTY', count: 1},
    {key: 'MIXED', count: 1},
    {key: 'UNKNOWN', count: 1}
  ])
  t.is(result[0].percentage, 50)
  t.is(result[1].percentage, 16.67)
  t.true(summarizePublicStatsChannels().every(row => row.count === 0 && row.percentage === null))
})

test('l’historique de connexions ne transforme pas une absence de mesure en zéro', t => {
  const result = summarizePublicStatsConnections({
    month: '2026-10',
    availableSince: new Date('2026-08-10T13:00:00.000Z'),
    months: [
      {month: '2026-08', administration: 4, declarants: 7},
      {month: '2026-10', administration: 5, declarants: 3}
    ]
  })
  t.is(result.months.length, 6)
  t.deepEqual(result.months[0], {
    month: '2026-05', administration: null, declarants: null, total: null, status: 'unavailable'
  })
  t.deepEqual(result.months[3], {
    month: '2026-08', administration: 4, declarants: 7, total: 11, status: 'partial'
  })
  t.deepEqual(result.months[4], {
    month: '2026-09', administration: 0, declarants: 0, total: 0, status: 'available'
  })
  t.is(result.availableSince, '2026-08-10T13:00:00.000Z')
})

test('les six mois sont non mesurés en l’absence totale d’audit et les bornes suivent Paris', t => {
  t.true(summarizePublicStatsConnections({month: '2026-08'}).months.every(row => row.total === null))
  t.is(summarizePublicStatsConnections({month: '1900-01'}).months.length, 6)
  const result = summarizePublicStatsConnections({
    month: '2026-08', availableSince: '2026-07-31T22:05:00.000Z'
  })
  t.is(result.months.at(-2).status, 'unavailable')
  t.is(result.months.at(-1).status, 'partial')
})

test('les anciennes connexions donnent une borne basse partielle, jamais un zéro d’usage inventé', t => {
  const result = summarizePublicStatsActiveUsers({
    month: '2026-08',
    availableSince: '2026-04-15T12:00:00.000Z',
    months: [{month: '2026-05', administration: 1, declarants: 2}]
  })
  t.deepEqual(result.months[2], {
    month: '2026-05', administration: 1, declarants: 2, total: 3, status: 'partial'
  })
  t.true(result.months.filter(row => row.month !== '2026-05').every(row => row.status === 'unavailable' && row.total === null))
  t.is(result.collectionStartedAt, null)
  t.is(result.availableSince, '2026-04-15T12:00:00.000Z')
})

test('le mois de démarrage est partiel et les mois suivants peuvent réellement compter zéro utilisateur', t => {
  const result = summarizePublicStatsActiveUsers({
    month: '2026-10',
    availableSince: '2026-05-01T12:00:00.000Z',
    collectionStartedAt: '2026-08-10T13:00:00.000Z',
    months: [
      {month: '2026-06', administration: 1, declarants: 0},
      {month: '2026-08', administration: 2, declarants: 3},
      {month: '2026-10', administration: 3, declarants: 4}
    ]
  })
  t.deepEqual(result.months.map(row => row.status), [
    'unavailable', 'partial', 'unavailable', 'partial', 'available', 'available'
  ])
  t.deepEqual(result.months[4], {
    month: '2026-09', administration: 0, declarants: 0, total: 0, status: 'available'
  })
  t.is(result.months.at(-1).total, 7)
  t.is(result.collectionStartedAt, '2026-08-10T13:00:00.000Z')
})

test('la collecte sans ancien audit commence au premier signal et les mois suivent Paris', t => {
  const result = summarizePublicStatsActiveUsers({
    month: '2026-02',
    collectionStartedAt: '2025-12-31T23:05:00.000Z',
    months: [{month: '2026-01', administration: 1, declarants: 0}]
  })
  t.is(result.months[3].month, '2025-12')
  t.is(result.months[3].status, 'unavailable')
  t.is(result.months[4].status, 'partial')
  t.is(result.months[5].status, 'available')
  t.is(result.availableSince, '2025-12-31T23:05:00.000Z')
  t.true(summarizePublicStatsActiveUsers({month: '2026-08'}).months.every(row => row.total === null))
})

test('la requête d’activité borne les six mois et donne priorité aux marqueurs sur les anciens rôles de connexion', t => {
  const query = buildPublicStatsActiveUsersQuery('2026-02')
  t.deepEqual(query.values, ['2025-09-01', '2026-03-01', '2025-09', '2026-03'])
  t.true(query.sql.includes("AT TIME ZONE 'Europe/Paris'"))
  t.true(query.sql.includes('SELECT DISTINCT ON (month, "userId")'))
  t.true(query.sql.includes('ORDER BY month, "userId", priority'))
  t.true(query.sql.includes('OR month <= (SELECT month FROM collection_state)'))
})

test('le cache coalesce les calculs concurrents même si un calcul dépasse le TTL', async t => {
  const cache = createPublicStatsCache({ttlMs: 100})
  let finish
  const pending = new Promise(resolve => {
    finish = resolve
  })
  let calls = 0
  const loader = () => {
    calls++
    return pending
  }

  const first = cache.get('2026-08', loader, 0)
  const second = cache.get('2026-08', loader, 200)
  t.is(first, second)
  finish({count: 2})
  t.deepEqual(await first, {count: 2})
  t.is(calls, 1)
})

test('le cache expire après une heure et n’enregistre pas les erreurs', async t => {
  const cache = createPublicStatsCache()
  let calls = 0
  const loader = () => ++calls
  t.is(await cache.get('2026-08', loader, 0), 1)
  t.is(await cache.get('2026-08', loader, 3_599_999), 1)
  t.is(await cache.get('2026-08', loader, 3_600_000), 2)
  await t.throwsAsync(cache.get('2026-07', () => {
    throw new Error('Base indisponible')
  }, 0), {message: 'Base indisponible'})
  t.is(await cache.get('2026-07', loader, 1), 3)
})

test('le cache est borné et évince le mois le moins récemment consulté', async t => {
  const cache = createPublicStatsCache({maxEntries: 2})
  let calls = 0
  const loader = () => ++calls
  await cache.get('2026-06', loader, 0)
  await cache.get('2026-07', loader, 0)
  await cache.get('2026-06', loader, 1)
  await cache.get('2026-08', loader, 1)
  t.is(cache.size, 2)
  t.is(await cache.get('2026-06', loader, 2), 1)
  t.is(await cache.get('2026-07', loader, 2), 4)
  t.is(cache.size, 2)
})

function statsClient({territories = [], pointsCount = 0n, preleveursCount = 0n} = {}) {
  const client = {
    calls: 0,
    async $queryRaw(query) {
      client.calls++
      return query.sql.includes('live_preleveurs')
        ? [{firstMeasurementMonth: '2026-06', territories, pointsCount, preleveursCount, channelGroups: []}]
        : [{availableSince: null, months: []}]
    }
  }
  return client
}

test('la réponse conserve les territoires sans remontée du mois et les totaux dédupliqués SQL', async t => {
  const client = statsClient({
    pointsCount: 3n,
    preleveursCount: 2n,
    territories: [
      {
        id: 'sage-z', name: 'Zède', type: 'SAGE', pointsCount: 3, preleveursCount: 2,
        reportingPreleveursCount: 0, agriculture: 1, unknown: 1
      },
      {
        id: 'sage-a', name: 'Alpes', type: 'SAGE', pointsCount: 3, preleveursCount: 2,
        reportingPreleveursCount: 1, agriculture: 1, unknown: 1
      },
      {
        id: 'dep', name: 'Département', type: 'DEPARTEMENT', pointsCount: 3, preleveursCount: 2,
        reportingPreleveursCount: 1, agriculture: 1, unknown: 1
      }
    ]
  })
  const result = await loadPublicStats({month: '2026-08', client, now})
  t.deepEqual(result.totals, {pointsCount: 3, preleveursCount: 2, sageCount: 2, departmentCount: 1})
  t.deepEqual(result.territories.SAGE.map(row => row.name), ['Alpes', 'Zède'])
  t.is(result.territories.SAGE[1].reportingRate, 0)
  t.is(result.territories.SAGE[0].reportingRate, 50)
  t.deepEqual(result.availableMonths, ['2026-06', '2026-07', '2026-08'])
  t.is(result.territories.SAGE[0].profiles.reduce((sum, row) => sum + row.count, 0), 2)
  t.is(result.generatedAt, now.toISOString())
  t.is(client.calls, 3)
  t.is(result.activeUsers.collectionStartedAt, null)
  t.true(result.activeUsers.months.every(row => row.status === 'unavailable'))
})

test('getPublicStats partage un résultat par client et mois sans mélanger les environnements', async t => {
  const firstClient = statsClient({pointsCount: 3n})
  const secondClient = statsClient({pointsCount: 8n})
  const [first, duplicate, second] = await Promise.all([
    getPublicStats({client: firstClient, now}),
    getPublicStats({month: '2026-08', client: firstClient, now}),
    getPublicStats({month: '2026-08', client: secondClient, now})
  ])
  t.is(first, duplicate)
  t.is(firstClient.calls, 3)
  t.is(first.totals.pointsCount, 3)
  t.is(second.totals.pointsCount, 8)
})

test('un territoire sans préleveur n’affiche pas un pourcentage artificiel', async t => {
  const client = statsClient({territories: [{
    id: 'sage', name: 'SAGE', type: 'SAGE', pointsCount: 1, preleveursCount: 0, reportingPreleveursCount: 0
  }]})
  const result = await loadPublicStats({month: '2026-08', client, now})
  t.is(result.territories.SAGE[0].reportingRate, null)
})
