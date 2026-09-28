import test from 'ava'
import {stableId} from '../epidropt.js'
import {normalizeReviewedConsolidationPlan, planReviewedConsolidation, inspectReviewedConsolidation, consolidateReviewedInTransaction} from '../consolidate-reviewed.js'

const id = label => stableId(`reviewed-synthetic:${label}`)
const point = label => ({id: id(label), name: label, sourceId: `dropt-epidropt:point:${label}`,
  flowType: 'PRELEVEMENT', waterBodyType: 'SUPERFICIELLE', deletedAt: null})
const exploitation = (label, pointId, owner = id('owner')) => ({id: id(label), sourceId: `dropt-epidropt:exploitation:${label}`,
  pointPrelevementId: pointId, declarantUserId: owner, usageId: id('usage'), countingCode: '001',
  status: 'NON_RENSEIGNE', startDate: null, endDate: null, comment: null, abandonReason: null})

function fixture() {
  const source = point('source')
  const target = point('target')
  return {
    plan: {scope: 'epidropt', merges: [{sourcePointId: source.id, targetPointId: target.id}], discardMeterVolumes: true},
    inventory: {points: [source, target], exploitations: [exploitation('source-exploitation', source.id)],
      references: [{id: id('reference'), provider: 'rives-et-eaux', scope: 'epidropt', kind: 'POINT', externalId: 'L-TEST', pointPrelevementId: target.id}]}
  }
}

const review = ({plan, inventory}) => planReviewedConsolidation(plan, inventory)
const hasBlock = (report, code) => report.blocked.some(item => item.code === code)

function withMeter(input) {
  const meterId = id('meter')
  const sourceId = id('meter-source')
  input.inventory.meters = [{id: meterId}]
  input.inventory.references.push({id: id('meter-reference'), provider: 'rives-et-eaux', scope: 'epidropt', kind: 'METER', externalId: 'M-TEST', compteurId: meterId})
  input.inventory.allocations = [{id: id('allocation'), provider: 'rives-et-eaux', scope: 'epidropt', compteurId: meterId,
    exploitationId: id('source-exploitation')}]
  input.inventory.versions = [{id: id('version'), allocationId: id('allocation')}]
  input.inventory.streams = [{id: id('stream'), provider: 'rives-et-eaux', scope: 'epidropt', compteurId: meterId}]
  input.inventory.publications = [{id: id('publication'), compteurId: meterId, sourceId}]
  input.inventory.sources = [{id: sourceId, type: 'API'}]
  input.inventory.chunks = [{id: id('chunk'), sourceId, pointPrelevementId: id('source'), exploitationId: id('source-exploitation'),
    compteurId: meterId, calculationStrategy: 'METER'}]
  input.inventory.values = [{id: id('value'), chunkId: id('chunk')}]
  input.inventory.contributions = [{id: id('contribution'), publicationId: id('publication'), allocationVersionId: id('version'),
    chunkValueId: id('value'), volume: '12.3456'}]
  return input
}

test('le plan ne traite que les UUID explicitement désignés et conserve une exploitation déplacée', t => {
  const input = fixture()
  input.inventory.points.push(point('outside'))
  input.inventory.exploitations.push(exploitation('outside-exploitation', id('outside')))
  const report = review(input)
  t.true(report.complete)
  t.deepEqual(report.actions.moveExploitations, [{id: id('source-exploitation'), targetPointId: id('target')}])
  t.is(report.counts.pointsMerged, 1)
  t.is(report.counts.pointsRetired, 0)
  t.is(report.counts.publicationsDeleted, 0)
  t.false(JSON.stringify(report).includes('outside-exploitation'))
})

test('plan invalide, doublons, cycles et cible retirée sont refusés', t => {
  const {plan} = fixture()
  t.throws(() => normalizeReviewedConsolidationPlan({...plan, scope: 'elsewhere'}), {message: 'CONSOLIDATION_SCOPE_INVALID'})
  t.throws(() => normalizeReviewedConsolidationPlan({...plan, retirePointIds: ['not-an-id']}), {message: 'CONSOLIDATION_UUID_REQUIRED'})
  t.throws(() => normalizeReviewedConsolidationPlan({...plan, merges: [...plan.merges, ...plan.merges]}), {message: 'CONSOLIDATION_SOURCE_REPEATED'})
  t.throws(() => normalizeReviewedConsolidationPlan({...plan, retirePointIds: [id('target')]}), {message: 'CONSOLIDATION_CHAIN_OR_RETIREMENT_CONFLICT'})
  t.throws(() => normalizeReviewedConsolidationPlan({...plan, merges: [...plan.merges, {sourcePointId: id('target'), targetPointId: id('source')}]}), {message: 'CONSOLIDATION_CHAIN_OR_RETIREMENT_CONFLICT'})
})

