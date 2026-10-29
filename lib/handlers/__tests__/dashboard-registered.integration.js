/* eslint-disable no-await-in-loop -- Guarded fixtures and cold/hot comparisons run sequentially in one rollback-only transaction. */
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {refreshChunkValueSummaries} from '../../services/chunk-value-summaries.js'
import {getRegisteredPrelevementsByUsage} from '../dashboard.js'

const integration = process.env.METER_INTEGRATION_TESTS === '1' ? test.serial : test.skip
test.before(() => { if (process.env.METER_INTEGRATION_TESTS === '1') requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

const value = (start, end = start, changes = {}) => ({metricTypeCode: 'volume', unit: 'm³', frequency: 'irregular', value: 0,
  periodStart: new Date(start), periodEnd: new Date(end), metadata: {nativeTemporal: true}, ...changes})

async function withFixture(run) {
  const rollback = new Error('ROLLBACK_REGISTERED_DASHBOARD')
  try {
    await prisma.$transaction(async client => {
      const zoneIds = [randomUUID(), randomUUID()]
      for (const id of zoneIds) await client.$executeRaw`INSERT INTO "Zone" (id,code,type,name,coordinates,"createdAt","updatedAt")
        VALUES (${id}::uuid,${id},'SAGE','Territoire synthétique enregistré',
        ST_Multi(ST_GeomFromText('POLYGON((0 0,0 1,1 1,1 0,0 0))',4326)),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`
      const actors = []
      for (let i = 0; i < 2; i++) actors.push(await client.user.create({data: {role: 'DECLARANT',
        declarant: {create: {declarantRole: 'PRELEVEUR', preleveurType: 'IRRIGANT'}}}}))
      const cases = []
      const createUsage = data => client.sandreWaterUse.create({data: {code: `r${randomUUID().slice(0, 12)}`,
        kind: 'USAGE', label: 'Usage enregistré synthétique', ...data}})
      const defaults = {kind: 'native', values: [], expected: true, zoneId: zoneIds[0], deleted: false,
        status: 'VALIDATED', sourceType: 'API', sourceStatus: 'COMPLETED', actorField: 'preleveurUserId',
        chunkActorId: actors[0].id, declarationOwnerId: actors[0].id, declarationCreatorId: null,
        minDate: '2026-02-01', maxDate: '2026-02-28'}
      const add = async (options = {}) => {
        const {label, kind, values, expected, zoneId, deleted, status, sourceType, sourceStatus, actorField,
          chunkActorId, declarationOwnerId, declarationCreatorId, minDate, maxDate, metadata} = {...defaults, ...options}
        let {usage} = options
        usage ??= await createUsage({label})
        const point = await client.pointPrelevement.create({data: {name: label, waterBodyType: 'SUPERFICIELLE',
          flowType: 'PRELEVEMENT', deletedAt: deleted ? new Date() : null, zones: {create: {zoneId}}}})
        await client.declarantPointPrelevement.create({data: {pointPrelevementId: point.id, declarantUserId: actors[0].id, usageId: usage.id}})
        const declaration = sourceType === 'DECLARATION' ? await client.declaration.create({data: {
          code: randomUUID().slice(0, 6), type: 'ANNUAL', waterWithdrawalType: 'volume',
          declarantUserId: declarationOwnerId, createdByDeclarantUserId: declarationCreatorId
        }}) : null
        const source = await client.source.create({data: {type: sourceType, status: sourceStatus, declarationId: declaration?.id}})
        const chunk = await client.chunk.create({data: {sourceId: source.id, usageId: usage.id, pointPrelevementId: point.id,
          [actorField]: chunkActorId, minDate: new Date(minDate), maxDate: new Date(maxDate), instructionStatus: status,
          calculationStrategy: kind === 'meter' ? 'METER' : 'GENERIC',
          metadata: metadata ?? (kind === 'native' ? {nativeTemporal: true, timezone: 'Indian/Reunion'} : {}),
          chunkValues: {create: values}}})
        const scenario = {label, point, usage, source, chunk, expected}
        cases.push(scenario)
        return scenario
      }
      await run({client, zoneIds, actors, cases, add, createUsage})
      throw rollback
    }, {timeout: 60000})
  } catch (error) { if (error !== rollback) throw error }
}

async function compareColdAndWarm(t, f, periodType = 'month', periodKey = '2026-02', options = {}) {
  const {client, cases, zoneIds} = f
  const args = [zoneIds.slice(0, 1), periodType, periodKey, {client, ...options}]
  const cold = await getRegisteredPrelevementsByUsage(...args)
  const byUsage = new Map(cold.map(row => [row.usage.id, row]))
  for (const scenario of cases) {
    const rootId = scenario.usage.parentId ?? scenario.usage.id
    if (scenario.expected === null) t.false(byUsage.has(rootId), scenario.label)
    else t.like(byUsage.get(rootId), {declaredPointsCount: Number(scenario.expected),
      missingPointsCount: Number(!scenario.expected), totalPointsCount: 1}, scenario.label)
  }
  await refreshChunkValueSummaries(cases.map(item => item.chunk.id), {client})
  const hot = await getRegisteredPrelevementsByUsage(...args)
  t.deepEqual(hot, cold)
  return hot
}

integration('déclarations enregistrées : trous natifs, périodes longues, instants Réunion et métadonnées legacy restent distincts', async t => {
  await withFixture(async f => {
    const {add} = f
    await add({label: 'Trou natif février', expected: false,
      values: [value('2026-01-01T20:00:00Z', '2026-01-02T20:00:00Z'), value('2026-03-01T20:00:00Z', '2026-03-02T20:00:00Z')]})
    await add({label: 'Longue période native', values: [value('2025-10-31T20:00:00Z', '2026-05-31T20:00:00Z')]})
    await add({label: 'Instant début février Réunion', values: [value('2026-01-31T20:00:00Z')]})
    await add({label: 'Instant fin février Réunion', expected: false, values: [value('2026-02-28T20:00:00Z')]})
    await add({label: 'Intervalle finit au début', expected: false, values: [value('2026-01-01T20:00:00Z', '2026-01-31T20:00:00Z')]})
    await add({label: 'Intervalle commence à la fin', expected: false, values: [value('2026-02-28T20:00:00Z', '2026-03-01T20:00:00Z')]})
    await add({label: 'Valeur zéro reste déclarée', values: [value('2026-02-10T20:00:00Z', '2026-02-11T20:00:00Z')]})
    await add({label: 'Métrique native sans volume', values: [value('2026-02-10T20:00:00Z', undefined, {metricTypeCode: 'pH', unit: 'autre', frequency: 'instant'})]})
    await add({label: 'Chunk natif vide', expected: false})
    await add({label: 'Legacy sans valeurs', kind: 'legacy'})
    await add({label: 'Legacy sans clé native', kind: 'legacy', metadata: {other: true}})
    await add({label: 'Marqueur native faux', kind: 'legacy', metadata: {nativeTemporal: false}})
    await add({label: 'Marqueur native chaîne texte', kind: 'legacy', metadata: {nativeTemporal: 'true'}})
    await add({label: 'Legacy hors période', kind: 'legacy', expected: false, minDate: '2026-01-01', maxDate: '2026-01-31'})
    await compareColdAndWarm(t, f)
  })
})

integration('déclarations enregistrées METER : présence exacte, trous, alias et frontières du mois Paris', async t => {
  await withFixture(async f => {
    const meter = options => f.add({kind: 'meter', ...options})
    await meter({label: 'Trou METER février', expected: false,
      values: [value('2026-01-01T23:00:00Z', '2026-01-02T23:00:00Z'), value('2026-03-01T23:00:00Z', '2026-03-02T23:00:00Z')]})
    await meter({label: 'Long intervalle METER', values: [value('2025-11-30T23:00:00Z', '2026-05-31T22:00:00Z')]})
    await meter({label: 'METER début exact', values: [value('2026-01-31T23:00:00Z', '2026-02-01T23:00:00Z')]})
    await meter({label: 'METER fin exclusive', expected: false, values: [value('2026-01-01T23:00:00Z', '2026-01-31T23:00:00Z')]})
    await meter({label: 'METER début mois suivant', expected: false, values: [value('2026-02-28T23:00:00Z', '2026-03-01T23:00:00Z')]})
    await meter({label: 'METER alias historique', values: [value('2026-02-10T23:00:00Z', '2026-02-11T23:00:00Z', {metricTypeCode: 'volume prélevé'})]})
    await meter({label: 'METER index seul', expected: false, values: [value('2026-02-10T23:00:00Z', '2026-02-11T23:00:00Z', {metricTypeCode: 'index'})]})
    await meter({label: 'METER fréquence régulière', expected: false, values: [value('2026-02-10T23:00:00Z', '2026-02-11T23:00:00Z', {frequency: '1 day'})]})
    await meter({label: 'METER vide', expected: false})
    await meter({label: 'METER et natif combinés gardent la branche native', metadata: {nativeTemporal: true},
      values: [value('2026-02-10T20:00:00Z', undefined, {metricTypeCode: 'pH', frequency: 'instant', unit: 'autre'})]})
    await compareColdAndWarm(t, f)
  })
})

for (const [periodKey, start, end] of [
  ['2026-W13', '2026-03-22T23:00:00.000Z', '2026-03-29T22:00:00.000Z'],
  ['2026-W43', '2026-10-18T22:00:00.000Z', '2026-10-25T23:00:00.000Z']
]) {
  integration(`déclarations enregistrées METER : semaine Paris ${periodKey} garde sa durée DST exacte`, async t => {
    await withFixture(async f => {
      const meter = options => f.add({kind: 'meter', ...options})
      await meter({label: 'Intervalle traverse toute la semaine', values: [value(start, end)]})
      await meter({label: 'Dernière milliseconde incluse', values: [value(new Date(+new Date(end) - 1).toISOString(), end)]})
      await meter({label: 'Fin au début exclue', expected: false, values: [value(new Date(+new Date(start) - 1).toISOString(), start)]})
      await meter({label: 'Début à la fin exclu', expected: false, values: [value(end, new Date(+new Date(end) + 1).toISOString())]})
      await compareColdAndWarm(t, f, 'week', periodKey)
    })
  })
}

integration('déclarations enregistrées : caches chauds respectent acteurs, source, instruction, usages et territoire', async t => {
  await withFixture(async f => {
    const {client, add, actors, zoneIds, createUsage} = f
    const values = [value('2026-02-10T20:00:00Z', '2026-02-11T20:00:00Z')]
    await add({label: 'Acteur préleveur API', values})
    await add({label: 'Acteur déposant API', values, actorField: 'submittedByDeclarantUserId'})
    await add({label: 'Acteur collecteur API', values, actorField: 'collecteurUserId'})
    await add({label: 'Acteur étranger API', values, chunkActorId: actors[1].id, expected: false})
    await add({label: 'Propriétaire déclaration', values, sourceType: 'DECLARATION', chunkActorId: actors[1].id})
    await add({label: 'Créateur déclaration', values, sourceType: 'DECLARATION', declarationOwnerId: actors[1].id,
      declarationCreatorId: actors[0].id, chunkActorId: actors[1].id})
    await add({label: 'Déclaration étrangère malgré acteur chunk', values, sourceType: 'DECLARATION', declarationOwnerId: actors[1].id, expected: false})
    await add({label: 'PENDING reste déclaré', values, status: 'PENDING'})
    await add({label: 'Source en traitement', values, sourceStatus: 'PROCESSING', expected: false})
    await add({label: 'Source en erreur', values, sourceStatus: 'FAILED', expected: false})
    await add({label: 'Ancienne série rejetée', values, status: 'REJECTED', expected: false})
    await add({label: 'Source batch exclue', values, sourceType: 'BATCH', expected: false})
    await add({label: 'PP supprimé exclu', values, deleted: true, expected: null})
    await add({label: 'PP autre territoire exclu', values, zoneId: zoneIds[1], expected: null})
    const visible = await createUsage({dashboardVisible: true})
    const visibleChild = await createUsage({kind: 'SUB_USAGE', parentId: visible.id})
    await add({label: 'Sous-usage rattaché au parent visible', values, usage: visibleChild})
    const hidden = await createUsage({dashboardVisible: false})
    const child = await createUsage({kind: 'SUB_USAGE', parentId: hidden.id})
    await add({label: 'Usage invisible', values, usage: hidden, expected: null})
    await add({label: 'Sous-usage parent invisible', values, usage: child, expected: null})
    await compareColdAndWarm(t, f, 'month', '2026-02', {declarantUserIds: [actors[0].id]})
    t.deepEqual(await getRegisteredPrelevementsByUsage([zoneIds[0]], 'month', '2026-02', {client, declarantUserIds: []}), [])
    t.deepEqual(await getRegisteredPrelevementsByUsage([], 'month', '2026-02', {client}), [])
    await client.source.updateMany({where: {id: {in: f.cases.map(item => item.source.id)}}, data: {status: 'PROCESSING'}})
    const after = await getRegisteredPrelevementsByUsage([zoneIds[0]], 'month', '2026-02', {client, declarantUserIds: [actors[0].id]})
    t.true(after.every(row => row.declaredPointsCount === 0))
    t.true((await client.chunkValueSummary.findMany({where: {chunkId: {in: f.cases.map(item => item.chunk.id)}}})).every(row => row.valid))
  })
})
