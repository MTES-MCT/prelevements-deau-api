import test from 'ava'
import process from 'node:process'
import {randomBytes} from 'node:crypto'
import {Prisma} from '@prisma/client'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {previewDeclarantsLastDeclarationAt, refreshDeclarantsLastDeclarationAt} from '../declarant.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => {
  await prisma.$disconnect()
  await globalThis.pgPool?.end()
})

const date = day => new Date(`2026-07-${String(day).padStart(2, '0')}T12:34:56.789Z`)

async function withFixture(run) {
  const rollback = new Error('ROLLBACK_SYNTHETIC_ACTIVITY_FIXTURE')
  try {
    await prisma.$transaction(async tx => {
      const users = await Promise.all(Array.from({length: 6}, (_, index) => tx.user.create({data: {
        role: 'DECLARANT',
        declarant: {create: index === 2 ? {declarantRole: 'COLLECTEUR'} : {preleveurType: 'IRRIGANT'}}
      }})))
      const usage = await tx.sandreWaterUse.findUniqueOrThrow({where: {code: '2'}})
      await run({tx, ids: users.map(user => user.id), usageId: usage.id})
      throw rollback
    }, {timeout: 20_000})
  } catch (error) {
    if (error !== rollback) throw error
  }
}

async function source(f, {declaration, chunks = [], ...data}) {
  const linkedDeclaration = declaration && await f.tx.declaration.create({data: {
    code: randomBytes(3).toString('hex'),
    type: 'synthetic',
    waterWithdrawalType: 'synthetic',
    ...declaration
  }})
  return f.tx.source.create({data: {
    type: 'API', status: 'COMPLETED', createdAt: date(10),
    ...data,
    ...(linkedDeclaration ? {declarationId: linkedDeclaration.id} : {}),
    chunks: {create: chunks.map(chunk => ({
      usageId: f.usageId, minDate: date(1), maxDate: date(2), ...chunk
    }))}
  }})
}

// Keep the previous SQL as an independent equivalence oracle, including its
// declaration actors inside EXISTS and its distinct declaration/API date rules.
function previousActivityQuery(ids) {
  return Prisma.sql`
    SELECT d."userId", (
      SELECT MAX(CASE
        WHEN s.type = 'DECLARATION'::"SourceType" THEN declaration."createdAt"
        ELSE s."createdAt"
      END)
      FROM "Source" s
      LEFT JOIN "Declaration" declaration ON declaration.id = s."declarationId"
      WHERE s.type IN ('DECLARATION'::"SourceType", 'API'::"SourceType")
        AND s.status = 'COMPLETED'::"SourceStatus"
        AND EXISTS (
          SELECT 1 FROM "Chunk" chunk
          WHERE chunk."sourceId" = s.id
            AND chunk."instructionStatus" <> 'REJECTED'::"ChunkInstructionStatus"
            AND (
              declaration."declarantUserId" = d."userId"
              OR declaration."createdByDeclarantUserId" = d."userId"
              OR chunk."preleveurUserId" = d."userId"
              OR chunk."submittedByDeclarantUserId" = d."userId"
              OR chunk."collecteurUserId" = d."userId"
            )
        )
    ) AS "lastDeclarationAt"
    FROM "Declarant" d
    WHERE d."userId" IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))})
    ORDER BY d."userId"
  `
}

async function assertActivity(t, f, expectedDates, ids = f.ids) {
  const expected = ids.map((userId, index) => ({userId, lastDeclarationAt: expectedDates[index]}))
    .sort((a, b) => a.userId.localeCompare(b.userId))
  t.deepEqual(await f.tx.$queryRaw(previousActivityQuery(ids)), expected)
  const before = await f.tx.declarant.findMany({
    where: {userId: {in: ids}}, select: {userId: true, lastDeclarationAt: true}, orderBy: {userId: 'asc'}
  })
  const preview = await previewDeclarantsLastDeclarationAt(ids, {client: f.tx})
  const expectedPreview = expected.flatMap((row, index) => {
    const currentLastDeclarationAt = before[index].lastDeclarationAt
    return currentLastDeclarationAt?.getTime() === row.lastDeclarationAt?.getTime()
      ? [] : [{...row, currentLastDeclarationAt}]
  })
  t.deepEqual(preview, expectedPreview)
  await refreshDeclarantsLastDeclarationAt(ids, {client: f.tx})
  t.deepEqual(await f.tx.declarant.findMany({
    where: {userId: {in: ids}}, select: {userId: true, lastDeclarationAt: true}, orderBy: {userId: 'asc'}
  }), expected)
  t.deepEqual(await previewDeclarantsLastDeclarationAt(ids, {client: f.tx}), [])
  t.deepEqual(await refreshDeclarantsLastDeclarationAt(ids, {client: f.tx}), [])
}

