import {mkdtemp, readFile, stat, writeFile, rm, mkdir, symlink} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
import test from 'ava'
import {parseOptions, writePrivateJson, verifyBackupProof} from '../lib/cli.js'

const base = ['--target', 'testing', '--target-env', '/private/testing.env', '--tunnel-port', '55442']

test('la simulation est la commande par défaut et impose une cible explicite', t => {
  const result = parseOptions([...base, '--report', '/private/review.json'])
  t.is(result.command, 'review')
  t.is(result.port, 55442)
  t.throws(() => parseOptions(['--report', '/private/review.json']))
  t.throws(() => parseOptions([...base, '--target', 'local', '--report', '/private/review.json']))
  for (const port of ['543', '65536', '5e4', '-1']) {
    t.throws(() => parseOptions([...base, '--tunnel-port', port, '--report', '/private/review.json']))
  }
})

test('application et rollback exigent leurs preuves sans écraser une entrée', t => {
  const apply = ['apply', ...base, '--against-report', '/private/review.json', '--receipt', '/private/apply.json']
  t.throws(() => parseOptions(apply))
  t.is(parseOptions([...apply, '--backup-proof', '/private/backup.json']).command, 'apply')
  t.throws(() => parseOptions([...apply, '--backup-proof', '/private/backup.json', '--receipt', '/private/review.json']))
  t.throws(() => parseOptions([...base, '--report', '/private/review.json', '--receipt', '/private/apply.json']))
  t.is(parseOptions(['rollback', ...base, '--against-receipt', '/private/apply.json', '--receipt', '/private/rollback.json']).command, 'rollback')
  t.throws(() => parseOptions(['rollback', ...base, '--receipt', '/private/rollback.json']))
})

test('les rapports sont privés, exclusifs puis remplacés atomiquement après préparation', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sage-cli-'))
  t.teardown(() => rm(directory, {recursive: true, force: true}))
  const filename = path.join(directory, 'receipt.json')
  await writePrivateJson(filename, {status: 'PREPARED'})
  t.is((await stat(filename)).mode & 0o777, 0o600)
  await t.throwsAsync(writePrivateJson(filename, {status: 'OTHER'}), {code: 'EEXIST'})
  t.deepEqual(JSON.parse(await readFile(filename, 'utf8')), {status: 'PREPARED'})
  await writePrivateJson(filename, {status: 'COMMITTED'}, {replace: true})
  t.deepEqual(JSON.parse(await readFile(filename, 'utf8')), {status: 'COMMITTED'})
})

test('la preuve lie la cible, la restauration et les octets de la sauvegarde', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sage-proof-'))
  t.teardown(() => rm(directory, {recursive: true, force: true}))
  const backupFile = path.join(directory, 'backup.dump')
  const proofFile = path.join(directory, 'proof.json')
  await writeFile(backupFile, 'synthetic backup')
  const review = {stateHash: 'a'.repeat(64)}
  const proof = {target: 'testing', backupFile, backupSha256: createHash('sha256').update('synthetic backup').digest('hex'),
    restoredAt: new Date().toISOString(), restoreMatched: true, stateHash: review.stateHash}
  await writePrivateJson(proofFile, proof)
  await t.notThrowsAsync(verifyBackupProof(proofFile, 'testing', review))
  await t.throwsAsync(verifyBackupProof(proofFile, 'prod', review))
  await t.throwsAsync(verifyBackupProof(proofFile, 'testing', {stateHash: 'b'.repeat(64)}))
  await writeFile(backupFile, 'modified')
  await t.throwsAsync(verifyBackupProof(proofFile, 'testing', review))
  await writePrivateJson(proofFile, {...proof, restoreMatched: false}, {replace: true})
  await t.throwsAsync(verifyBackupProof(proofFile, 'testing', review))
})

test('les rapports refusent aussi les autres dépôts et leurs chemins symboliques', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sage-git-'))
  t.teardown(() => rm(directory, {recursive: true, force: true}))
  const repositoryPath = path.join(directory, 'other-repository')
  await mkdir(path.join(repositoryPath, '.git'), {recursive: true})
  await symlink(repositoryPath, path.join(directory, 'alias'))
  await t.throwsAsync(writePrivateJson(path.join(repositoryPath, 'receipt.json'), {}))
  await t.throwsAsync(writePrivateJson(path.join(directory, 'alias', 'receipt.json'), {}))
})
