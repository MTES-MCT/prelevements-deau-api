import test from 'ava'
import {once} from 'node:events'
import {createServer} from 'node:http'
import process from 'node:process'

import {
  buildSandreFeatureCountURL,
  buildSandreZonesURL,
  createSandreTransport,
  createSandreZoneSnapshot,
  fetchSandreZoneSnapshot,
  parseSandreFeatureCount,
  parseSandreZoneFeature,
  SandreAlertZoneError
} from '../sandre-alert-zones.js'

const polygon = {
  type: 'Polygon',
  coordinates: [[
    [2, 48],
    [3, 48],
    [3, 49],
    [2, 48]
  ]]
}

function rawFeature(overrides = {}) {
  const properties = {
    gid: 42,
    CdZAS: 'FR_SUP_001',
    LbZAS: 'Zone superficielle de test',
    TypeZAS: 'SUP',
    StZAS: 'Validé',
    DateMajZAS: '2026-08-15',
    NumeroVersionZAS: 3,
    NumCircAdminBassin: 5,
    RessInfluenceeZAS: 1,
    CdDepartement: '75',
    CdAltZAS: 'ALT-001',
    CodesAlternatifs: '[{"code":"ALT-002"}]',
    ...overrides.properties
  }

  return {
    type: 'Feature',
    geometry: overrides.geometry === undefined ? polygon : overrides.geometry,
    properties
  }
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body)
    }
  }
}

test('les URLs WFS ciblent uniquement la couche ZAS du département', t => {
  const zonesURL = new URL(buildSandreZonesURL('https://example.test/', '2A', 1000, 1000))
  const countURL = new URL(buildSandreFeatureCountURL('https://example.test/', '2A'))

  t.is(zonesURL.pathname, '/geo/zas')
  t.is(zonesURL.searchParams.get('typename'), 'ZAS')
  t.is(zonesURL.searchParams.get('SRSNAME'), 'EPSG:4326')
  t.is(zonesURL.searchParams.get('STARTINDEX'), '1000')
  t.regex(zonesURL.searchParams.get('Filter'), /CdDepartement.*2A/)
  t.is(countURL.searchParams.get('RESULTTYPE'), 'hits')
  t.false(zonesURL.toString().toLowerCase().includes('aep'))
})

test('un endpoint complet est partagé par les pages et le comptage sans perdre ses paramètres propres', t => {
  const endpoint = 'https://example.test/zas/mapserver?map=zas&count=8&RESULTTYPE=hits'
  const zonesURL = new URL(buildSandreZonesURL(undefined, '01', 1000, 1000, {endpoint}))
  const countURL = new URL(buildSandreFeatureCountURL(undefined, '01', {endpoint}))

  for (const url of [zonesURL, countURL]) {
    t.is(url.pathname, '/zas/mapserver')
    t.is(url.searchParams.get('map'), 'zas')
    t.is(url.searchParams.get('typename'), 'ZAS')
    t.regex(url.searchParams.get('Filter'), /CdDepartement.*01/)
    t.false(url.searchParams.has('count'))
  }

  t.is(zonesURL.searchParams.get('COUNT'), '1000')
  t.is(zonesURL.searchParams.get('STARTINDEX'), '1000')
  t.is(zonesURL.searchParams.get('SORTBY'), 'CdZAS')
  t.false(zonesURL.searchParams.has('RESULTTYPE'))
  t.is(countURL.searchParams.get('RESULTTYPE'), 'hits')
  t.false(countURL.searchParams.has('COUNT'))
})

test('une ancienne base URL conserve son chemin et ses paramètres propres', t => {
  const url = new URL(buildSandreFeatureCountURL('http://localhost:8080/service/?map=zas', '75'))
  t.is(url.pathname, '/service/geo/zas')
  t.is(url.searchParams.get('map'), 'zas')
})

for (const endpoint of ['relative/path', 'file:///tmp/zas', 'ftp://example.test/zas', 'https://user:secret@example.test/zas']) {
  test(`un endpoint SANDRE invalide est refusé : ${new URL(endpoint, 'https://example.test').protocol} ${endpoint.includes('@') ? 'identifiants' : endpoint}`, t => {
    t.throws(() => buildSandreFeatureCountURL(undefined, '75', {endpoint}), {
      instanceOf: SandreAlertZoneError,
      message: 'URL du service SANDRE invalide.'
    })
  })
}