test('aucune identité extérieure ni ressource différente n’est fusionnée', t => {
  const input = fixture()
  input.inventory.points[0].sourceId = 'another-import'
  input.inventory.points[0].waterBodyType = 'SOUTERRAIN'
  input.inventory.exploitations[0].sourceId = 'manual'
  const report = review(input)
  t.false(report.complete)
  for (const code of ['POINT_OUTSIDE_DROPT_IMPORT', 'POINT_RESOURCE_CONFLICT', 'EXPLOITATION_OUTSIDE_DROPT_IMPORT']) t.true(hasBlock(report, code))
})

test('une ancre Rives existante doit survivre et deux lieux distincts ne fusionnent pas', t => {
  const input = fixture()
  input.inventory.references[0].pointPrelevementId = id('source')
  t.true(hasBlock(review(input), 'RIVES_ANCHOR_MUST_SURVIVE'))
  input.inventory.references.push({...input.inventory.references[0], id: id('reference-2'), externalId: 'OTHER', pointPrelevementId: id('target')})
  t.true(hasBlock(review(input), 'RIVES_PLACE_REFERENCES_CONFLICT'))
})

test('la consolidation n’unit pas silencieusement des zones ouvrant des droits', t => {
  const input = fixture()
  input.inventory.zones = [{id: id('zone-link'), pointPrelevementId: id('source'), zoneId: id('zone')}]
  t.true(hasBlock(review(input), 'POINT_ZONES_REQUIRE_REVIEW'))
  input.inventory.zones.push({id: id('target-zone-link'), pointPrelevementId: id('target'), zoneId: id('zone')})
  t.true(review(input).complete)
})

test('les volumes METER supprimables sont quantifiés exactement sans toucher les index', t => {
  const input = withMeter(fixture())
  input.inventory.protected = {MeterReading: {count: 20, hash: 'readings-unchanged'}}
  const report = review(input)
  t.true(report.complete)
  t.is(report.counts.attributedVolumeDeleted, '12.3456')
  t.is(report.counts.publicationsDeleted, 1)
  t.is(report.counts.chunksDeleted, 1)
  t.is(report.counts.valuesDeleted, 1)
  t.deepEqual(report.meterIds, [id('meter')])
  input.plan.discardMeterVolumes = false
  t.true(hasBlock(review(input), 'METER_VOLUME_DELETION_NOT_AUTHORIZED'))
})

test('une source METER partagée inclut toutes ses contributions, sans arrondi numérique', t => {
  const input = withMeter(fixture())
  input.inventory.contributions.push({...input.inventory.contributions[0], id: id('second-contribution'), volume: '9000000000000000.0001'})
  t.is(review(input).counts.attributedVolumeDeleted, '9000000000000012.3457')
})

test('les données ordinaires et les corrections humaines bloquent la fusion', t => {
  for (const field of ['instructedByInstructorUserId', 'instructionComment', 'submittedByDeclarantUserId', 'collecteurUserId']) {
    const input = withMeter(fixture())
    input.inventory.chunks[0][field] = 'present'
    t.true(hasBlock(review(input), 'PUBLICATION_HAS_MANUAL_OR_FOREIGN_DATA'))
  }
  const input = withMeter(fixture())
  input.inventory.chunks.push({id: id('ordinary'), pointPrelevementId: id('source'), calculationStrategy: 'GENERIC'})
  t.true(hasBlock(review(input), 'ORDINARY_OR_UNTRACKED_CHUNK_HISTORY'))
})

