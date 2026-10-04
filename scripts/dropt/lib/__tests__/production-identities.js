import test from 'ava'
import {assertDroptProdIdentityAnchors, guardedDroptProdClient} from '../production-identities.js'

const manifest = {
  points: [{id: 'point', sourceId: 'source-point', references: [{provider: 'epidropt', externalId: 'P'}]}],
  declarants: [{id: 'person', sourceId: 'source-person', references: [{provider: 'epidropt', externalId: 'D'}]}],
  meters: [{id: 'meter', serial: 'SYNTHETIC-METER', references: [{provider: 'epidropt', externalId: 'M'}]}],
  exploitations: [{id: 'exploitation', sourceId: 'source-exploitation'}]
}
const modelKeys = ['pointPrelevement', 'declarant', 'compteur', 'declarantPointPrelevement']
const fixture = (rows = {}, references = []) => ({
  externalReference: {findMany: async () => references},
  ...Object.fromEntries(modelKeys.map(model => [model, {findMany: async () => rows[model] ?? []}]))
})

test('une production vierge ou des UUID explicitement ancrés sont recevables', async t => {
  await t.notThrowsAsync(assertDroptProdIdentityAnchors(fixture(), manifest))
  await t.notThrowsAsync(assertDroptProdIdentityAnchors(fixture({
    pointPrelevement: [{id: 'point', sourceId: 'source-point'}],
    declarant: [{userId: 'person', sourceId: 'source-person'}],
    compteur: [{id: 'meter', serialNumber: 'SYNTHETIC-METER'}],
    declarantPointPrelevement: [{id: 'exploitation', sourceId: 'source-exploitation'}]
  }, [{kind: 'METER', provider: 'epidropt', externalId: 'M', compteurId: 'meter'}]), manifest))
})

test('un UUID importé de testing ne suffit jamais à rapprocher une entité existante en production', async t => {
  const error = await t.throwsAsync(assertDroptProdIdentityAnchors(fixture({
    pointPrelevement: [{id: 'point', sourceId: 'unrelated'}],
    declarant: [{userId: 'person', sourceId: null}],
    compteur: [{id: 'meter', serialNumber: 'SYNTHETIC-METER'}],
    declarantPointPrelevement: [{id: 'exploitation', sourceId: 'unrelated'}]
  }), manifest))
  t.deepEqual(error.identityCollisions.map(row => row.kind), ['POINT', 'DECLARANT', 'METER', 'EXPLOITATION'])
  t.true(error.identityCollisions.every(row => row.code === 'UUID_PRODUCTION_SANS_ANCRAGE'))
})

test('un même numéro de compteur avec un autre UUID exige une référence explicite et est détecté avant écriture', async t => {
  const rows = {compteur: [{id: 'existing-meter', serialNumber: 'SYNTHETIC-METER'}]}
  const error = await t.throwsAsync(assertDroptProdIdentityAnchors(fixture(rows), manifest))
  t.deepEqual(error.identityCollisions, [{kind: 'METER', id: 'existing-meter', code: 'NUMERO_COMPTEUR_PRODUCTION_SANS_ANCRAGE'}])
  await t.notThrowsAsync(assertDroptProdIdentityAnchors(fixture(rows,
    [{kind: 'METER', provider: 'epidropt', externalId: 'M', compteurId: 'existing-meter'}]), manifest))
})

test('les références ne prouvent une identité que pour la bonne entité, le bon fournisseur et la bonne valeur', async t => {
  for (const change of [{kind: 'METER'}, {provider: 'other'}, {externalId: 'other'}, {pointPrelevementId: 'other'}]) {
    await t.throwsAsync(assertDroptProdIdentityAnchors(fixture({pointPrelevement: [{id: 'point'}]},
      [{kind: 'POINT', provider: 'epidropt', externalId: 'P', pointPrelevementId: 'point', ...change}]), manifest))
  }
  await t.notThrowsAsync(assertDroptProdIdentityAnchors(fixture({pointPrelevement: [{id: 'point'}]},
    [{kind: 'POINT', provider: 'epidropt', externalId: 'P', pointPrelevementId: 'point'}]), manifest))
})

test('la transaction contrôle cible et identités sous verrou avant toute mutation, puis conserve ses options', async t => {
  const events = []
  const tx = {...fixture(),
    $executeRaw: async () => { events.push('lock') },
    $queryRawUnsafe: async () => {
      events.push('identity')
      return [{databaseName: 'prod-partageons-leau-api', databaseUser: 'prod-partageons-leau-api', tls: true}]
    }}
  const client = {$transaction: async (execute, options) => {
    t.deepEqual(options, {timeout: 1000, isolationLevel: 'Serializable'})
    return execute(tx)
  }}
  const guarded = guardedDroptProdClient(client, manifest)
  const result = await guarded.$transaction(async database => {
    t.is(database, tx)
    events.push('write')
    return 'done'
  }, {timeout: 1000})
  t.is(result, 'done')
  t.deepEqual(events, ['lock', 'identity', 'write'])
  tx.compteur.findMany = async () => [{id: 'meter', serialNumber: 'SYNTHETIC-METER'}]
  await t.throwsAsync(guarded.$transaction(async () => { t.fail('No mutation after an identity collision') }, {timeout: 1000}))
  t.is(events.filter(event => event === 'write').length, 1)
  tx.$queryRawUnsafe = async () => [{databaseName: 'prod-partageons-leau-api', databaseUser: 'postgres', tls: true}]
  await t.throwsAsync(guarded.$transaction(async () => { t.fail('No mutation against the wrong database identity') }, {timeout: 1000}))
})