const endpointCases = [
  {name: 'défaut', expected: 'https://www.sandre.eaufrance.fr/zas/mapserver'},
  {name: 'ancienne variable', baseEnv: 'https://old.test/root/', expected: 'https://old.test/root/geo/zas'},
  {name: 'option baseURL prioritaire sur son ancienne variable', baseEnv: 'https://old.test', options: {baseURL: 'https://base.test'}, expected: 'https://base.test/geo/zas'},
  {name: 'variable endpoint prioritaire sur une ancienne baseURL', endpointEnv: 'https://new.test/zas/mapserver', baseEnv: 'https://old.test', options: {baseURL: 'https://base.test'}, expected: 'https://new.test/zas/mapserver'},
  {name: 'option endpoint prioritaire sur les variables', endpointEnv: 'https://new.test/zas/mapserver', baseEnv: 'https://old.test', options: {endpoint: 'http://localhost:8080/zas/mapserver', baseURL: 'https://base.test'}, expected: 'http://localhost:8080/zas/mapserver'}
]

for (const {name, endpointEnv, baseEnv, options, expected} of endpointCases) {
  test.serial(`le choix du service SANDRE respecte la configuration : ${name}`, async t => {
    const originalEndpoint = process.env.SANDRE_ZAS_URL
    const originalBase = process.env.SANDRE_API_BASE_URL
    const setEnvironment = (key, value) => {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }

    t.teardown(() => {
      setEnvironment('SANDRE_ZAS_URL', originalEndpoint)
      setEnvironment('SANDRE_API_BASE_URL', originalBase)
    })
    setEnvironment('SANDRE_ZAS_URL', endpointEnv)
    setEnvironment('SANDRE_API_BASE_URL', baseEnv)

    const requested = []
    await fetchSandreZoneSnapshot('75', {
      ...options,
      transport: {
        async getText(url) {
          requested.push(new URL(url))
          return '<FeatureCollection numberMatched="0"/>'
        }
      }
    })

    t.is(requested.length, 2)
    for (const url of requested) {
      t.is(`${url.origin}${url.pathname}`, expected)
      t.is(url.searchParams.get('RESULTTYPE'), 'hits')
    }
  })
}

test('le comptage WFS accepte un document XML avec namespace', t => {
  t.is(parseSandreFeatureCount('<wfs:FeatureCollection numberMatched="17"/>'), 17)
  t.throws(() => parseSandreFeatureCount('<wfs:FeatureCollection numberMatched="unknown"/>'), {
    instanceOf: SandreAlertZoneError
  })
})

test('une zone validée SUP est normalisée avec ses métadonnées', t => {
  const feature = parseSandreZoneFeature(rawFeature(), '75')

  t.like(feature, {
    gid: 42,
    codeSandre: 'FR_SUP_001',
    name: 'Zone superficielle de test',
    type: 'SUP',
    status: 'VALIDATED',
    departmentCode: '75',
    sourceUpdatedAt: '2026-08-15',
    version: 3,
    basinCode: 5,
    influencedResource: true,
    preferredAlternateCode: 'ALT-001'
  })
  t.deepEqual(feature.alternateCodes, ['ALT-001', 'ALT-002'])
  t.regex(feature.payloadHash, /^[a-f\d]{64}$/)
})

test('un code SANDRE numérique conserve le contenu et le hash de son équivalent texte', t => {
  const numericFeature = rawFeature({properties: {CdZAS: 1428}})
  const textFeature = rawFeature({properties: {CdZAS: '1428'}})

  t.deepEqual(parseSandreZoneFeature(numericFeature, '75'), parseSandreZoneFeature(textFeature, '75'))
  t.deepEqual(createSandreZoneSnapshot([numericFeature], 1, '75'), createSandreZoneSnapshot([textFeature], 1, '75'))
  t.is(parseSandreZoneFeature(rawFeature({properties: {CdZAS: Number.MAX_SAFE_INTEGER}}), '75').codeSandre, String(Number.MAX_SAFE_INTEGER))
})