test('les sources importées ou historiques de remplacement ne sont pas supprimés par cascade', t => {
  const input = withMeter(fixture())
  input.inventory.sources[0].declarationId = id('declaration')
  input.inventory.replacements = [{id: id('replacement'), replacementSourceId: id('meter-source')}]
  const report = review(input)
  t.true(hasBlock(report, 'PUBLICATION_SOURCE_NOT_DERIVED'))
  t.true(hasBlock(report, 'ORDINARY_REPLACEMENT_HISTORY'))
})

test('une contribution extérieure ou incohérente ne traverse pas la frontière de suppression', t => {
  const input = withMeter(fixture())
  input.inventory.contributions[0].publicationId = id('foreign-publication')
  t.true(hasBlock(review(input), 'ALLOCATION_CONTRIBUTION_OUTSIDE_SCOPE'))
  input.inventory.contributions[0].publicationId = id('publication')
  input.inventory.values = []
  t.true(hasBlock(review(input), 'PUBLICATION_CONTRIBUTION_OUTSIDE_SOURCE'))
})

test('documents, règles, connecteurs et réponse de campagne même vide sont bloquants', t => {
  for (const [key, field] of [['documents', 'declarantPointPrelevementId'], ['documentLinks', 'declarantPointPrelevementId'],
    ['rules', 'declarantPointPrelevementId'], ['connectors', 'declarantPointPrelevementId'], ['responses', 'exploitationId']]) {
    const input = fixture()
    input.inventory[key] = [{id: id(key), [field]: id('source-exploitation')}]
    t.true(hasBlock(review(input), `DEPENDENCY_${key.toUpperCase()}`))
  }
})

test('deux exploitations équivalentes ne fusionnent qu’avec un mapping explicite', t => {
  const input = fixture()
  input.inventory.exploitations.push(exploitation('target-exploitation', id('target')))
  t.true(hasBlock(review(input), 'EXPLOITATION_PERIOD_COLLISION'))
  input.plan.merges[0].exploitationMerges = [{sourceId: id('source-exploitation'), targetId: id('target-exploitation')}]
  const report = review(input)
  t.true(report.complete)
  t.is(report.counts.exploitationsMerged, 1)
  t.is(report.counts.exploitationsMoved, 0)
})

test('des titulaires ou codes différents ne sont jamais absorbés dans le même doublon', t => {
  const input = fixture()
  input.inventory.exploitations.push(exploitation('target-exploitation', id('target'), id('other-owner')))
  input.plan.merges[0].exploitationMerges = [{sourceId: id('source-exploitation'), targetId: id('target-exploitation')}]
  t.true(hasBlock(review(input), 'EXPLOITATION_OWNER_CHANGE_REQUIRES_EXPLICIT_RETIREMENT'))
  input.inventory.exploitations[1].declarantUserId = id('owner')
  input.inventory.exploitations[1].countingCode = '002'
  t.true(hasBlock(review(input), 'EXPLOITATION_MERGE_NOT_EQUIVALENT'))
})

test('des codes distincts et les droits collecteurs sont conservés lorsque les UUID sont déplacés', t => {
  const input = fixture()
  input.inventory.exploitations.push({...exploitation('target-exploitation', id('target')), countingCode: '002'})
  input.inventory.collecteurs = [{id: id('collector-link'), exploitationId: id('source-exploitation'), collecteurUserId: id('collector')}]
  input.inventory.secondaryUsages = [{exploitationId: id('source-exploitation'), usageId: id('secondary-usage')}]
  t.true(review(input).complete)
})

test('un retrait explicite supprime ses seuls accès collecteurs et bloque les usages complémentaires non repris', t => {
  const input = fixture()
  input.plan.merges = []
  input.plan.retireExploitationIds = [id('source-exploitation')]
  input.inventory.collecteurs = [{id: id('collector-link'), exploitationId: id('source-exploitation'), collecteurUserId: id('collector')}]
  input.inventory.secondaryUsages = [{exploitationId: id('source-exploitation'), usageId: id('secondary-usage')}]
  const report = review(input)
  t.is(report.counts.collectorLinksDeleted, 1)
  t.true(hasBlock(report, 'RETIRED_EXPLOITATION_SECONDARY_USAGES_WITHOUT_REPLACEMENT'))
  t.is(report.counts.pointsRetired, 0)
  t.is(report.counts.exploitationsRetired, 1)
  input.inventory.secondaryUsages = []
  t.true(review(input).complete)
})