integration('activity SQL retains each chunk actor and every non-rejected status', async t => {
  await withFixture(async f => {
    await source(f, {chunks: [
      {preleveurUserId: f.ids[0], instructionStatus: 'PENDING'},
      {submittedByDeclarantUserId: f.ids[1], instructionStatus: 'VALIDATED'},
      {collecteurUserId: f.ids[2], instructionStatus: 'AUTOMATICALLY_VALIDATED'}
    ]})
    await assertActivity(t, f, [date(10), date(10), date(10), null, null, null])
  })
})

integration('declaration owner and author retain the declaration timestamp independently of chunk actors and processing state', async t => {
  await withFixture(async f => {
    await source(f, {
      type: 'DECLARATION', createdAt: date(20), globalInstructionStatus: 'REJECTED',
      declaration: {
        declarantUserId: f.ids[0], createdByDeclarantUserId: f.ids[2],
        createdAt: date(3), consolidatedAt: date(25), processingStatus: 'FAILED'
      },
      chunks: [{preleveurUserId: f.ids[1]}]
    })
    await assertActivity(t, f, [date(3), date(3), date(3), null, null, null])
  })
})

integration('API sources linked to declarations retain both declaration actors but use the source timestamp', async t => {
  await withFixture(async f => {
    await source(f, {
      createdAt: date(4),
      declaration: {declarantUserId: f.ids[0], createdByDeclarantUserId: f.ids[2], createdAt: date(20)},
      chunks: [{submittedByDeclarantUserId: f.ids[1]}]
    })
    await assertActivity(t, f, [date(4), date(4), date(4), null, null, null])
  })
})

integration('unrelated valid chunks do not count a rejected actor but still count linked declaration actors', async t => {
  await withFixture(async f => {
    await source(f, {
      type: 'DECLARATION',
      declaration: {declarantUserId: f.ids[0], createdByDeclarantUserId: f.ids[2], createdAt: date(4)},
      chunks: [
        {preleveurUserId: f.ids[1], instructionStatus: 'REJECTED'},
        {preleveurUserId: f.ids[3], instructionStatus: 'VALIDATED'}
      ]
    })
    await source(f, {
      type: 'DECLARATION',
      declaration: {declarantUserId: f.ids[0], createdByDeclarantUserId: f.ids[2], createdAt: date(25)},
      chunks: [{preleveurUserId: f.ids[3], instructionStatus: 'REJECTED'}]
    })
    await assertActivity(t, f, [date(4), null, date(4), date(4), null, null])
  })
})

integration('excluded sources, missing chunks and null declaration dates clear stale activity without changing users outside scope', async t => {
  await withFixture(async f => {
    const chunks = [{preleveurUserId: f.ids[0]}]
    await Promise.all(['PENDING', 'PROCESSING', 'FAILED'].map(status => source(f, {status, chunks})))
    await source(f, {type: 'BATCH', chunks})
    await source(f, {type: 'DECLARATION', chunks})
    await source(f, {chunks: [{preleveurUserId: f.ids[0], instructionStatus: 'REJECTED'}]})
    await source(f, {
      type: 'DECLARATION',
      declaration: {declarantUserId: f.ids[0], createdByDeclarantUserId: f.ids[1], createdAt: date(25)}
    })
    await f.tx.declarant.updateMany({where: {userId: {in: [f.ids[0], f.ids[5]]}}, data: {lastDeclarationAt: date(30)}})
    await assertActivity(t, f, [null, null, null, null, null], f.ids.slice(0, 5))
    t.is((await f.tx.declarant.findUniqueOrThrow({where: {userId: f.ids[5]}})).lastDeclarationAt.getTime(), date(30).getTime())
  })
})

integration('deduplicated candidates keep the maximum date and global preview agrees with scoped refresh', async t => {
  await withFixture(async f => {
    await source(f, {
      type: 'DECLARATION', createdAt: date(28),
      declaration: {declarantUserId: f.ids[0], createdByDeclarantUserId: f.ids[0], createdAt: date(3)},
      chunks: [
        {preleveurUserId: f.ids[0], submittedByDeclarantUserId: f.ids[0], collecteurUserId: f.ids[0]},
        {preleveurUserId: f.ids[0]}
      ]
    })
    await source(f, {createdAt: date(8), chunks: [{preleveurUserId: f.ids[0]}]})
    await source(f, {createdAt: date(20), chunks: [{preleveurUserId: f.ids[1]}]})
    const globalPreview = await previewDeclarantsLastDeclarationAt([], {client: f.tx})
    t.deepEqual(globalPreview.filter(row => f.ids.includes(row.userId)),
      await previewDeclarantsLastDeclarationAt([...f.ids, f.ids[0]], {client: f.tx}))
    await assertActivity(t, f, [date(8), date(20), null, null, null, null])
    t.deepEqual(await refreshDeclarantsLastDeclarationAt([], {client: f.tx}), [])
  })
})