test('un code SANDRE numérique invalide ne peut pas devenir un identifiant texte', t => {
  for (const code of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, true, {}, [], null, undefined, '']) {
    t.throws(() => parseSandreZoneFeature(rawFeature({properties: {CdZAS: code}}), '75'), {
      instanceOf: SandreAlertZoneError,
      message: /Données SANDRE invalides/
    })
  }
})

test('un code SANDRE présent en nombre et en texte reste un doublon', t => {
  t.throws(() => createSandreZoneSnapshot([
    rawFeature({properties: {CdZAS: 1428, gid: 1}}),
    rawFeature({properties: {CdZAS: '1428', gid: 2}})
  ], 2, '75'), {message: /Code SANDRE dupliqué 1428/})
})

test('un département numérique conserve son code canonique et sa portée', t => {
  for (const [value, expected] of [[1, '01'], [75, '75'], [971, '971'], ['2A', '2A']]) {
    t.is(parseSandreZoneFeature(rawFeature({properties: {CdDepartement: value}}), expected).departmentCode, expected)
  }

  t.deepEqual(
    parseSandreZoneFeature(rawFeature({properties: {CdDepartement: 1}}), '01'),
    parseSandreZoneFeature(rawFeature({properties: {CdDepartement: '01'}}), '01')
  )

  for (const value of [2, '1', 1.5, true, {}, {toString: () => '01'}, [], 0, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    t.throws(() => parseSandreZoneFeature(rawFeature({properties: {CdDepartement: value}}), '01'), {
      instanceOf: SandreAlertZoneError,
      message: /Département SANDRE invalide/
    })
  }
})

test('le nouveau service peut omettre le GID et fournir directement son code alternatif', t => {
  const feature = rawFeature({properties: {
    gid: undefined,
    CdZAS: 1428,
    NumeroVersionZAS: 4,
    CdAltZAS: '75_87_0008',
    CodesAlternatifs: undefined
  }})
  const parsed = parseSandreZoneFeature(feature, '75')
  t.is(parsed.gid, null)
  t.is(parsed.codeSandre, '1428')
  t.is(parsed.version, 4)
  t.is(parsed.preferredAlternateCode, '75_87_0008')
  t.deepEqual(parsed.alternateCodes, ['75_87_0008'])

  const snapshot = createSandreZoneSnapshot([
    feature,
    rawFeature({properties: {gid: null, CdZAS: 1429}})
  ], 2, '75')
  t.is(snapshot.featureCount, 2)
  t.deepEqual(snapshot.features.map(zone => zone.gid), [null, null])
})

test('un GID explicite invalide ou dupliqué reste refusé', t => {
  for (const gid of ['', 0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER, true, {}, []]) {
    t.throws(() => parseSandreZoneFeature(rawFeature({properties: {gid}}), '75'), {
      message: /Données SANDRE invalides/
    })
  }

  t.throws(() => createSandreZoneSnapshot([
    rawFeature({properties: {CdZAS: 1428}}),
    rawFeature({properties: {CdZAS: 1429}})
  ], 2, '75'), {message: /GID SANDRE dupliqué/})
})

test('une zone gelée peut être stockée sans géométrie', t => {
  const feature = parseSandreZoneFeature(rawFeature({
    geometry: null,
    properties: {
      CdZAS: 'FR_SOU_001',
      TypeZAS: 'SOU',
      StZAS: 'Gelé'
    }
  }), '75')

  t.is(feature.status, 'FROZEN')
  t.is(feature.geometry, null)
})

test('les types hors SUP et SOU, notamment AEP, sont refusés', t => {
  const error = t.throws(() => parseSandreZoneFeature(rawFeature({
    properties: {TypeZAS: 'AEP'}
  }), '75'))
  t.regex(error.message, /Données SANDRE invalides/)
})

test('une zone validée doit toujours fournir un polygone exploitable', t => {
  const error = t.throws(() => parseSandreZoneFeature(rawFeature({geometry: null}), '75'))
  t.regex(error.message, /Géométrie SANDRE invalide/)
})

test('un snapshot incomplet ou dupliqué est refusé', t => {
  t.throws(() => createSandreZoneSnapshot([rawFeature()], 2, '75'), {
    message: /Snapshot SANDRE incomplet/
  })

  t.throws(() => createSandreZoneSnapshot([rawFeature(), rawFeature()], 2, '75'), {
    message: /Code SANDRE dupliqué/
  })
})

test('la lecture vérifie le comptage avant et après la pagination', async t => {
  const requested = []
  const snapshot = await fetchSandreZoneSnapshot('75', {
    baseURL: 'https://example.test',
    transport: {
      async getText(url) {
        requested.push(new URL(url).searchParams.get('RESULTTYPE'))
        return '<FeatureCollection numberMatched="1"/>'
      },
      async getJson() {
        return {features: [rawFeature()]}
      }
    }
  })

  t.is(snapshot.featureCount, 1)
  t.deepEqual(requested, ['hits', 'hits'])
})

test('la lecture utilise le même endpoint complet pour les pages et leurs comptages', async t => {
  const requested = []
  const snapshot = await fetchSandreZoneSnapshot('75', {
    endpoint: 'https://example.test/zas/mapserver?map=zas',
    transport: {
      async getText(url) {
        requested.push(new URL(url))
        return '<FeatureCollection numberMatched="1"/>'
      },
      async getJson(url) {
        requested.push(new URL(url))
        return {features: [rawFeature({properties: {gid: undefined, CdZAS: 1428}})]}
      }
    }
  })

  t.is(snapshot.features[0].codeSandre, '1428')
  t.is(requested.length, 3)
  t.deepEqual(requested.map(url => url.searchParams.get('RESULTTYPE')), ['hits', null, 'hits'])
  for (const url of requested) {
    t.is(url.pathname, '/zas/mapserver')
    t.is(url.searchParams.get('map'), 'zas')
  }
})

test('la lecture refuse un comptage qui change pendant le téléchargement', async t => {
  let countCall = 0
  const error = await t.throwsAsync(() => fetchSandreZoneSnapshot('75', {
    baseURL: 'https://example.test',
    transport: {
      async getText() {
        countCall += 1
        return `<FeatureCollection numberMatched="${countCall}"/>`
      },
      async getJson() {
        return {features: [rawFeature()]}
      }
    }
  }))

  t.regex(error.message, /a changé pendant la lecture/)
})

test('le transport retente une erreur serveur transitoire', async t => {
  let callCount = 0
  const delays = []
  const transport = createSandreTransport({
    retries: 2,
    sleepImpl: async delay => delays.push(delay),
    async fetchImpl() {
      callCount += 1
      return callCount === 1
        ? response('indisponible', 503)
        : response('<FeatureCollection numberMatched="0"/>')
    }
  })

  const result = await transport.getText('https://example.test/geo/zas')
  t.regex(result, /numberMatched/)
  t.is(callCount, 2)
  t.deepEqual(delays, [1000])
})

test('le transport propage un refus HTTP 403 sans réessai ni repli', async t => {
  const requested = []
  const transport = createSandreTransport({
    retries: 3,
    async fetchImpl(url) {
      requested.push(url.toString())
      return response('Forbidden', 403)
    }
  })

  const error = await t.throwsAsync(() => transport.getText('https://example.test/zas/mapserver'), {
    instanceOf: SandreAlertZoneError,
    message: 'Le SANDRE a répondu HTTP 403 : Forbidden'
  })
  t.is(error.status, 403)
  t.deepEqual(requested, ['https://example.test/zas/mapserver'])
})

test('le transport suit une redirection HTTP avec le fetch natif', async t => {
  const requested = []
  const server = createServer((request, reply) => {
    requested.push(request.url)
    if (request.url === '/old') {
      reply.writeHead(302, {location: '/zas/mapserver'})
      reply.end()
      return
    }

    reply.writeHead(200, {'content-type': 'application/json'})
    reply.end(JSON.stringify({features: [rawFeature()]}))
  })
  t.teardown(() => new Promise(resolve => server.close(resolve)))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  const transport = createSandreTransport({retries: 1})
  const result = await transport.getJson(`http://127.0.0.1:${server.address().port}/old`)
  t.deepEqual(result.features, [rawFeature()])
  t.deepEqual(requested, ['/old', '/zas/mapserver'])
})
