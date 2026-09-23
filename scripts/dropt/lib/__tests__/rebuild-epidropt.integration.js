import test from 'ava'
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import {prisma} from '../../../../db/prisma.js'
import {ingestMeterBatch} from '../../../../lib/services/meter-ingestion.js'
import {requireDisposableDatabase} from '../../../../lib/util/test-helpers/disposable-database.js'
import {applyManifest} from '../apply-epidropt.js'
import {digest, stableId} from '../epidropt.js'
import {assertRebuildTarget, inspectRebuildScope, rebuildManifest, recomputeRebuiltManifest} from '../rebuild-epidropt.js'

const integration = process.env.DROPT_INTEGRATION_TESTS === '1' ? test.serial : test.skip
const owned = {points: new Set(), owners: new Set(), meters: new Set(), accounts: new Set(), batches: new Set()}
let safe = false
const signed = ({manifestHash, ...manifest}) => ({...manifest, manifestHash: digest(manifest)})
const inIds = set => ({in: [...set]})

test.before(() => {
  if (process.env.DROPT_INTEGRATION_TESTS !== '1') return
  requireDisposableDatabase()
  safe = true
})
test.afterEach.always(async () => {
  if (!safe) return
  await prisma.$transaction(async tx => {
    const compteurId = inIds(owned.meters)
    const pointPrelevementId = inIds(owned.points)
    const publications = await tx.meterPublication.findMany({where: {compteurId}, select: {sourceId: true}})
    await tx.meterVolumeContribution.deleteMany({where: {publication: {compteurId}}})
    await tx.meterPublication.deleteMany({where: {compteurId}})
    await tx.source.deleteMany({where: {OR: [{id: {in: publications.map(row => row.sourceId)}}, {chunks: {some: {pointPrelevementId}}}]}})
    await tx.meterReading.updateMany({where: {compteurId}, data: {currentRevisionId: null}})
    await tx.$executeRawUnsafe('ALTER TABLE "MeterReadingRevision" DISABLE TRIGGER "MeterReadingRevision_immutable"')
    await tx.meterReadingRevision.deleteMany({where: {reading: {compteurId}}})
    await tx.$executeRawUnsafe('ALTER TABLE "MeterReadingRevision" ENABLE TRIGGER "MeterReadingRevision_immutable"')
    await tx.meterReading.deleteMany({where: {compteurId}})
    await tx.meterAllocationVersion.deleteMany({where: {allocation: {compteurId}}})
    await tx.meterAllocation.deleteMany({where: {compteurId}})
    await tx.meterStream.deleteMany({where: {compteurId}})
    await tx.meterIngestion.deleteMany({where: {batchId: inIds(owned.batches)}})
    await tx.externalReference.deleteMany({where: {OR: [{compteurId}, {pointPrelevementId}, {declarantUserId: inIds(owned.owners)}]}})
    await tx.resourceDocument.deleteMany({where: {declarantPointPrelevement: {pointPrelevementId}}})
    await tx.pointPrelevement.deleteMany({where: {id: inIds(owned.points)}})
    await tx.user.deleteMany({where: {id: inIds(owned.owners)}})
    await tx.compteur.deleteMany({where: {id: inIds(owned.meters)}})
    await tx.serviceAccount.deleteMany({where: {id: inIds(owned.accounts)}})
  })
  for (const set of Object.values(owned)) set.clear()
})
test.after.always(async () => {
  await prisma.$disconnect()
  await globalThis.pgPool?.end()
})

