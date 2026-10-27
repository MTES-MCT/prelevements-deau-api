import test from 'ava'
import {buildTransformationContract, manifestLines, stableSourceId} from '../lib/core.js'
import {historyPlanHash} from '../lib/history-target.js'
import {assertPointIdentityBackup, planPointIdentities, pointIdentityScope} from '../sync-point-identities.js'

const point = {id_point: 123, nom: 'Captage synthétique'}
const row = {id: 'uuid-preserved', sourceId: stableSourceId('point', 123), name: point.nom,
  identifiers: {BSS: 'preserved'}, deletedAt: null, updatedAt: '2026-01-01T00:00:00Z'}

test('point replay plans only name and the Réunion identifier on the same UUID', t => {
  const plan = planPointIdentities([point], [row])
  t.is(plan.changes.length, 1)
  t.deepEqual(plan.changes[0], {id: row.id, sourceId: row.sourceId,
    before: {name: row.name, identifiers: row.identifiers}, after: {name: '123 - Captage synthétique', identifiers: {BSS: 'preserved', REUNION: '123'}}})
  t.is(planPointIdentities([point], [{...row, ...plan.changes[0].after}]).changes.length, 0)
  t.deepEqual(row.identifiers, {BSS: 'preserved'})
})

test('point replay refuses missing, duplicate, deleted, conflicting or foreign identities', t => {
  for (const rows of [[], [row, row], [{...row, deletedAt: '2026-01-01'}], [{...row, identifiers: {REUNION: '456'}}],
    [row, {...row, id: 'foreign', sourceId: 'other:123', name: '123 - Captage synthétique'}]]) {
    t.throws(() => planPointIdentities([point], rows))
  }
  t.throws(() => planPointIdentities([point, point], [row]))
})

test('point scope requires the complete immutable Réunion reference and valid numeric IDs', t => {
  const records = Array.from({length: 453}, (_, index) => ({kind: 'point', data: {id_point: index + 1, nom: `Point ${index + 1}`}}))
  const transformationContract = buildTransformationContract({usageMap: '', pointOverrides: '', documentExclusions: ''})
  const content = rows => manifestLines({territory: 'DEP-974', transformationContract}, rows)
  t.is(pointIdentityScope(content(records)).length, 453)
  t.throws(() => pointIdentityScope(content(records.slice(1))))
  t.throws(() => pointIdentityScope(content([...records.slice(1), records[1]])))
  t.throws(() => pointIdentityScope(manifestLines({territory: 'DEP-999', transformationContract}, records)))
})

test('targeted backup binds actual saved rows, source and current simulation', t => {
  const plan = {...planPointIdentities([point], [row]), planHash: 'plan'}
  const evidence = {operation: 'reunion-point-identities', sourceHash: 'source', planHash: 'plan', rowsSha256: historyPlanHash(plan.before)}
  const snapshot = {operation: evidence.operation, sourceHash: 'source', rows: plan.before}
  t.notThrows(() => assertPointIdentityBackup(evidence, snapshot, plan, 'source'))
  for (const change of [{operation: 'history-import'}, {sourceHash: 'other'}, {planHash: 'stale'}, {rowsSha256: 'wrong'}]) {
    t.throws(() => assertPointIdentityBackup({...evidence, ...change}, snapshot, plan, 'source'))
  }
  t.throws(() => assertPointIdentityBackup(evidence, {...snapshot, rows: []}, plan, 'source'))
  t.throws(() => assertPointIdentityBackup(evidence, {...snapshot, sourceHash: 'other'}, plan, 'source'))
})
