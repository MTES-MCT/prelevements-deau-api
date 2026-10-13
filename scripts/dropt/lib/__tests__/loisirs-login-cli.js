import test from 'ava'
import {mkdtemp, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {buildManifest, digest} from '../epidropt.js'
import {buildLoisirsManifest} from '../loisirs-source.js'
import {parseLoisirsLoginOptions, buildLoisirsLoginManifest, verifyLoisirsLoginBackup} from '../../enable-loisirs-login.js'

const ownerId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const args = ['--input', '/private/loisirs', '--owner', ownerId, '--target', 'prod', '--target-env', '/private/prod.env',
  '--tunnel-port', '55441', '--report', '/private/review.json']

function manifestFixture() {
  const epidropt = {'Points prélèvement': [], Préleveurs: [], Exploitations: []}
  for (let index = 0; index < 2; index++) {
    const row = index + 3
    const name = `LOISIRS-TEST-${index}`
    const email = `loisirs-${index}@example.test`
    const point = Array(38).fill(null)
    Object.assign(point, {1: name, 3: 0.4, 4: 44.6, 7: 'Eau de surface'})
    epidropt['Points prélèvement'].push({row, values: point})
    epidropt.Préleveurs.push({row, values: [null, 'Autres', email, `1234567890000${index}`, `Club fictif ${index}`]})
    epidropt.Exploitations.push({row, values: [null, name, email, 'Loisirs']})
  }
  const previousManifest = buildManifest({epidropt, rives: {Contrat: [], Compteur: [], Lieu: [], Affectation: []}})
  const source = {name: 'synthetic.xlsx', sha256: 'a'.repeat(64)}
  const decisions = {version: 1, sourceSha256: source.sha256, previousManifestHash: previousManifest.manifestHash,
    exploitations: epidropt.Exploitations.map(({row, values}, index) => ({row, rowHash: digest(values), pointName: values[1],
      declarantKey: previousManifest.declarants.find(owner => owner.data.siret === `1234567890000${index}`).key,
      declarantSiret: `1234567890000${index}`}))}
  return buildLoisirsManifest({epidropt, previousManifest, decisions, source})
}

test('CLI connexion exige cible, UUID précis et tunnel explicites', t => {
  t.false(parseLoisirsLoginOptions(args).apply)
  for (const [flag, value] of [['--owner', 'not-an-id'], ['--target', 'local'], ['--tunnel-port', '5432x']]) {
    const invalid = [...args]
    invalid[invalid.indexOf(flag) + 1] = value
    t.throws(() => parseLoisirsLoginOptions(invalid), {message: 'LOISIRS_LOGIN_ARGUMENTS_INVALID'})
  }
  t.throws(() => parseLoisirsLoginOptions(['apply', ...args]), {message: 'LOISIRS_LOGIN_ARGUMENTS_INVALID'})
})

test('CLI application exige simulation et sauvegarde sans pouvoir écraser une entrée', t => {
  t.throws(() => parseLoisirsLoginOptions([...args, '--apply']), {message: 'LOISIRS_LOGIN_REVIEW_BACKUP_REQUIRED'})
  t.throws(() => parseLoisirsLoginOptions([...args, '--against-report', '/private/old.json']), {message: 'LOISIRS_LOGIN_REVIEW_BACKUP_REQUIRED'})
  const apply = [...args, '--apply', '--against-report', '/private/old.json', '--backup-proof', '/private/backup.json']
  t.true(parseLoisirsLoginOptions(apply).apply)
  apply[apply.indexOf('--against-report') + 1] = '/private/review.json'
  t.throws(() => parseLoisirsLoginOptions(apply), {message: 'LOISIRS_LOGIN_OUTPUT_COLLISION'})
})

test('le sous-manifeste de connexion ne sélectionne que le propriétaire autorisé et ses liens', t => {
  const manifest = manifestFixture()
  const before = structuredClone(manifest)
  const selectedId = manifest.declarants[0].id
  const selected = buildLoisirsLoginManifest(manifest, selectedId)
  t.is(selected.inputs.loisirsManifestHash, manifest.manifestHash)
  t.deepEqual(selected.declarants, [manifest.declarants[0]])
  t.is(selected.exploitations.length, 1)
  t.is(selected.exploitations[0].declarantId, selectedId)
  t.is(selected.points.length, 1)
  t.deepEqual(selected.meters, [])
  t.deepEqual(selected.allocations, [])
  const {manifestHash, ...payload} = selected
  t.is(manifestHash, digest(payload))
  t.deepEqual(manifest, before)
  t.throws(() => buildLoisirsLoginManifest(manifest, ownerId), {message: 'LOISIRS_LOGIN_OWNER_INVALID'})
})

test('preuve native lie propriétaire, état de connexion, manifeste source et contenu sauvegardé', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'loisirs-login-proof-'))
  t.teardown(() => rm(directory, {recursive: true, force: true}))
  const backupFile = path.join(directory, 'backup.json')
  const backup = JSON.stringify({synthetic: true})
  await writeFile(backupFile, backup, {mode: 0o600})
  const metadata = {target: 'prod', ownerId, sourceManifestHash: 'a'.repeat(64)}
  const expected = {result: {entries: [{stateHash: 'b'.repeat(64)}]}}
  const proof = {target: 'prod', ownerId, manifestHash: metadata.sourceManifestHash,
    loginStateHash: expected.result.entries[0].stateHash, restoreMatched: true, restoredAt: '2026-10-12T12:00:00Z',
    backupFile, backupSha256: createHash('sha256').update(backup).digest('hex')}
  const filename = path.join(directory, 'proof.json')
  await writeFile(filename, JSON.stringify(proof), {mode: 0o600})
  await t.notThrowsAsync(verifyLoisirsLoginBackup(filename, metadata, expected))
  for (const update of [{ownerId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'}, {manifestHash: 'c'.repeat(64)},
    {loginStateHash: 'd'.repeat(64)}, {restoreMatched: false}, {target: 'testing'}]) {
    await writeFile(filename, JSON.stringify({...proof, ...update}))
    await t.throwsAsync(verifyLoisirsLoginBackup(filename, metadata, expected), {message: 'LOISIRS_LOGIN_BACKUP_INVALID'})
  }
  await writeFile(filename, JSON.stringify(proof))
  await writeFile(backupFile, '{}')
  await t.throwsAsync(verifyLoisirsLoginBackup(filename, metadata, expected), {message: 'LOISIRS_LOGIN_BACKUP_HASH_INVALID'})
})