async function fixture() {
  const key = randomUUID()
  const compteurId = stableId(`rebuild-meter:${key}`)
  owned.meters.add(compteurId)
  const points = [0, 1].map(index => {
    const id = stableId(`rebuild-point:${key}:${index}`)
    owned.points.add(id)
    return {id, key: `${key}:${index}`, sourceId: `dropt-epidropt:point:${key}:${index}`, coordinates: [0.4, 44.6],
      references: [{provider: 'epidropt', externalId: `${key}:${index}`}],
      data: {name: `Rebuild test ${key}:${index}`, flowType: 'PRELEVEMENT', waterBodyType: 'SUPERFICIELLE'}}
  })
  const declarants = [0, 1].map(index => {
    const id = stableId(`rebuild-owner:${key}:${index}`)
    owned.owners.add(id)
    return {id, key: `${key}:${index}`, sourceId: `dropt-epidropt:preleveur:${key}:${index}`,
      references: [{provider: 'epidropt', externalId: `${key}:${index}`}], emails: [], user: {role: 'DECLARANT', email: null},
      data: {socialReason: `Rebuild farm ${key}:${index}`, preleveurType: 'IRRIGANT', declarationNotificationsEnabled: false}}
  })
  const exploitations = points.map((point, index) => ({id: stableId(`rebuild-exploitation:${key}:${index}`),
    sourceId: `dropt-epidropt:exploitation:${key}:${index}`, pointId: point.id, declarantId: declarants[index].id,
    usageCode: '2', countingCode: `00${index}`, aliases: []}))
  const allocations = exploitations.map((exploitation, index) => ({sourceId: `dropt-rives:allocation:${key}:${index}`,
    compteurId, exploitationId: exploitation.id, contractId: `${key}:${index}`, lieuId: key, percentage: index === 0 ? '70' : '30', additive: false}))
  const allocationSnapshot = allocations.map(row => ({key: row.sourceId, contractId: row.contractId, lieuId: row.lieuId, percentage: row.percentage, inScope: true}))
  const original = signed({formatVersion: 1, scope: 'epidropt', issues: [], points, declarants, exploitations, allocations,
    meters: [{id: compteurId, serial: key, provider: 'rives-et-eaux', references: [{provider: 'rives-et-eaux', externalId: key}],
      allocationSnapshot, allocationSnapshotValidated: true}]})
  const account = await prisma.serviceAccount.create({data: {name: `Rebuild test ${key}`}})
  owned.accounts.add(account.id)
  const activateAt = '2026-01-01T00:00:00Z'
  const applied = await applyManifest(prisma, original, {apply: true, activateAt, serviceAccountId: account.id})
  if (!applied.complete) throw new Error(JSON.stringify(applied.executionIssues))
  const batchId = randomUUID()
  owned.batches.add(batchId)
  await ingestMeterBatch({provider: 'rives-et-eaux', scope: 'epidropt', batchId, complete: true, mode: 'LIVE',
    fetchedAt: '2026-02-01T12:00:00Z', windowStart: '2026-01-01T00:00:00Z', windowEnd: '2026-01-04T00:00:00Z',
    readings: [100, 110, 120].map((index, position) => ({externalId: key, observedAt: `2026-01-0${position + 1}T00:00:00Z`,
      index: String(index), status: 'VALID', quality: 'A', origin: 'Auto'}))}, {serviceAccountId: account.id})
  const mergedPoint = {...points[0], id: stableId(`rebuild-merged:${key}`), sourceId: `dropt-epidropt:point:${key}:merged`,
    references: points.flatMap(point => point.references)}
  owned.points.add(mergedPoint.id)
  const manifest = signed({...original, points: [mergedPoint], exploitations: exploitations.map(row => ({...row, pointId: mergedPoint.id}))})
  return {original, manifest, options: {target: 'disposable', activateAt, serviceAccountId: account.id}}
}

const evidence = report => ({target: 'testing', completed: true, restored: true, backupSha256: 'a'.repeat(64),
  restoredAt: '2026-09-23T00:00:00Z', scopeStateHash: report.scopeStateHash})

