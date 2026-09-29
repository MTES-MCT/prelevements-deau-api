import test from 'ava'
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import {prisma} from '../../../../db/prisma.js'
import {requireDisposableDatabase} from '../../../../lib/util/test-helpers/disposable-database.js'
import {applyManifest} from '../apply-epidropt.js'
import {applyReviewedManifest, inspectReviewedApplication} from '../apply-reviewed.js'
import {digest, stableId} from '../epidropt.js'

const integration = process.env.DROPT_INTEGRATION_TESTS === '1' ? test.serial : test.skip
const owned = {points: new Set(), users: new Set(), meters: new Set()}
const sign = ({manifestHash, ...payload}) => ({...payload, manifestHash: digest(payload)})
const inIds = values => ({in: [...values]})
const options = {target: 'disposable'}
const evidence = preview => ({target: 'testing', backup: {sha256: 'a'.repeat(64)},
  restore: {success: true, matchesPreflight: true}, reviewedStateHash: preview.stateHash})
let databaseValidated = false

test.before(() => {
  if (process.env.DROPT_INTEGRATION_TESTS !== '1') return
  requireDisposableDatabase()
  databaseValidated = true
})

test.afterEach.always(async () => {
  if (!databaseValidated) return
  await prisma.$transaction(async tx => {
    await tx.meterAllocationVersion.deleteMany({where: {allocation: {compteurId: inIds(owned.meters)}}})
    await tx.meterAllocation.deleteMany({where: {compteurId: inIds(owned.meters)}})
    await tx.meterStream.deleteMany({where: {compteurId: inIds(owned.meters)}})
    await tx.externalReference.deleteMany({where: {OR: [
      {pointPrelevementId: inIds(owned.points)}, {declarantUserId: inIds(owned.users)}, {compteurId: inIds(owned.meters)}
    ]}})
    await tx.pointPrelevement.deleteMany({where: {id: inIds(owned.points)}})
    await tx.user.deleteMany({where: {id: inIds(owned.users)}})
    await tx.compteur.deleteMany({where: {id: inIds(owned.meters)}})
  })
  for (const ids of Object.values(owned)) ids.clear()
})

test.after.always(async () => {
  await prisma.$disconnect()
  await globalThis.pgPool?.end()
})

