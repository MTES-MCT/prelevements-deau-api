import {randomUUID} from 'node:crypto'
import process from 'node:process'
import test from 'ava'
import {prisma, pgPool} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {processDeclarationReceipts} from '../declaration-receipt-delivery.js'

const integration = process.env.METER_INTEGRATION_TESTS === '1' ? test.serial : test.skip
test.before(() => { if (process.env.METER_INTEGRATION_TESTS === '1') requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await pgPool.end() })

async function fixture(t, revisions = [0, 1]) {
  const owner = await prisma.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT'}}}})
  t.teardown(() => prisma.user.delete({where: {id: owner.id}}))
  const declaration = await prisma.declaration.create({data: {code: randomUUID().slice(0, 6),
    type: 'QUICK', waterWithdrawalType: 'PRELEVEMENT', declarantUserId: owner.id}})
  // Keep this drain isolated from records created at the actual current time by other suites.
  let now = new Date('2000-04-01T00:00:00Z')
  const rows = revisions.map(revision => ({declarationId: declaration.id, revision,
    kind: revision === 0 ? 'QUICK_CREATED' : 'QUICK_UPDATED', recipientUserId: owner.id,
    recipientEmail: 'author@example.test', snapshot: {revision}, createdAt: now, nextAttemptAt: now}))
  await prisma.declarationReceipt.createMany({data: rows})
  const sent = []
  const logs = []
  const logger = {warn: message => logs.push(message)}
  const options = {client: prisma, config: {frontUrl: 'https://front.example.test'}, logger,
    clock: () => now, access: async () => ({deliver: true, canEdit: true}),
    render: async (receipt, {canEdit}) => ({subject: 'Confirmation', html: `Révision ${receipt.snapshot.revision}, lien ${canEdit}`}),
    send: async (receipt, content) => sent.push({revision: receipt.revision, html: content.html})}
  return {
    declaration, rows, sent, logs, options,
    run: overrides => processDeclarationReceipts({...options, ...overrides}),
    advance(minutes) { now = new Date(now.getTime() + minutes * 60_000) },
    states: () => prisma.declarationReceipt.findMany({where: {declarationId: declaration.id}, orderBy: {revision: 'asc'}})
  }
}

integration('les deux commits attendent le relais puis partent dans l’ordre, une fois chacun sous concurrence', async t => {
  const f = await fixture(t)
  await t.throwsAsync(prisma.declarationReceipt.create({data: f.rows[0]}), {code: 'P2002'})
  const disabled = await f.run({config: null})
  t.false(disabled.configured)
  t.true(disabled.pending >= 2)
  t.true(f.logs.some(message => message.includes('DECLARATION_RECEIPT_SMTP_HOST')))

  const entered = Promise.withResolvers(), resume = Promise.withResolvers()
  const first = f.run({send: async (receipt, content) => {
    if (!receipt.revision) { entered.resolve(); await resume.promise }
    await f.options.send(receipt, content)
  }})
  try {
    await entered.promise
    t.is((await f.run()).processed, 0)
  } finally {
    resume.resolve()
    await first
  }
  t.is((await f.run()).processed, 0)
  t.deepEqual(f.sent.map(item => item.revision), [0, 1])
  t.deepEqual((await f.states()).map(row => [row.status, row.attempts]), [['SENT', 1], ['SENT', 1]])
})

integration('un refus temporaire retarde la révision suivante et les tentatives sont bornées', async t => {
  const f = await fixture(t)
  const send = async (receipt, content) => {
    if (receipt.revision === 0) throw Object.assign(new Error('author@example.test'), {responseCode: 421})
    await f.options.send(receipt, content)
  }
  await f.run({send})
  t.is((await f.run({send})).processed, 0)
  t.deepEqual((await f.states()).map(row => [row.status, row.attempts]), [['PENDING', 1], ['PENDING', 0]])
  f.advance(1)
  await f.run({send})
  f.advance(5)
  await f.run({send})
  t.deepEqual((await f.states()).map(row => [row.status, row.attempts, row.failureCode]),
    [['FAILED', 3, 'SMTP_RETRY'], ['SENT', 1, null]])
  t.deepEqual(f.sent.map(item => item.revision), [1])
  t.false(f.logs.join(' ').includes('author@'))
})

integration('une préparation réattribuée empêche le précédent worker d’émettre', async t => {
  const f = await fixture(t, [0])
  const entered = Promise.withResolvers(), resume = Promise.withResolvers()
  const old = f.run({render: async (...args) => {
    entered.resolve()
    await resume.promise
    return f.options.render(...args)
  }})
  try {
    await entered.promise
    f.advance(6)
    await f.run()
  } finally {
    resume.resolve()
    await old
  }
  t.is(f.sent.length, 1)
  t.is((await f.states())[0].attempts, 2)
})

integration('après une acceptation SMTP dont le marquage échoue, la reprise ne réémet pas le mail', async t => {
  const f = await fixture(t)
  const client = prisma.$extends({query: {declarationReceipt: {updateMany({args, query}) {
    if (args.data.status === 'SENT') throw new Error('Panne de base simulée')
    return query(args)
  }}}})
  await t.throwsAsync(f.run({client}), {message: 'Panne de base simulée'})
  t.is((await f.run()).processed, 0)
  f.advance(16)
  await f.run()
  t.deepEqual(f.sent.map(item => item.revision), [0, 1])
  t.deepEqual((await f.states()).map(row => [row.status, row.failureCode]), [['UNKNOWN', 'SMTP_UNKNOWN'], ['SENT', null]])
})

integration('un destinataire devenu indisponible est ignoré, le droit de correction est revérifié au moment du rendu', async t => {
  const f = await fixture(t)
  await f.run({access: async (_client, receipt) => ({deliver: receipt.revision > 0, canEdit: false})})
  t.deepEqual(f.sent, [{revision: 1, html: 'Révision 1, lien false'}])
  t.deepEqual((await f.states()).map(row => row.status), ['SKIPPED', 'SENT'])
})