integration('reconstruction simulée puis atomique conserve index, révisions, comptes et autres PP ; recalcul explicite rejouable', async t => {
  const {original, manifest, options} = await fixture()
  const outsideId = randomUUID()
  owned.points.add(outsideId)
  await prisma.pointPrelevement.create({data: {id: outsideId, name: `Outside ${outsideId}`, flowType: 'PRELEVEMENT', waterBodyType: 'SUPERFICIELLE'}})
  const before = await inspectRebuildScope(prisma, manifest)
  t.deepEqual(before.errors, [])
  const preview = await rebuildManifest(prisma, manifest, options)
  t.false(preview.applied)
  t.true(preview.complete)
  t.is((await inspectRebuildScope(prisma, manifest)).scopeStateHash, before.scopeStateHash)
  const applied = await rebuildManifest(prisma, manifest, {...options, apply: true, expectedReport: preview, backupEvidence: evidence(preview)})
  t.true(applied.applied)
  t.is(await prisma.pointPrelevement.count({where: {id: {in: original.points.map(row => row.id)}}}), 0)
  t.is(await prisma.pointPrelevement.count({where: {id: outsideId}}), 1)
  t.deepEqual(applied.pointMappings.map(row => row.newIds), [[manifest.points[0].id], [manifest.points[0].id]])
  t.is(await prisma.meterPublication.count({where: {compteurId: manifest.meters[0].id}}), 0)
  const after = await inspectRebuildScope(prisma, manifest)
  for (const table of ['User', 'Compteur', 'MeterReading', 'MeterReadingRevision', 'MeterIngestion']) t.deepEqual(after.fingerprints[table], before.fingerprints[table])
  const proposed = await recomputeRebuiltManifest(prisma, manifest, {...options, report: applied})
  t.false(proposed.applied)
  t.is(await prisma.meterPublication.count({where: {compteurId: manifest.meters[0].id}}), 0)
  const progress = []
  const replay = await recomputeRebuiltManifest(prisma, manifest, {...options, apply: true, report: applied, onProgress: row => progress.push(structuredClone(row))})
  t.true(replay.complete)
  t.is(replay.streams[0].published, 2)
  t.true(progress.length >= 1)
  const publications = await prisma.meterPublication.findMany({where: {compteurId: manifest.meters[0].id, active: true}, orderBy: {periodStart: 'asc'}})
  t.deepEqual(publications.map(row => row.inScopeVolume.toString()), ['10', '10'])
  const again = await recomputeRebuiltManifest(prisma, manifest, {...options, apply: true, report: applied})
  t.is(again.streams[0].published, 0)
  t.is(again.streams[0].intervals.unchanged, 2)
  t.is(await prisma.meterPublication.count({where: {compteurId: manifest.meters[0].id}}), 2)
  const resumed = await recomputeRebuiltManifest(prisma, manifest, {...options, apply: true, report: applied, resume: JSON.parse(JSON.stringify(replay))})
  t.deepEqual(resumed.streams, replay.streams)
})

integration('sauvegarde restaurée, simulation approuvée et absence de dérive sont obligatoires', async t => {
  const {manifest, options} = await fixture()
  await t.throwsAsync(rebuildManifest(prisma, manifest, {...options, apply: true}), {message: 'REBUILD_APPROVED_SIMULATION_REQUIRED'})
  const preview = await rebuildManifest(prisma, manifest, options)
  await t.throwsAsync(rebuildManifest(prisma, manifest, {...options, apply: true, expectedReport: preview}), {message: 'REBUILD_VERIFIED_RESTORED_BACKUP_REQUIRED'})
  await prisma.meterStream.updateMany({where: {compteurId: manifest.meters[0].id}, data: {lastIssue: 'changed since snapshot'}})
  await t.throwsAsync(rebuildManifest(prisma, manifest, {...options, apply: true, expectedReport: preview, backupEvidence: evidence(preview)}),
    {message: 'REBUILD_SCOPE_CHANGED_SINCE_SIMULATION'})
  t.is(await prisma.pointPrelevement.count({where: {sourceId: {startsWith: 'dropt-epidropt:point:'}}}), 2)
})

