import test from 'ava'

import {createHubeauClient, HubeauError} from '../hubeau.js'

function jsonResponse(payload, {status = 200, retryAfter = null} = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return name.toLowerCase() === 'retry-after' ? retryAfter : null
      }
    },
    async json() {
      return payload
    },
    async text() {
      return JSON.stringify(payload)
    }
  }
}

test('le client encode le code BSS et demande une station unique', async t => {
  let requestedURL
  const client = createHubeauClient({
    piezometryBaseURL: 'https://example.test/niveaux_nappes',
    retries: 1,
    async fetchImpl(url) {
      requestedURL = url
      return jsonResponse({data: [{code_bss: '07704X0079/S'}]})
    }
  })

  const station = await client.getPiezometer('07704X0079/S')

  t.is(station.code_bss, '07704X0079/S')
  t.is(requestedURL.pathname, '/niveaux_nappes/stations')
  t.is(requestedURL.searchParams.get('code_bss'), '07704X0079/S')
  t.is(requestedURL.searchParams.get('size'), '1')
})

test('le client accepte le nouvel identifiant bss_id pour une station', async t => {
  let requestedURL
  const client = createHubeauClient({
    piezometryBaseURL: 'https://example.test/niveaux_nappes',
    retries: 1,
    async fetchImpl(url) {
      requestedURL = url
      return jsonResponse({data: [{code_bss: '10971X0198/LAFAR', bss_id: 'BSS002MUNP'}]})
    }
  })

  await client.getPiezometer('BSS002MUNP')

  t.is(requestedURL.searchParams.get('bss_id'), 'BSS002MUNP')
  t.is(requestedURL.searchParams.get('code_bss'), null)
})

test('les chroniques utilisent en priorité le bss_id stable', async t => {
  let requestedURL
  const client = createHubeauClient({
    piezometryBaseURL: 'https://example.test/niveaux_nappes',
    retries: 1,
    async fetchImpl(url) {
      requestedURL = url
      return jsonResponse({data: [], next: null})
    }
  })

  await client.listGroundwaterChronicles('10971X0198/LAFAR', {bssId: 'BSS002MUNP'})

  t.is(requestedURL.searchParams.get('bss_id'), 'BSS002MUNP')
  t.is(requestedURL.searchParams.get('code_bss'), null)
})

test('le client suit la pagination Hub’Eau et concatène les pages', async t => {
  const requestedPages = []
  const client = createHubeauClient({
    piezometryBaseURL: 'https://example.test/niveaux_nappes',
    retries: 1,
    async fetchImpl(url) {
      requestedPages.push(url.searchParams.get('page') ?? '1')
      return url.searchParams.get('page') === '2'
        ? jsonResponse({data: [{date_mesure: '2026-07-02'}], next: null})
        : jsonResponse({
          data: [{date_mesure: '2026-07-01'}],
          next: 'https://example.test/niveaux_nappes/chroniques?page=2'
        })
    }
  })

  const rows = await client.listGroundwaterChronicles('07704X0079/S')

  t.deepEqual(requestedPages, ['1', '2'])
  t.deepEqual(rows.map(row => row.date_mesure), ['2026-07-01', '2026-07-02'])
})

test('le client refuse une URL de pagination sortant de Hub’Eau', async t => {
  const client = createHubeauClient({
    piezometryBaseURL: 'https://example.test/niveaux_nappes',
    retries: 1,
    async fetchImpl() {
      return jsonResponse({
        data: [],
        next: 'https://unexpected.test/chroniques?page=2'
      })
    }
  })

  const error = await t.throwsAsync(() => client.listGroundwaterChronicles('07704X0079/S'))
  t.true(error instanceof HubeauError)
  t.regex(error.message, /pagination inattendue/)
})

test('le client retente une erreur serveur transitoire', async t => {
  let requestCount = 0
  const delays = []
  const client = createHubeauClient({
    piezometryBaseURL: 'https://example.test/niveaux_nappes',
    retries: 2,
    sleepImpl: async delay => delays.push(delay),
    async fetchImpl() {
      requestCount += 1
      return requestCount === 1
        ? jsonResponse({message: 'indisponible'}, {status: 503})
        : jsonResponse({data: [{code_bss: '07704X0079/S'}]})
    }
  })

  await client.getPiezometer('07704X0079/S')

  t.is(requestCount, 2)
  t.deepEqual(delays, [1000])
})