async function fixture({collector = false, resetMeter = false} = {}) {
  const key = randomUUID()
  const points = [0, 1, 2].map(index => {
    const id = stableId(`reviewed-point:${key}:${index}`)
    owned.points.add(id)
    return {id, key: `${key}:${index}`, sourceId: `dropt-epidropt:point:${key}:${index}`, coordinates: [0.4, 44.6],
      references: [{provider: 'epidropt', externalId: `${key}:${index}`}],
      data: {name: `Reviewed test ${key}:${index}`, flowType: 'PRELEVEMENT', waterBodyType: 'SUPERFICIELLE'}}
  })
  const declarants = points.map((_, index) => {
    const id = stableId(`reviewed-owner:${key}:${index}`)
    owned.users.add(id)
    return {id, key: `${key}:${index}`, sourceId: `dropt-epidropt:preleveur:${key}:${index}`,
      references: [{provider: 'epidropt', externalId: `${key}:${index}`}], emails: [], user: {role: 'DECLARANT', email: null},
      data: {socialReason: `Reviewed farm ${key}:${index}`, preleveurType: 'IRRIGANT', declarationNotificationsEnabled: false}}
  })
  const exploitations = points.map((point, index) => ({id: stableId(`reviewed-exploitation:${key}:${index}`),
    sourceId: `dropt-epidropt:exploitation:${key}:${index}`, pointId: point.id, declarantId: declarants[index].id,
    usageCode: '2', countingCode: `00${index}`, aliases: []}))
  const meterId = stableId(`reviewed-meter:${key}`)
  const allocation = {sourceId: `dropt-rives:allocation:${key}`, compteurId: meterId,
    exploitationId: exploitations[0].id, contractId: `CACG_${key}`, lieuId: key, percentage: '100', additive: false}
  const meter = {id: meterId, serial: `SYNTHETIC-${key}`, provider: 'rives-et-eaux',
    references: [{provider: 'rives-et-eaux', externalId: `SYNTHETIC-${key}`}], allocationSnapshotValidated: true,
    allocationSnapshot: [{key: allocation.sourceId, contractId: allocation.contractId, lieuId: key, percentage: '100', inScope: true}]}
  if (resetMeter) owned.meters.add(meterId)
  const initial = sign({formatVersion: 1, scope: 'epidropt', issues: [], points: points.slice(0, 2),
    declarants: declarants.slice(0, 2), exploitations: exploitations.slice(0, 2),
    meters: resetMeter ? [meter] : [], allocations: resetMeter ? [allocation] : []})
  const seeded = await applyManifest(prisma, initial, {apply: true})
  if (!seeded.complete) throw new Error(JSON.stringify(seeded.executionIssues))
  let collectorId
  if (collector) {
    const existing = await prisma.declarant.findUnique({where: {sourceId: 'dropt-epidropt:collecteur:ougc-dropt'}})
    if (existing) throw new Error('Synthetic test requires its own collector; refusing to alter an existing actor')
    collectorId = randomUUID()
    owned.users.add(collectorId)
    await prisma.user.create({data: {id: collectorId, role: 'DECLARANT', declarant: {create: {
      sourceId: 'dropt-epidropt:collecteur:ougc-dropt', declarantRole: 'COLLECTEUR', socialReason: `Reviewed collector ${key}`
    }}}})
    await prisma.declarantCollecteurExploitation.create({data: {collecteurUserId: collectorId, exploitationId: exploitations[0].id}})
  }
  const plan = {scope: 'epidropt', merges: [{sourcePointId: points[1].id, targetPointId: points[0].id, exploitationMerges: []}],
    retirePointIds: [], retireExploitationIds: [], resetMeterIds: resetMeter ? [meterId] : [], discardMeterVolumes: resetMeter}
  const canonical = {...points[0], references: [...points[0].references, ...points[1].references]}
  const manifest = sign({...initial, points: [canonical, points[2]], declarants,
    exploitations: exploitations.map((item, index) => ({...item, pointId: index < 2 ? points[0].id : points[2].id})),
    reviewedConsolidationPlan: plan})
  return {manifest, initial, collectorId, points, declarants, exploitations, meterId}
}

const inspect = manifest => inspectReviewedApplication(prisma, manifest, undefined, options)

integration('simulation atomique puis application : fusion, nouvel import et droits du collecteur existant uniquement sur les nouvelles exploitations', async t => {
  const {manifest, initial, collectorId, points, exploitations} = await fixture({collector: true})
  const before = await inspect(manifest)
  const oldUsers = await prisma.user.findMany({where: {id: inIds(initial.declarants.map(item => item.id))}, orderBy: {id: 'asc'}})
  const preview = await applyReviewedManifest(prisma, manifest, options)
  t.true(preview.complete, JSON.stringify(preview.executionIssues ?? preview.consolidation.blocked))
  t.false(preview.applied)
  t.is((await inspect(manifest)).stateHash, before.stateHash)
  t.deepEqual(preview.collector.addedExploitationIds, [exploitations[2].id])
  const applied = await applyReviewedManifest(prisma, manifest, {...options, apply: true, expectedReport: preview, backupEvidence: evidence(preview)})
  t.true(applied.applied)
  t.true(applied.verification.complete)
  t.false(applied.activationPerformed)
  t.false(applied.recomputationPerformed)
  t.truthy((await prisma.pointPrelevement.findUnique({where: {id: points[1].id}})).deletedAt)
  t.is((await prisma.declarantPointPrelevement.findUnique({where: {id: exploitations[1].id}})).pointPrelevementId, points[0].id)
  const links = await prisma.declarantCollecteurExploitation.findMany({where: {collecteurUserId: collectorId}, orderBy: {exploitationId: 'asc'}})
  t.deepEqual(links.map(item => item.exploitationId), [exploitations[0].id, exploitations[2].id].sort())
  t.deepEqual(await prisma.user.findMany({where: {id: inIds(initial.declarants.map(item => item.id))}, orderBy: {id: 'asc'}}), oldUsers)
  const replay = await applyReviewedManifest(prisma, manifest, options)
  t.true(replay.complete)
  t.deepEqual(replay.changes, [])
  t.deepEqual(replay.collector.addedExploitationIds, [])
  t.is(replay.consolidation.counts.pointsMerged, 0)
})

