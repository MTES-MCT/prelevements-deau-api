import process from 'node:process'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {replayDeclarationHandler} from '../declarations.js'

const declarationId = '33333333-3333-4333-8333-333333333333'
const user = {id: '11111111-1111-4111-8111-111111111111', role: 'ADMIN'}

function stub(t, target, key, value) {
  const original = target[key]
  target[key] = value
  t.teardown(() => { target[key] = original })
}

function environment(t) {
  for (const [key, value] of Object.entries({ORCHESTRATION_BASE_URL: 'https://orchestration.example.test', ORCHESTRATION_WEBHOOK_SECRET: 'synthetic-test-secret'})) {
    const previous = process.env[key]
    process.env[key] = value
    t.teardown(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })
  }
}

async function invoke() {
  const response = {}
  await replayDeclarationHandler({params: {declarationId}, user}, {
    status(status) { response.status = status; return this },
    json(body) { response.body = body }
  }, error => { response.error = error })
  return response
}

for (const source of [null, {id: 'source', status: 'COMPLETED', metadata: {provenance: 'DN', historicalAccepted: true}},
  {id: 'source', status: 'FAILED', metadata: {}}]) {
  test.serial(`rejeu DN historique interdit avant mutation ou notification, source ${source?.status ?? 'absente'}`, async t => {
    environment(t)
    const calls = []
    stub(t, prisma.declaration, 'findUnique', async query => {
      calls.push('read')
      t.true(query.select.importSourceId)
      return {id: declarationId, importSourceId: 'reunion:DN:80149:12345', source, files: [{id: 'original-file'}]}
    })
    stub(t, prisma, '$transaction', async () => { calls.push('transaction'); throw new Error('Unexpected mutation') })
    stub(t, globalThis, 'fetch', async () => { calls.push('enqueue'); throw new Error('Unexpected orchestration request') })
    const response = await invoke()
    t.is(response.error.status, 409)
    t.regex(response.error.message, /import historique.*corrections validées/)
    t.falsy(response.body)
    t.deepEqual(calls, ['read'])
  })
}

for (const importSourceId of [null, 'reunion:local:legacy']) {
  test.serial(`le rejeu des autres fichiers conserve son traitement, origine ${importSourceId ?? 'native PE'}`, async t => {
    environment(t)
    const calls = []
    stub(t, prisma.declaration, 'findUnique', async () => ({id: declarationId, code: 'ABC123', importSourceId, files: [{id: 'file'}], source: null}))
    stub(t, globalThis, 'fetch', async (url, options) => {
      calls.push('enqueue')
      t.is(url, 'https://orchestration.example.test/hooks/declarations')
      t.deepEqual(JSON.parse(options.body), {event: 'declaration.uploaded', declarationId})
      return {ok: true, async json() { return {jobId: 'synthetic-job'} }}
    })
    stub(t, prisma, '$transaction', async callback => callback({
      declaration: {async update({data}) { calls.push('queued'); t.is(data.processingStatus, 'QUEUED') }},
      declarationProcessingEvent: {async create() { calls.push('event') }}
    }))
    const response = await invoke()
    t.falsy(response.error)
    t.is(response.status, 202)
    t.true(response.body.success)
    t.deepEqual(calls, ['enqueue', 'queued', 'event'])
  })
}
