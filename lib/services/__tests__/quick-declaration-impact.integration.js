import {randomUUID} from 'node:crypto'
import process from 'node:process'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {captureQuickEffectiveReadings, captureQuickVolumes, compareQuickVolumes, findQuickIndexWarnings, findQuickMixedWarnings, getQuickPreviousReadings, reconstructQuickVolumes, restoredQuickReadingWarnings} from '../quick-declaration-impact.js'
import {resolveHistoricalQuickExploitation} from '../quick-declaration-series.js'
import {findConflictingChunkValuesForIncomingChunkValues} from '../chunk-value-conflicts.js'
import {reconstructVolumesFromIndexInTransaction} from '../volumes-from-index.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

const date = day => new Date(Date.UTC(2026, 0, day))
const label = day => date(day).toISOString().slice(0, 10)

async function withTimeline(run) {
  const rollback = new Error('ROLLBACK_SYNTHETIC_TIMELINE')
  try {
    await prisma.$transaction(async tx => {
      const owner = await tx.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT'}}}})
      const point = await tx.pointPrelevement.create({data: {name: 'Pompage synthétique', waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'}})
      const usage = await tx.sandreWaterUse.findUniqueOrThrow({where: {code: '2'}})
      const exploitation = await tx.declarantPointPrelevement.create({data: {declarantUserId: owner.id, pointPrelevementId: point.id, usageId: usage.id, status: 'EN_ACTIVITE'}})
      const entry = {pointPrelevementId: point.id, exploitationId: exploitation.id}
      const scope = {declarantUserId: owner.id, entries: [entry]}
      async function add(metric, day, lastDay, value, {declarationId, ...overrides} = {}) {
        const index = metric === 'index' || metric === "relevé d'index"
        const periodStart = date(day)
        const periodEnd = index ? new Date(+periodStart + 900000) : date(lastDay + 1)
        const source = await tx.source.create({data: {type: 'DECLARATION', status: 'COMPLETED', declarationId, metadata: {manualQuickDeclaration: true}}})
        const chunk = await tx.chunk.create({data: {...entry, preleveurUserId: owner.id, usageId: usage.id, sourceId: source.id,
          instructionStatus: 'VALIDATED', minDate: periodStart, maxDate: date(lastDay), ...overrides,
          chunkValues: {create: {periodStart, periodEnd, metricTypeCode: metric, value, frequency: index ? 'instant' : '1 day'}}
        }, include: {chunkValues: true}})
        return chunk.chunkValues[0]
      }

      const capture = () => captureQuickVolumes(tx, scope)
      const recalculate = () => reconstructQuickVolumes(tx, scope)
      const neighborWarnings = (day, value) => findQuickIndexWarnings(tx, {...scope, entries: [{...entry, readingDate: label(day), value}]})
      const mixedWarnings = fields => findQuickMixedWarnings(tx, {...scope, entries: [{...entry, ...fields}]})
      await run({tx, entry, scope, usage, add, capture, recalculate, neighborWarnings, mixedWarnings})
      throw rollback
    }, {timeout: 60000})
  } catch (error) {
    if (error !== rollback) throw error
  }
}

const periods = changes => changes.map(row => [row.periodStartDate, row.periodEndDate, row.before, row.after])

integration('le déplacement, l’insertion et la suppression d’un index donnent toutes les périodes ajoutées et retirées', async t => {
  await withTimeline(async ({tx, add, capture, recalculate, neighborWarnings}) => {
    await add("relevé d'index", 1, 1, 100)
    await recalculate()
    t.deepEqual(await capture(), [])
    await add('index', 11, 11, 150)
    await recalculate()
    const original = await capture()
    const inserted = await add('index', 6, 6, 130)
    await recalculate()
    const split = await capture()
    t.deepEqual(periods(compareQuickVolumes(original, split)), [
      [label(1), label(6), null, 30], [label(1), label(11), 50, null], [label(6), label(11), null, 20]
    ])
    t.deepEqual(await neighborWarnings(6, 130), [])
    await tx.chunkValue.update({where: {id: inserted.id}, data: {value: 90, periodStart: date(16), periodEnd: new Date(+date(16) + 900000)}})
    await recalculate()
    const moved = await capture()
    const warnings = await neighborWarnings(16, 90)
    t.deepEqual(warnings.map(row => [row.code, row.neighborDate, row.neighborValue]), [['INDEX_BELOW_PREVIOUS', label(11), 150]])
    t.deepEqual(periods(compareQuickVolumes(split, moved)), [
      [label(1), label(6), 30, null], [label(1), label(11), null, 50], [label(6), label(11), 20, null], [label(11), label(16), null, 90]
    ])
    t.deepEqual((await neighborWarnings(6, 170)).map(row => [row.code, row.neighborDate]), [['INDEX_ABOVE_NEXT', label(11)]])
    await tx.chunkValue.delete({where: {id: inserted.id}})
    await recalculate()
    t.deepEqual(compareQuickVolumes(original, await capture()), [])
  })
})

integration('un volume direct partiel prime au recalcul, les jours adjacents et les exploitations sans identifiant restent indépendants', async t => {
  await withTimeline(async ({tx, entry, scope, add, capture, recalculate, mixedWarnings, neighborWarnings}) => {
    await add('index', 1, 1, 0)
    await add('index', 11, 11, 200)
    await add('index', 21, 21, 200)
    await add('index', 5, 5, 999, {exploitationId: null})
    await add('volume', 3, 17, 999, {exploitationId: null})
    await add('volume', 1, 7, 800, {calculationStrategy: 'METER'})
    await add('volume', 1, 7, 700, {instructionStatus: 'REJECTED'})
    await recalculate()
    t.deepEqual(periods(compareQuickVolumes([], await capture())), [
      [label(1), label(11), null, 200], [label(11), label(21), null, 0]
    ])
    t.deepEqual(await neighborWarnings(5, 20), [])
    const ordinary = await capture()
    const direct = await add('volume prélevé', 11, 12, 7)
    await recalculate()
    const mixed = await capture()
    t.deepEqual(periods(compareQuickVolumes(ordinary, mixed)), [[label(11), label(12), null, 7], [label(11), label(21), 0, null]])
    const warnings = await mixedWarnings({periodStartDate: label(11), periodEndDate: label(12)})
    t.deepEqual(warnings.map(row => row.code), ['DIRECT_VOLUME_PRIORITY'])
    t.true(warnings[0].message.includes('11/01/2026 et du 21/01/2026'))
    t.deepEqual((await mixedWarnings({readingDate: label(11), value: 200})).map(row => row.message), warnings.map(row => row.message))
    t.deepEqual(await mixedWarnings({readingDate: label(1), value: 0}), [])
    await reconstructVolumesFromIndexInTransaction(tx, entry.pointPrelevementId)
    t.deepEqual(compareQuickVolumes(mixed, await capture()), [])
    const legacy = await captureQuickVolumes(tx, {...scope, entries: [{...entry, exploitationId: null}]})
    t.deepEqual(legacy.map(row => Number(row.volume)), [999])
    await tx.chunkValue.update({where: {id: direct.id}, data: {periodStart: date(22), periodEnd: date(24)}})
    await recalculate()
    t.deepEqual(await mixedWarnings({periodStartDate: label(22), periodEndDate: label(23)}), [])
    await tx.chunkValue.delete({where: {id: direct.id}})
    await recalculate()
    t.deepEqual(compareQuickVolumes(ordinary, await capture()), [])
  })
})

integration('l’index instantané historique rejoint uniquement la série prouvée par le dossier et ses dates', async t => {
  await withTimeline(async ({tx, entry, scope, usage, add, capture, recalculate, neighborWarnings}) => {
    const other = await tx.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT'}}}})
    const collector = await tx.user.create({data: {role: 'DECLARANT', declarant: {create: {declarantRole: 'COLLECTEUR'}}}})
    const otherExploitation = await tx.declarantPointPrelevement.create({data: {
      declarantUserId: other.id, pointPrelevementId: entry.pointPrelevementId, usageId: usage.id, status: 'EN_ACTIVITE'
    }})
    async function legacyReading(userId, reading) {
      const declaration = await tx.declaration.create({data: {code: randomUUID().slice(0, 6), declarantUserId: userId,
        createdByDeclarantUserId: collector.id, type: 'quick-declaration', dataSourceType: 'MANUAL', waterWithdrawalType: 'unknown'}})
      const row = await add("relevé d'index", 1, 1, reading, {preleveurUserId: null, exploitationId: null, declarationId: declaration.id})
      // The period constraint is NOT VALID for grandfathered rows. A value-level instant
      // flag lets this fixture represent that interval without changing a database constraint.
      return tx.chunkValue.update({where: {id: row.id}, data: {periodEnd: date(1), createdAt: date(1), metadata: {nativeTemporal: true}}})
    }
    const historic = await legacyReading(scope.declarantUserId, 100)
    await legacyReading(other.id, 999)
    await add('index', 11, 11, 170)
    await recalculate()
    t.deepEqual(periods(compareQuickVolumes([], await capture())), [[label(1), label(11), null, 70]])
    const ids = [randomUUID(), randomUUID(), randomUUID()]
    const prev = await getQuickPreviousReadings(tx, {...scope, entries: [
      {...entry, id: ids[0], readingDate: label(1), value: 10},
      {...entry, id: ids[1], readingDate: label(11), value: 10},
      {...entry, id: ids[2], periodStartDate: label(10), periodEndDate: label(11), value: 15}
    ]})
    t.deepEqual([...prev], [[ids[1], {date: label(1), value: 100, unit: 'm³'}]])
    const [warn] = await neighborWarnings(6, 90)
    t.deepEqual([warn.neighborValue, warn.neighborDate], [100, label(1)])
    const conflicts = await findConflictingChunkValuesForIncomingChunkValues({client: tx, includeQuickLegacyActor: true,
      preleveurUserId: scope.declarantUserId, ...entry, valueRows: [{metricTypeCode: 'index', periodStart: date(1), periodEnd: new Date(+date(1) + 900000)}]})
    t.deepEqual(conflicts.map(row => [row.chunkValueId, row.effectiveExploitationId]), [[historic.id, entry.exploitationId]])
    const sameDay = await add('index', 1, 1, 120)
    await recalculate()
    t.deepEqual(periods(compareQuickVolumes([], await capture())), [[label(1), label(11), null, 50]])
    await tx.chunkValue.delete({where: {id: sameDay.id}})
    await reconstructVolumesFromIndexInTransaction(tx, entry.pointPrelevementId, {exploitationId: entry.exploitationId})
    t.deepEqual(periods(compareQuickVolumes([], await capture())), [[label(1), label(11), null, 70]])
    t.deepEqual(await captureQuickVolumes(tx, {declarantUserId: other.id, entries: [{...entry, exploitationId: otherExploitation.id}]}), [])
    await tx.declarantPointPrelevement.update({where: {id: entry.exploitationId}, data: {startDate: date(1)}})
    const identity = {pointPrelevementId: entry.pointPrelevementId, declarantUserId: scope.declarantUserId}
    t.is(await resolveHistoricalQuickExploitation(tx, {...identity, periodStartDate: label(1), periodEndDate: label(10)}), entry.exploitationId)
    t.is(await resolveHistoricalQuickExploitation(tx, {...identity, periodStartDate: '2025-12-31', periodEndDate: label(1)}), null)
  })
})

integration('un ancien relevé isolé réactivé apparaît dans le bilan même sans volume', async t => {
  await withTimeline(async ({tx, entry, scope, add, capture, recalculate}) => {
    const day = {...entry, readingDate: label(3)}
    const effective = () => captureQuickEffectiveReadings(tx, {...scope, entries: [day]})
    const historic = await add('index', 3, 3, 12)
    await tx.chunkValue.update({where: {id: historic.id}, data: {createdAt: date(3)}})
    const latest = await add('index', 3, 3, 200)
    const before = await effective()
    t.deepEqual(restoredQuickReadingWarnings(before, await effective()), [])
    await tx.chunkValue.delete({where: {id: latest.id}})
    await recalculate()
    t.deepEqual(await capture(), [])
    const [restored] = restoredQuickReadingWarnings(before, await effective())
    t.deepEqual([restored.code, restored.readingDate, restored.value], ['PREVIOUS_INDEX_RESTORED', label(3), 12])
    await tx.chunkValue.delete({where: {id: historic.id}})
    t.deepEqual(restoredQuickReadingWarnings(before, await effective()), [])
    await add('index', 3, 3, 12)
    t.deepEqual(restoredQuickReadingWarnings(before, await effective()), [])
  })
})

integration('l’index du 1er au 6 et le direct inclusif du 1er au 6 sont comparés sur une seule ligne', async t => {
  await withTimeline(async ({tx, add, capture, recalculate}) => {
    await add('index', 1, 1, 10)
    await add('index', 6, 6, 50)
    await recalculate()
    const calculated = await capture()
    const direct = await add('volume', 1, 6, 40)
    await recalculate()
    const sameDays = compareQuickVolumes(calculated, await capture())
    t.deepEqual(periods(sameDays), [[label(1), label(6), 40, 40]])
    t.deepEqual(sameDays.map(r => [r.beforeKind, r.afterKind]), [['COMPUTED','DECLARED']])

    await tx.chunkValue.update({where: {id: direct.id}, data: {periodEnd: date(6)}})
    await recalculate()
    t.deepEqual(periods(compareQuickVolumes(calculated, await capture())), [
      [label(1), label(5), null, 40], [label(1), label(6), 40, null]
    ])
  })
})