integration('une erreur d’import après consolidation annule également fusion, préleveur et point créés', async t => {
  const {manifest: valid} = await fixture()
  const manifest = sign({...valid, exploitations: valid.exploitations.map((item, index) => index === 2 ? {...item, usageCode: 'ABSENT-SYNTHETIC'} : item)})
  const before = await inspect(manifest)
  const result = await applyReviewedManifest(prisma, manifest, options)
  t.false(result.complete)
  t.false(result.applied)
  t.true(result.executionIssues.some(item => item.code === 'USAGE_ABSENT'))
  t.is((await inspect(manifest)).stateHash, before.stateHash)
})

integration('absence de sauvegarde, dérive avant application et plan final différent ne laissent aucune écriture partielle', async t => {
  const {manifest, points} = await fixture()
  const preview = await applyReviewedManifest(prisma, manifest, options)
  t.true(preview.complete)
  await t.throwsAsync(() => applyReviewedManifest(prisma, manifest, {...options, apply: true, expectedReport: preview}),
    {message: 'REVIEWED_VERIFIED_RESTORED_BACKUP_REQUIRED'})
  t.is((await inspect(manifest)).stateHash, preview.stateHash)
  await t.throwsAsync(() => applyReviewedManifest(prisma, manifest, {...options, apply: true,
    expectedReport: {...preview, planHash: 'b'.repeat(64)}, backupEvidence: evidence(preview)}),
  {message: 'REVIEWED_PLAN_CHANGED_SINCE_SIMULATION'})
  t.is((await inspect(manifest)).stateHash, preview.stateHash)
  await prisma.pointPrelevement.update({where: {id: points[0].id}, data: {comment: 'Synthetic manual correction'}})
  const changed = await inspect(manifest)
  await t.throwsAsync(() => applyReviewedManifest(prisma, manifest, {...options, apply: true,
    expectedReport: preview, backupEvidence: evidence(preview)}), {message: 'REVIEWED_STATE_CHANGED_SINCE_SIMULATION'})
  t.is((await inspect(manifest)).stateHash, changed.stateHash)
})

integration('reset de compteur atomique et rejouable : le ledger conserve les allocations et versions reconstruites', async t => {
  const {manifest, meterId} = await fixture({resetMeter: true})
  const versions = () => prisma.meterAllocationVersion.findMany({where: {allocation: {compteurId: meterId}}, orderBy: {id: 'asc'}})
  const originalVersions = await versions()
  const preview = await applyReviewedManifest(prisma, manifest, options)
  t.true(preview.complete, JSON.stringify(preview.executionIssues ?? preview.consolidation.blocked))
  t.is(preview.consolidation.counts.metersReset, 1)
  t.deepEqual(await versions(), originalVersions)
  const applied = await applyReviewedManifest(prisma, manifest, {...options, apply: true,
    expectedReport: preview, backupEvidence: evidence(preview)})
  t.true(applied.applied)
  const afterVersions = await versions()
  t.is(afterVersions.length, 1)
  t.not(afterVersions[0].id, originalVersions[0].id)
  t.false(afterVersions[0].enabled)
  t.is(afterVersions[0].startDate, null)
  const stream = await prisma.meterStream.findFirst({where: {compteurId: meterId}})
  t.false(stream.enabled)
  t.is(stream.activatedAt, null)
  t.is(await prisma.externalReference.count({where: {provider: 'pe-import-reset', compteurId: meterId}}), 1)
  const replay = await applyReviewedManifest(prisma, manifest, options)
  t.true(replay.complete, JSON.stringify(replay.executionIssues ?? replay.consolidation.blocked))
  t.is(replay.consolidation.counts.metersReset, 0)
  t.is(replay.consolidation.counts.metersResetAlreadyApplied, 1)
  t.deepEqual(replay.changes, [])
  const reapplied = await applyReviewedManifest(prisma, manifest, {...options, apply: true,
    expectedReport: replay, backupEvidence: evidence(replay)})
  t.true(reapplied.applied)
  t.deepEqual(await versions(), afterVersions)
  t.is(await prisma.externalReference.count({where: {provider: 'pe-import-reset', compteurId: meterId}}), 1)
})