test('le rejeu reconnaît une fusion prouvée mais pas une ancienne suppression manuelle', t => {
  const input = fixture()
  input.inventory.points[0].deletedAt = '2026-09-28T00:00:00Z'
  input.inventory.exploitations = []
  t.true(hasBlock(review(input), 'POINT_ALREADY_DELETED_OUTSIDE_PLAN'))
  input.inventory.references.push({id: id('alias'), provider: 'pe-import-alias', scope: 'epidropt', kind: 'POINT',
    externalId: id('source'), pointPrelevementId: id('target'), metadata: {}})
  const report = review(input)
  t.true(report.complete)
  t.is(report.counts.pointsMerged, 0)
  t.deepEqual(report.meterIds, [])
})

test('le retrait est rejouable uniquement avec son marqueur persistant', t => {
  const input = fixture()
  input.plan.merges = []
  input.plan.retirePointIds = [id('source')]
  t.is(review(input).counts.pointsRetired, 1)
  input.inventory.points[0].deletedAt = '2026-09-28T00:00:00Z'
  input.inventory.exploitations = []
  t.false(review(input).complete)
  input.inventory.references.push({id: id('retirement'), provider: 'pe-import-retired', scope: 'epidropt', kind: 'POINT', externalId: id('source'), pointPrelevementId: id('source')})
  t.true(review(input).complete)
  t.is(review(input).counts.pointsRetired, 0)
})

test('une dérive de dépendance ou des index modifie la preuve de simulation', t => {
  const input = fixture()
  const before = review(input)
  input.inventory.protected = {MeterReading: {count: 2, hash: 'changed'}}
  const after = review(input)
  t.is(before.planHash, after.planHash)
  t.not(before.stateHash, after.stateHash)
})

test('les compteurs réinitialisés sont une liste explicite normalisée et non un périmètre implicite', t => {
  const {plan} = fixture()
  t.throws(() => normalizeReviewedConsolidationPlan({...plan, resetMeterIds: ['ALL']}), {message: 'CONSOLIDATION_UUID_REQUIRED'})
  t.throws(() => normalizeReviewedConsolidationPlan({...plan, resetMeterIds: id('meter')}), {message: 'CONSOLIDATION_PLAN_INVALID'})
  const normalized = normalizeReviewedConsolidationPlan({...plan, resetMeterIds: [id('meter').toUpperCase(), id('meter')]})
  t.deepEqual(normalized.resetMeterIds, [id('meter')])
})

test('un reset ciblé quantifie les volumes et affectations sans retirer de PP ni d’exploitation', t => {
  const input = withMeter(fixture())
  input.plan.merges = []
  input.plan.resetMeterIds = [id('meter')]
  const report = review(input)
  t.true(report.complete)
  t.deepEqual(report.changedExploitationIds, [])
  t.is(report.counts.metersReset, 1)
  t.is(report.counts.allocationsReset, 1)
  t.is(report.counts.allocationVersionsReset, 1)
  t.is(report.counts.pointsMerged, 0)
  t.is(report.counts.exploitationsRetired, 0)
  t.is(report.counts.attributedVolumeDeleted, '12.3456')
})

test('un reset ne peut pas effacer une provenance étrangère ou une affectation éditée manuellement', t => {
  const cases = [
    ['RESET_METER_MISSING', input => { input.inventory.meters = [] }],
    ['RESET_METER_PROVENANCE_MISSING', input => { input.inventory.references = input.inventory.references.filter(item => item.kind !== 'METER') }],
    ['RESET_METER_FOREIGN_REFERENCE', input => { input.inventory.references.push({compteurId: id('meter'), scope: 'elsewhere', provider: 'rives-et-eaux', kind: 'METER'}) }],
    ['ALLOCATION_OUTSIDE_DROPT_IMPORT', input => { input.inventory.allocations[0].scope = 'elsewhere' }],
    ['METER_STREAM_OUTSIDE_DROPT_IMPORT', input => { input.inventory.streams[0].scope = 'elsewhere' }],
    ['RESET_METER_MANUAL_ALLOCATION_EDIT', input => { input.inventory.versions[0].metadata = {allocationEdit: {reason: 'Synthetic manual adjustment'}} }],
    ['METER_VOLUME_DELETION_NOT_AUTHORIZED', input => { input.plan.discardMeterVolumes = false }]
  ]
  for (const [code, change] of cases) {
    const input = withMeter(fixture())
    input.plan.merges = []
    input.plan.resetMeterIds = [id('meter')]
    change(input)
    t.true(hasBlock(review(input), code), code)
  }
})

