import {execFile} from 'node:child_process'
import process from 'node:process'
import {promisify} from 'node:util'
import test from 'ava'

const execute = promisify(execFile)
const handlerModule = new URL('../meters.js', import.meta.url).href
const prismaModule = new URL('../../../db/prisma.js', import.meta.url).href

test('l’ingestion borne ses spans sans supprimer le parent HTTP, les erreurs ou les autres routes', async t => {
  // A fresh SDK/process avoids affecting tracing in other test workers. The
  // transport and transaction are in-memory: no credentials, network or DB.
  const source = `
    import assert from 'node:assert/strict'
    import * as Sentry from '@sentry/node'
    const events = []
    Sentry.init({
      dsn: 'https://public@example.invalid/1',
      defaultIntegrations: false,
      tracesSampleRate: 1,
      transport: () => ({
        send: async envelope => {
          for (const [header, event] of envelope[1]) {
            if (header.type === 'transaction' || header.type === 'event') events.push(event)
          }
          return {}
        },
        flush: async () => true
      })
    })
    const {prisma} = await import(${JSON.stringify(prismaModule)})
    const {ingestMeterBatchHandler} = await import(${JSON.stringify(handlerModule)})
    globalThis.pgPool.connect = () => { throw new Error('Database access forbidden in tracing test') }
    const payload = {
      provider: 'sample-provider', scope: 'sample-scope', batchId: 'tracing-test',
      windowStart: '2026-01-01T00:00:00Z', windowEnd: '2026-01-02T00:00:00Z',
      fetchedAt: '2026-01-02T01:00:00Z', complete: true, mode: 'LIVE', readings: []
    }
    const account = {id: '00000000-0000-4000-8000-000000000001'}
    const result = {persisted: true, counts: {received: 0}, checkpoint: payload.windowEnd}
    const failure = Object.assign(new Error('fixture transaction failure'), {status: 409})
    let fail = false
    let transactionCalls = 0
    let suppressedRecording = 0
    let neighbouringRecording = 0
    let resume
    let entered
    const waiting = new Promise(resolve => { resume = resolve })
    const started = new Promise(resolve => { entered = resolve })
    prisma.$transaction = async (_callback, options) => {
      transactionCalls++
      assert.deepEqual(options, {timeout: 120000, maxWait: 20000})
      if (transactionCalls === 1) {
        entered()
        await waiting
      }
      await Promise.resolve()
      for (let index = 0; index < 3000; index++) {
        Sentry.startSpan({name: 'ingestion SQL', op: 'db'}, span => {
          if (span.isRecording()) suppressedRecording++
        })
      }
      if (fail) throw failure
      return result
    }
    let sent
    const response = {send: value => { sent = value }}
    const ingest = Sentry.startSpan({name: 'POST meter ingestion', op: 'http.server'}, async parent => {
      assert.equal(parent.isRecording(), true)
      await ingestMeterBatchHandler({body: payload, serviceAccount: account}, response)
      assert.equal(Sentry.getSpanDescendants(parent).length, 1)
    })
    await started
    await Sentry.startSpan({name: 'GET neighbouring route', op: 'http.server'}, async () => {
      await Promise.resolve()
      Sentry.startSpan({name: 'ordinary SQL', op: 'db'}, span => {
        if (span.isRecording()) neighbouringRecording++
      })
    })
    resume()
    await ingest
    assert.equal(sent, result)
    fail = true
    await Sentry.startSpan({name: 'POST failing ingestion', op: 'http.server'}, async () => {
      await assert.rejects(
        ingestMeterBatchHandler({body: payload, user: {id: account.id, role: 'ADMIN'}}, {
          send: () => assert.fail('An error must not send a successful response')
        }),
        error => error === failure && error.status === 409
      )
      Sentry.captureException(failure)
    })
    await Sentry.flush(2000)
    const transactions = events.filter(event => event.type === 'transaction')
    const errors = events.filter(event => !event.type)
    console.log(JSON.stringify({
      transactionCalls, suppressedRecording, neighbouringRecording,
      transactions: transactions.map(event => ({
        name: event.transaction,
        spans: (event.spans || []).map(span => span.description)
      })),
      errors: errors.flatMap(event => event.exception?.values?.map(value => value.value) || [])
    }))
    await prisma.$disconnect()
    await globalThis.pgPool.end()
    await Sentry.close(2000)
  `
  const {stdout} = await execute(process.execPath, ['--input-type=module', '-e', source], {
    env: {NODE_ENV: 'test', DATABASE_URL: ''}, timeout: 20_000
  })
  const result = JSON.parse(stdout)
  t.is(result.transactionCalls, 2)
  t.is(result.suppressedRecording, 0)
  t.is(result.neighbouringRecording, 1)
  t.deepEqual(result.transactions.toSorted((left, right) => left.name.localeCompare(right.name)), [
    {name: 'GET neighbouring route', spans: ['ordinary SQL']},
    {name: 'POST failing ingestion', spans: []},
    {name: 'POST meter ingestion', spans: []}
  ])
  t.deepEqual(result.errors, ['fixture transaction failure'])
})
