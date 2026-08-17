import test from 'ava'

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