function fakeDatabase(inventory) {
  const tables = Object.fromEntries(Object.entries({pointPrelevement: 'points', declarantPointPrelevement: 'exploitations',
    pointPrelevementZone: 'zones', externalReference: 'references', compteur: 'meters', meterAllocation: 'allocations', meterAllocationVersion: 'versions',
    meterStream: 'streams', meterPublication: 'publications', source: 'sources', chunk: 'chunks', chunkValue: 'values',
    meterVolumeContribution: 'contributions', chunkValueReplacement: 'replacements', resourceDocument: 'documents',
    resourceDocumentExploitation: 'documentLinks', resourceRuleExploitation: 'rules', declarantPointPrelevementConnector: 'connectors',
    collectionResponse: 'responses', declarantCollecteurExploitation: 'collecteurs', declarantPointPrelevementSecondaryUsage: 'secondaryUsages'
  }).map(([model, key]) => [model, structuredClone(inventory[key] ?? [])]))
  const writes = []
  const sql = []
  const matchesWhere = (row, where = {}) => Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return condition.some(item => matchesWhere(row, item))
    if (key === 'provider_scope_kind_externalId') return matchesWhere(row, condition)
    if (condition && typeof condition === 'object') {
      if ('in' in condition) return condition.in.includes(row[key])
      if ('notIn' in condition) return !condition.notIn.includes(row[key])
    }
    return row[key] === condition
  })
  const remove = (model, where) => {
    const removed = tables[model].filter(row => matchesWhere(row, where))
    tables[model] = tables[model].filter(row => !matchesWhere(row, where))
    if (model === 'source') remove('chunk', {sourceId: {in: removed.map(row => row.id)}})
    if (model === 'chunk') remove('chunkValue', {chunkId: {in: removed.map(row => row.id)}})
    if (model === 'declarantPointPrelevement') {
      remove('declarantCollecteurExploitation', {exploitationId: {in: removed.map(row => row.id)}})
      remove('declarantPointPrelevementSecondaryUsage', {exploitationId: {in: removed.map(row => row.id)}})
    }
    return {count: removed.length}
  }
  const tx = {}
  for (const model of Object.keys(tables)) {
    const find = where => tables[model].filter(row => matchesWhere(row, where))
    tx[model] = {
      findMany: async ({where} = {}) => structuredClone(find(where)),
      findUnique: async ({where}) => structuredClone(find(where)[0] ?? null),
      create: async ({data}) => { writes.push(`${model}.create`); tables[model].push(structuredClone(data)); return structuredClone(data) },
      createMany: async ({data}) => { writes.push(`${model}.createMany`); tables[model].push(...structuredClone(data)); return {count: data.length} },
      deleteMany: async ({where}) => { writes.push(`${model}.deleteMany`); return remove(model, where) },
      delete: async ({where}) => { writes.push(`${model}.delete`); return remove(model, where) },
      update: async ({where, data}) => {
        writes.push(`${model}.update`)
        const row = find(where)[0]
        if (!row) throw new Error(`Missing synthetic ${model}`)
        Object.assign(row, structuredClone(data))
        return structuredClone(row)
      },
      updateMany: async ({where, data}) => {
        writes.push(`${model}.updateMany`)
        const rows = find(where)
        for (const row of rows) Object.assign(row, structuredClone(data))
        return {count: rows.length}
      }
    }
  }
  tx.$executeRaw = async strings => { sql.push(strings.join('?')); return 0 }
  tx.$queryRaw = async (strings, pointIds) => {
    const query = strings.join('?')
    sql.push(query)
    if (query.includes('current_database()')) return [{name: 'testing-partageons-leau-api', username: 'testing-partageons-leau-api', tls: true}]
    if (query.includes('ST_X')) return tables.pointPrelevement.filter(row => pointIds.includes(row.id)).map(row => ({id: row.id, x: 0.4, y: 44.6}))
    return []
  }
  tx.$queryRawUnsafe = async query => {
    sql.push(query)
    return [{count: 1, hash: 'synthetic-protected-inputs-unchanged'}]
  }
  return {tx, tables, writes, sql}
}

