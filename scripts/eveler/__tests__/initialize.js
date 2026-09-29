import {mkdtemp, chmod, mkdir, symlink, stat, rm, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'ava'
import {normalizeManifest, digest} from '../manifest.js'
import {buildPlan} from '../plan.js'
import {parseOptions, assertReviewedPreflight, checkTarget, safeError} from '../initialize.js'
import {readPrivateFile, reservePrivateReport} from '../private-files.js'
import {fixture, existingFixture, manifestInput} from '../fixtures/synthetic.js'

test('private manifest rejects secrets, unknown fields, invented exploitation dates and ambiguous timestamps', t => {
  for (const input of [
    {...manifestInput, clientSecret: 'not-a-real-secret'},
    {...manifestInput, exploitation: {...manifestInput.exploitation, startDate: '2020-01-01'}},
    {...manifestInput, connector: {...manifestInput.connector, sourceStartDate: '2025-01-02T03:00:00'}},
    {...manifestInput, connector: {...manifestInput.connector, sourceMeterId: undefined}},
    {...manifestInput, connector: {...manifestInput.connector, sourceMeterId: 'synthetic-meter'}},
    {...manifestInput, point: {...manifestInput.point, sourceId: 'unscoped'}}
  ]) t.throws(() => normalizeManifest(input), {message: /^MANIFEST_INVALID:/})
})

test('source start accepts explicit offsets and date-only UTC without creating an exploitation date', t => {
  const input = structuredClone(manifestInput)
  input.connector.sourceStartDate = '2025-01-02T04:00:00+01:00'
  t.is(normalizeManifest(input).connector.sourceStartDate, '2025-01-02T03:00:00.000Z')
  input.connector.sourceStartDate = '2025-01-02'
  t.is(normalizeManifest(input).connector.sourceStartDate, '2025-01-02T00:00:00.000Z')
  t.false(Object.hasOwn(normalizeManifest(input).exploitation, 'startDate'))
})

test('commune name comes from the existing official-code helper', t => {
  const input = structuredClone(manifestInput)
  input.point.communeCode = '75056'
  t.is(normalizeManifest(input).point.communeName, 'Paris')
})

test('plan creates only the scoped entities and geographic links', t => {
  const {manifest, inventory} = fixture()
  t.deepEqual(buildPlan(manifest, inventory).actions, ['create-point', 'create-user', 'create-preleveur-profile', 'create-exploitation', 'create-connector', 'add-point-zones', 'add-preleveur-zones'])
})

test('replay is a no-op and preserves extra properties, links and known exploitation start', t => {
  const {manifest, inventory} = existingFixture()
  inventory.points[0].internalComment = 'Do not change'
  inventory.points[0].identifiers.EXTRA = 'retained'
  inventory.pointZones.push('manual-zone')
  inventory.declarantZones.push('manual-zone')
  inventory.exploitations[0].startDate = '2020-02-03'
  t.deepEqual(buildPlan(manifest, inventory).actions, [])
})

test('source, email, SIRET, geometry, connector and status conflicts fail closed', t => {
  const changes = [
    ['points', 'sourceId', 'other', 'POINT_CONFLICT'],
    ['points', 'coordinateDistance', 2, 'POINT_COORDINATES_CONFLICT'],
    ['points', 'usageName', 'Autre usage', 'POINT_CONFLICT'],
    ['users', 'siret', '11111111111111', 'PRELEVEUR_CONFLICT'],
    ['users', 'email', 'other@example.test', 'USER_CONFLICT'],
    ['exploitations', 'status', 'ABANDONNEE', 'EXPLOITATION_CONFLICT'],
    ['exploitations', 'comment', 'Commentaire existant à conserver', 'EXPLOITATION_CONFLICT'],
    ['connectors', 'rate', 50, 'CONNECTOR_CONFLICT']
  ]
  for (const [table, key, value, error] of changes) {
    const {manifest, inventory} = existingFixture()
    inventory[table][0][key] = value
    t.throws(() => buildPlan(manifest, inventory), {message: new RegExp(`^${error}`)})
  }
})

test('snowmaking sub-usage resolves to its actual root and rejects a changed catalog hierarchy', t => {
  const {manifest, inventory} = fixture()
  t.deepEqual(buildPlan(manifest, inventory).usageResolution, {
    requestedCode: '7E', requestedLabel: 'Canon à neige', primaryCode: '7', primaryId: 'root-usage-id', comment: 'Usage SANDRE : 7E — Canon à neige.'
  })
  inventory.usage.parentCode = '4'
  t.throws(() => buildPlan(manifest, inventory), {message: 'USAGE_HIERARCHY_CONFLICT'})
})

test('provider internal meter identity remains distinct and existing mismatches block replay', t => {
  const {manifest, inventory} = existingFixture()
  t.not(manifest.connector.sourceMeterId, manifest.connector.sourcePointId)
  t.deepEqual(buildPlan(manifest, inventory).actions, [])
  inventory.connectors[0].connectorParameters.sourceMeterId = '000000000000000000000002'
  t.throws(() => buildPlan(manifest, inventory), {message: 'CONNECTOR_PARAMETERS_CONFLICT'})
  delete inventory.connectors[0].connectorParameters.sourceMeterId
  t.throws(() => buildPlan(manifest, inventory), {message: 'CONNECTOR_PARAMETERS_CONFLICT'})
})

test('duplicate or reserved identities are rejected', t => {
  for (const table of ['points', 'users', 'exploitations', 'connectors']) {
    const {manifest, inventory} = existingFixture()
    inventory[table].push({...inventory[table][0], id: 'another'})
    t.throws(() => buildPlan(manifest, inventory), {message: /AMBIGUOUS/})
  }
  const {manifest, inventory} = fixture()
  inventory.emailIdentity = {verificationUserId: 'another-user'}
  t.throws(() => buildPlan(manifest, inventory), {message: 'EMAIL_RESERVED'})
})

test('existing service account is only verified and produces no grant or credential action', t => {
  const {manifest, inventory} = existingFixture()
  manifest.serviceAccount = {existingId: 'service-id'}
  inventory.accounts = [{id: 'service-id', isActive: true, deletedAt: null}]
  t.deepEqual(buildPlan(manifest, inventory).actions, [])
  inventory.accounts[0].isActive = false
  t.throws(() => buildPlan(manifest, inventory), {message: /^SERVICE_ACCOUNT_CONFLICT/})
})

test('CLI defaults to dry run and requires target plus reviewed hash for apply', t => {
  const args = ['--target', 'testing', '--manifest', '/private/input.json', '--report', '/private/output.json']
  t.falsy(parseOptions(args).apply)
  t.throws(() => parseOptions([...args, '--apply']), {message: 'APPROVED_PREFLIGHT_REQUIRED'})
  t.throws(() => parseOptions([...args, '--target', 'local']), {message: 'OPTIONS_REQUIRED'})
  t.throws(() => parseOptions([...args, '--verify', '--apply']), {message: 'OPTIONS_CONFLICT'})
})

test('preflight binds target, manifest, inventory and actual database identity', t => {
  const input = {target: 'testing', manifestHash: 'manifest', inventoryHash: 'inventory', identity: {databaseName: 'testing'}}
  const reviewed = {...input, schemaVersion: 1, operation: 'preflight', status: 'verified'}
  t.notThrows(() => assertReviewedPreflight({...input, reviewed}))
  for (const changed of [{target: 'prod'}, {manifestHash: 'changed'}, {inventoryHash: 'changed'}, {identity: {databaseName: 'prod'}}]) {
    t.throws(() => assertReviewedPreflight({...input, ...changed, reviewed}), {message: 'PREFLIGHT_CHANGED_OR_WRONG_TARGET'})
  }
  t.is(digest({b: 2, a: 1}), digest({a: 1, b: 2}))
})

test('connected target accepts only the exact expected server IP with optional /32', async t => {
  const identity = {databaseName: 'testing-partageons-leau-api', databaseUser: 'testing-partageons-leau-api', serverAddress: '172.16.16.3', serverPort: 5432, tls: true}
  const client = serverAddress => ({query: async () => ({rows: [{...identity, serverAddress}]})})
  t.deepEqual(await checkTarget(client('172.16.16.3'), 'testing'), identity)
  t.deepEqual(await checkTarget(client('172.16.16.3/32'), 'testing'), identity)
  for (const address of ['172.16.16.3/24', '172.16.16.30', '172.16.20.3', '127.0.0.1']) {
    await t.throwsAsync(checkTarget(client(address), 'testing'), {message: 'CONNECTED_DATABASE_ENDPOINT_MISMATCH'})
  }
})

test('reports are exclusive mode 0600 and private files reject symlinks, public directories and Git', async t => {
  const directory = await mkdtemp(path.join(os.homedir(), '.eveler-private-tests-'))
  t.teardown(() => rm(directory, {recursive: true, force: true}))
  const filename = path.join(directory, 'report.json')
  const report = await reservePrivateReport(filename)
  await report.write({test: true})
  await report.close()
  t.is((await stat(filename)).mode & 0o777, 0o600)
  t.deepEqual(JSON.parse(await readPrivateFile(filename)), {test: true})
  await t.throwsAsync(reservePrivateReport(filename), {code: 'EEXIST'})
  const link = path.join(directory, 'link.json')
  await symlink(filename, link)
  await t.throwsAsync(readPrivateFile(link))
  await chmod(directory, 0o755)
  await t.throwsAsync(readPrivateFile(filename), {message: 'PRIVATE_DIRECTORY_REQUIRED'})
  await chmod(directory, 0o700)
  await mkdir(path.join(directory, '.git'))
  await t.throwsAsync(readPrivateFile(filename), {message: 'PRIVATE_FILE_INSIDE_GIT'})
})

test('public-readable inputs and data-bearing driver errors are rejected or redacted', async t => {
  const directory = await mkdtemp(path.join(os.homedir(), '.eveler-input-tests-'))
  t.teardown(() => rm(directory, {recursive: true, force: true}))
  const filename = path.join(directory, 'input.json')
  await writeFile(filename, '{}', {mode: 0o644})
  await t.throwsAsync(readPrivateFile(filename), {message: 'PRIVATE_FILE_MODE_REQUIRED'})
  t.is(safeError(new Error('duplicate key containing synthetic@example.test')), 'INITIALIZATION_FAILED_REVIEW_PRIVATE_REPORT')
  t.is(safeError(new Error('POINT_CONFLICT: name,sourceId')), 'POINT_CONFLICT: name,sourceId')
})