integration('les dépendances manuelles ou extérieures bloquent sans suppression partielle', async t => {
  const {original, manifest, options} = await fixture()
  const usage = await prisma.sandreWaterUse.findUnique({where: {code: '2'}})
  const source = await prisma.source.create({data: {type: 'API', status: 'COMPLETED', chunks: {create: {
    pointPrelevementId: original.points[0].id, exploitationId: original.exploitations[0].id,
    preleveurUserId: original.declarants[0].id,
    usageId: usage.id, flowType: 'PRELEVEMENT', calculationStrategy: 'GENERIC',
    minDate: new Date('2026-01-01T00:00:00Z'), maxDate: new Date('2026-01-02T00:00:00Z')
  }}}})
  await t.throwsAsync(rebuildManifest(prisma, manifest, options), {message: /REBUILD_MANUAL_OR_SHARED_SOURCE/})
  await prisma.source.delete({where: {id: source.id}})
  const version = await prisma.meterAllocationVersion.findFirst({where: {allocation: {compteurId: manifest.meters[0].id}}})
  const edited = await prisma.meterAllocationVersion.create({data: {allocationId: version.allocationId, version: 2,
    enabled: false, metadata: {...version.metadata, allocationEdit: {reason: 'Synthetic manual edit'}}}})
  await t.throwsAsync(rebuildManifest(prisma, manifest, options), {message: /REBUILD_MANUAL_ALLOCATION_EDIT/})
  await prisma.meterAllocationVersion.delete({where: {id: edited.id}})
  await prisma.resourceDocument.create({data: {declarantPointPrelevementId: original.exploitations[0].id,
    filename: 'synthetic.pdf', storageKey: `synthetic/${randomUUID()}`}})
  await t.throwsAsync(rebuildManifest(prisma, manifest, options), {message: /REBUILD_DEPENDENCY_DOCUMENTS/})
  t.is(await prisma.pointPrelevement.count({where: {id: {in: original.points.map(row => row.id)}}}), 2)
  t.is(await prisma.meterReading.count({where: {compteurId: manifest.meters[0].id}}), 3)
})

integration('une erreur de création annule aussi toutes les suppressions du référentiel précédent', async t => {
  const {original, manifest, options} = await fixture()
  const outsideId = randomUUID()
  owned.points.add(outsideId)
  const conflictingName = `Outside duplicate ${outsideId}`
  await prisma.pointPrelevement.create({data: {id: outsideId, name: conflictingName, flowType: 'PRELEVEMENT', waterBodyType: 'SUPERFICIELLE'}})
  const invalid = signed({...manifest, points: manifest.points.map(row => ({...row, data: {...row.data, name: conflictingName}}))})
  const before = await inspectRebuildScope(prisma, invalid)
  await t.throwsAsync(rebuildManifest(prisma, invalid, options), {message: /REBUILD_IMPORT_FAILED:NOM_POINT_EXISTANT_A_RAPPROCHER/})
  t.is((await inspectRebuildScope(prisma, invalid)).scopeStateHash, before.scopeStateHash)
  t.is(await prisma.pointPrelevement.count({where: {id: {in: original.points.map(row => row.id)}}}), 2)
})

integration('un flux désormais ambigu reste désactivé tout en conservant ses index', async t => {
  const {manifest: valid, options} = await fixture()
  const manifest = signed({...valid, meters: valid.meters.map(row => ({...row, allocationSnapshotValidated: false}))})
  const preview = await rebuildManifest(prisma, manifest, options)
  const applied = await rebuildManifest(prisma, manifest, {...options, apply: true, expectedReport: preview, backupEvidence: evidence(preview)})
  t.false(applied.streams[0].enabled)
  const replay = await recomputeRebuiltManifest(prisma, manifest, {...options, apply: true, report: applied})
  t.is(replay.streams[0].published, 0)
  t.is(await prisma.meterReading.count({where: {compteurId: manifest.meters[0].id}}), 3)
})

test('reconstruction interdite sur prod et testing sans identité + TLS vérifiés', async t => {
  const client = {$queryRaw: async () => [{name: 'prod', username: 'prod', tls: true}]}
  await t.throwsAsync(assertRebuildTarget(client, 'prod'), {message: 'REBUILD_TARGET_FORBIDDEN'})
  await t.throwsAsync(assertRebuildTarget(client, 'testing'), {message: 'REBUILD_TESTING_IDENTITY_OR_TLS_INVALID'})
})