test('la transaction ciblée retire les dérivés puis déplace les UUID et restaure les affectations', async t => {
  const input = withMeter(fixture())
  input.inventory.references.push({id: id('source-reference'), provider: 'epidropt', scope: 'epidropt', kind: 'POINT',
    externalId: 'SOURCE-SYNTHETIC', pointPrelevementId: id('source'), metadata: {imported: {name: 'Ancien donneur'}, retainedProof: 'synthetic'}})
  input.inventory.references[0].metadata = {imported: {name: 'Survivant canonique'}}
  input.inventory.streams[0].enabled = true
  input.inventory.allocations[0].sourceId = 'dropt-rives:allocation:synthetic'
  input.inventory.versions[0].enabled = true
  const originalVersions = structuredClone(input.inventory.versions)
  const db = fakeDatabase(input.inventory)
  const expectedReport = await inspectReviewedConsolidation(db.tx, input.plan, {target: 'testing'})
  t.is(db.writes.length, 0)
  const result = await consolidateReviewedInTransaction(db.tx, input.plan, {target: 'testing', expectedReport})
  t.true(result.appliedInTransaction)
  t.true(result.protectedDataPreserved)
  t.is(db.tables.declarantPointPrelevement[0].id, id('source-exploitation'))
  t.is(db.tables.declarantPointPrelevement[0].pointPrelevementId, id('target'))
  t.deepEqual(db.tables.meterAllocationVersion, originalVersions)
  t.is(db.tables.meterAllocation[0].id, id('allocation'))
  t.is(db.tables.meterStream[0].enabled, false)
  t.is(db.tables.meterPublication.length, 0)
  t.is(db.tables.chunkValue.length, 0)
  t.truthy(db.tables.pointPrelevement.find(row => row.id === id('source')).deletedAt)
  t.is(db.tables.pointPrelevement.find(row => row.id === id('source')).name, `merged:${id('source')}`)
  t.true(db.tables.externalReference.some(row => row.provider === 'pe-import-alias' && row.externalId === id('source') && row.pointPrelevementId === id('target')))
  const movedReference = db.tables.externalReference.find(row => row.id === id('source-reference'))
  t.is(movedReference.pointPrelevementId, id('target'))
  t.deepEqual(movedReference.metadata, {imported: {name: 'Ancien donneur'}, retainedProof: 'synthetic', mergedFromPointId: id('source')})
  t.deepEqual(db.tables.externalReference.find(row => row.id === id('reference')).metadata, {imported: {name: 'Survivant canonique'}})
  t.true(db.writes.indexOf('meterVolumeContribution.deleteMany') < db.writes.indexOf('meterPublication.deleteMany'))
  t.true(db.writes.indexOf('meterPublication.deleteMany') < db.writes.indexOf('source.deleteMany'))
  t.true(db.writes.indexOf('meterAllocation.deleteMany') < db.writes.indexOf('declarantPointPrelevement.update'))
  const lockQueries = db.sql.filter(query => query.includes('pg_advisory_xact_lock'))
  t.true(lockQueries[0].includes('dropt-referential'))
  t.true(lockQueries[1].includes('physical-meter'))
  t.true(lockQueries[2].includes('volumes-from-index'))
  t.false(db.writes.some(operation => /meterReading|meterIngestion|user\./.test(operation)))

  const replay = await inspectReviewedConsolidation(db.tx, input.plan, {target: 'testing'})
  t.true(replay.complete)
  t.is(replay.counts.pointsMerged, 0)
  t.is(replay.counts.publicationsDeleted, 0)
})

test('la mutation refuse tout changement depuis la simulation avant la première écriture', async t => {
  const input = fixture()
  const db = fakeDatabase(input.inventory)
  const expectedReport = await inspectReviewedConsolidation(db.tx, input.plan, {target: 'testing'})
  db.tables.pointPrelevement[1].comment = 'Modification concurrente synthétique'
  await t.throwsAsync(() => consolidateReviewedInTransaction(db.tx, input.plan, {target: 'testing', expectedReport}), {
    message: 'CONSOLIDATION_STATE_CHANGED_SINCE_REVIEW'
  })
  t.is(db.writes.length, 0)
})

test('une cible prod ou une preuve absente est refusée sans mutation', async t => {
  const input = fixture()
  const db = fakeDatabase(input.inventory)
  await t.throwsAsync(() => inspectReviewedConsolidation(db.tx, input.plan, {target: 'prod'}), {message: 'REBUILD_TARGET_FORBIDDEN'})
  await t.throwsAsync(() => consolidateReviewedInTransaction(db.tx, input.plan, {target: 'testing'}), {message: 'CONSOLIDATION_APPROVED_PLAN_REQUIRED'})
  t.is(db.writes.length, 0)
})

test('réinitialiser un seul compteur préserve les index, bénéficiaires et compteurs hors périmètre', async t => {
  const input = withMeter(fixture())
  input.plan.merges = []
  input.plan.resetMeterIds = [id('meter')]
  input.inventory.streams[0] = {...input.inventory.streams[0], enabled: true, activatedAt: '2026-01-01T00:00:00Z',
    allocationSnapshotValidated: true, allocationSnapshot: [{synthetic: true}], lastSuccessAt: '2026-09-28T00:00:00Z', cursor: {page: 2}}
  input.inventory.meters.push({id: id('outside-meter')})
  const outsideStream = {id: id('outside-stream'), compteurId: id('outside-meter'), enabled: true, provider: 'rives-et-eaux', scope: 'epidropt'}
  input.inventory.streams.push(outsideStream)
  const originalPoints = structuredClone(input.inventory.points)
  const originalExploitations = structuredClone(input.inventory.exploitations)
  const db = fakeDatabase(input.inventory)
  const expectedReport = await inspectReviewedConsolidation(db.tx, input.plan, {target: 'testing'})
  const result = await consolidateReviewedInTransaction(db.tx, input.plan, {target: 'testing', expectedReport})
  t.true(result.protectedDataPreserved)
  t.deepEqual(db.tables.pointPrelevement, originalPoints)
  t.deepEqual(db.tables.declarantPointPrelevement, originalExploitations)
  t.is(db.tables.meterAllocation.length, 0)
  t.is(db.tables.meterAllocationVersion.length, 0)
  t.is(db.tables.meterPublication.length, 0)
  t.is(db.tables.chunk.length, 0)
  const stream = db.tables.meterStream.find(item => item.id === id('stream'))
  t.false(stream.enabled)
  t.is(stream.activatedAt, null)
  t.false(stream.allocationSnapshotValidated)
  t.deepEqual(stream.allocationSnapshot, [])
  t.deepEqual(stream.cursor, {page: 2})
  t.is(stream.lastSuccessAt, '2026-09-28T00:00:00Z')
  t.deepEqual(db.tables.meterStream.find(item => item.id === id('outside-stream')), outsideStream)
  t.false(db.writes.some(operation => /meterReading|meterIngestion|user\./.test(operation)))
  const replay = await inspectReviewedConsolidation(db.tx, input.plan, {target: 'testing'})
  t.true(replay.complete)
  t.is(replay.counts.metersReset, 0)
  t.is(replay.counts.metersResetAlreadyApplied, 1)
  t.is(replay.counts.allocationsReset, 0)
  t.is(replay.counts.publicationsDeleted, 0)
  await consolidateReviewedInTransaction(db.tx, input.plan, {target: 'testing', expectedReport: replay})
  t.deepEqual(db.tables.declarantPointPrelevement, originalExploitations)
})

test('retirer explicitement une exploitation supprime ses seuls liens collecteurs et reste rejouable', async t => {
  const input = fixture()
  input.plan.merges = []
  input.plan.retireExploitationIds = [id('source-exploitation')]
  input.inventory.exploitations.push(exploitation('target-exploitation', id('target')))
  input.inventory.collecteurs = [
    {id: id('retired-collector'), exploitationId: id('source-exploitation'), collecteurUserId: id('collector')},
    {id: id('kept-collector'), exploitationId: id('target-exploitation'), collecteurUserId: id('collector')}
  ]
  const db = fakeDatabase(input.inventory)
  const expectedReport = await inspectReviewedConsolidation(db.tx, input.plan, {target: 'testing'})
  t.is(expectedReport.counts.collectorLinksDeleted, 1)
  await consolidateReviewedInTransaction(db.tx, input.plan, {target: 'testing', expectedReport})
  t.deepEqual(db.tables.declarantPointPrelevement.map(item => item.id), [id('target-exploitation')])
  t.deepEqual(db.tables.declarantCollecteurExploitation.map(item => item.id), [id('kept-collector')])
  t.true(db.tables.pointPrelevement.every(item => !item.deletedAt))
  const replay = await inspectReviewedConsolidation(db.tx, input.plan, {target: 'testing'})
  t.true(replay.complete)
  t.is(replay.counts.exploitationsRetired, 0)
})

test('le ledger empêche de supprimer à nouveau les affectations recréées par le manifeste', async t => {
  const input = withMeter(fixture())
  input.plan.merges = []
  input.plan.resetMeterIds = [id('meter')]
  const db = fakeDatabase(input.inventory)
  const expectedReport = await inspectReviewedConsolidation(db.tx, input.plan, {target: 'testing'})
  await consolidateReviewedInTransaction(db.tx, input.plan, {target: 'testing', expectedReport})
  const resetLedger = db.tables.externalReference.find(item => item.provider === 'pe-import-reset')
  t.is(resetLedger.compteurId, id('meter'))
  t.is(resetLedger.metadata.planHash, expectedReport.planHash)
  const recreatedAllocation = {...input.inventory.allocations[0], id: id('recreated-allocation')}
  const recreatedVersion = {id: id('recreated-version'), allocationId: recreatedAllocation.id,
    enabled: false, startDate: null, endDate: null, metadata: {manifestHash: 'synthetic-manifest'}}
  db.tables.meterAllocation.push(recreatedAllocation)
  db.tables.meterAllocationVersion.push(recreatedVersion)
  const stream = db.tables.meterStream.find(item => item.id === id('stream'))
  stream.allocationSnapshotValidated = true
  stream.allocationSnapshot = [{key: 'new-reference', percentage: 100}]
  const replay = await inspectReviewedConsolidation(db.tx, input.plan, {target: 'testing'})
  t.true(replay.complete)
  t.is(replay.counts.metersReset, 0)
  t.deepEqual(replay.meterIds, [])
  await consolidateReviewedInTransaction(db.tx, input.plan, {target: 'testing', expectedReport: replay})
  t.deepEqual(db.tables.meterAllocation, [recreatedAllocation])
  t.deepEqual(db.tables.meterAllocationVersion, [recreatedVersion])
  t.true(stream.allocationSnapshotValidated)
  t.deepEqual(stream.allocationSnapshot, [{key: 'new-reference', percentage: 100}])
  t.is(db.tables.externalReference.filter(item => item.provider === 'pe-import-reset').length, 1)

  stream.enabled = true
  const changed = await inspectReviewedConsolidation(db.tx, input.plan, {target: 'testing'})
  t.true(hasBlock(changed, 'RESET_METER_ALREADY_RESET_STATE_CHANGED'))
  t.is(changed.counts.publicationsDeleted, 0)
})

test('un ledger ne permet ni reprise active ni effacement de nouveaux volumes sous une ancienne autorisation', t => {
  for (const change of [
    input => { input.inventory.streams[0].activatedAt = '2026-09-28T00:00:00Z' },
    input => { input.inventory.publications.push({id: id('new-publication'), compteurId: id('meter'), sourceId: id('new-source')}) },
    input => { input.inventory.versions[0].enabled = true }
  ]) {
    const input = withMeter(fixture())
    input.plan.merges = []
    input.plan.resetMeterIds = [id('meter')]
    const planHash = review(input).planHash
    input.inventory.references.push({provider: 'pe-import-reset', scope: 'epidropt', kind: 'METER',
      externalId: `${planHash}:${id('meter')}`, compteurId: id('meter'), metadata: {planHash}})
    input.inventory.publications = []
    input.inventory.sources = []
    input.inventory.contributions = []
    input.inventory.chunks = []
    input.inventory.values = []
    change(input)
    const report = review(input)
    t.true(hasBlock(report, 'RESET_METER_ALREADY_RESET_STATE_CHANGED'))
    t.is(report.counts.metersReset, 0)
    t.is(report.counts.publicationsDeleted, 0)
  }
})
