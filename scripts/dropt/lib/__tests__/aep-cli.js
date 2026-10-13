import test from 'ava'
import path from 'node:path'
import os from 'node:os'
import {createHash} from 'node:crypto'
import {mkdtemp, readFile, writeFile, mkdir, stat, rm} from 'node:fs/promises'
import {parseAepOptions, preserveAepInput, saveAepManifest, loadAepManifest, assertAepReviewedReport, aepCodeHash} from '../aep-cli.js'
import {digest} from '../aep-source.js'
import {verifyBackupProof, connectionOptions, writePrivateJson} from '../../../sage-overlap/lib/cli.js'

const sha = value => createHash('sha256').update(value).digest('hex')
const args = (command = 'apply', target = 'prod') => [command, '--input', '/tmp/aep-synthetic-input', '--target', target,
  '--target-env', '/tmp/aep-synthetic.env', '--tunnel-port', '55441', '--report', '/tmp/aep-synthetic-report.json']
const review = () => ({operation: 'import-dropt-aep', target: 'prod', codeHash: 'a'.repeat(64),
  manifestHash: 'b'.repeat(64), stateHash: 'c'.repeat(64), planHash: 'd'.repeat(64), applied: false, complete: true, blocked: []})

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aep-cli-synthetic-'))
  t.teardown(() => rm(directory, {recursive: true, force: true}))
  return directory
}

test('review, apply et verify restent sans mutation par défaut, avec tunnel et cible explicites', t => {
  for (const command of ['review', 'apply', 'verify']) {
    for (const target of ['testing', 'prod']) {
      const options = parseAepOptions(args(command, target))
      t.is(options.command, command)
      t.false(options.values.apply)
      t.is(options.values.target, target)
      t.is(options.port, 55441)
    }
  }
})

test('apply --apply exige simulation et preuve de sauvegarde ; review et verify refusent une mutation', t => {
  const required = ['--against-report', '/tmp/aep-review.json', '--backup-proof', '/tmp/aep-proof.json']
  t.true(parseAepOptions([...args(), '--apply', ...required]).values.apply)
  for (const command of ['review', 'verify']) {
    t.throws(() => parseAepOptions([...args(command), '--apply', ...required]), {message: 'AEP_APPLY_OPTION_INVALID'})
  }
  for (const extra of [[], required.slice(0, 2), required.slice(2)]) {
    t.throws(() => parseAepOptions([...args(), '--apply', ...extra]), {message: 'AEP_REVIEW_AND_BACKUP_REQUIRED'})
  }
})

test('rollback exige une application explicite et le reçu, sans pouvoir écraser ce dernier', t => {
  t.throws(() => parseAepOptions(args('rollback')), {message: 'AEP_ROLLBACK_APPLY_REQUIRED'})
  t.throws(() => parseAepOptions([...args('rollback'), '--apply']), {message: 'AEP_REVIEW_AND_BACKUP_REQUIRED'})
  const parameters = [...args('rollback'), '--apply', '--against-report', '/tmp/aep-apply-receipt.json']
  t.true(parseAepOptions(parameters).values.apply)
  t.is(parseAepOptions(parameters).command, 'rollback')
  t.throws(() => parseAepOptions([...parameters, '--backup-proof', '/tmp/proof.json']), {message: 'AEP_REPORT_ARGUMENTS_INVALID'})
  t.throws(() => parseAepOptions([...parameters, '--report', '/tmp/aep-apply-receipt.json']), {message: 'AEP_OUTPUT_OVERWRITES_INPUT'})
})

test('les cibles hors périmètre, tunnels implicites et mélanges d’options sont refusés', t => {
  for (const target of ['demo', 'production', 'restored-copy', 'local']) {
    t.throws(() => parseAepOptions(args('apply', target)), {message: 'AEP_TARGET_ARGUMENTS_INVALID'})
  }
  for (const port of ['0', '5432x', '1023', '65536', '1.2']) {
    t.throws(() => parseAepOptions([...args(), '--tunnel-port', port]), {message: 'AEP_TUNNEL_REQUIRED'})
  }
  t.throws(() => parseAepOptions(args().filter((_, index) => ![7, 8].includes(index))), {message: 'AEP_TUNNEL_REQUIRED'})
  t.throws(() => parseAepOptions([...args('review'), '--against-report', '/tmp/review.json']), {message: 'AEP_REPORT_ARGUMENTS_INVALID'})
  t.throws(() => parseAepOptions([...args(), '--backup-proof', '/tmp/proof.json']), {message: 'AEP_REPORT_ARGUMENTS_INVALID'})
  t.throws(() => parseAepOptions([...args(), '--aep-file', '/tmp/source.xlsx']), {message: 'AEP_TARGET_ARGUMENTS_INVALID'})
  t.throws(() => parseAepOptions([...args(), 'unexpected']), {message: 'AEP_ARGUMENTS_INVALID'})
})

test('prepare exige les deux sources et les décisions, sans option distante', t => {
  const prepare = ['prepare', '--input', '/tmp/aep-synthetic', '--aep-file', '/tmp/aep.xlsx', '--legacy-file', '/tmp/legacy.xlsx', '--decisions', '/tmp/decisions.json']
  t.is(parseAepOptions(prepare).command, 'prepare')
  for (const addition of [['--target', 'prod'], ['--report', '/tmp/report.json'], ['--apply']]) {
    t.throws(() => parseAepOptions([...prepare, ...addition]))
  }
  t.throws(() => parseAepOptions(prepare.slice(0, -2)), {message: 'AEP_PREPARE_ARGUMENTS_INVALID'})
})

test('une sortie ne remplace jamais le fichier de connexion, la simulation ou la preuve', t => {
  for (const filename of ['/tmp/aep-synthetic.env', '/tmp/review.json', '/tmp/proof.json']) {
    t.throws(() => parseAepOptions([...args(), '--apply', '--against-report', '/tmp/review.json',
      '--backup-proof', '/tmp/proof.json', '--report', filename]), {message: 'AEP_OUTPUT_OVERWRITES_INPUT'})
  }
})

test('une revue doit correspondre au code, au manifeste, à la cible et à une simulation complète', t => {
  const expected = {target: 'prod', codeHash: 'a'.repeat(64), manifestHash: 'b'.repeat(64)}
  t.notThrows(() => assertAepReviewedReport(review(), expected))
  for (const replacement of [{operation: 'other'}, {target: 'testing'}, {codeHash: 'e'.repeat(64)},
    {manifestHash: 'e'.repeat(64)}, {applied: true}, {complete: false}, {blocked: [{code: 'BLOCKED'}]},
    {stateHash: 'invalid'}, {planHash: ''}]) {
    t.throws(() => assertAepReviewedReport({...review(), ...replacement}, expected), {message: 'AEP_REVIEW_MISMATCH'})
  }
  t.throws(() => assertAepReviewedReport(undefined, expected), {message: 'AEP_REVIEW_MISMATCH'})
})

test('les sources sont conservées sans écrasement et un même nom avec un autre contenu est refusé', async t => {
  const directory = await temporaryDirectory(t)
  const source = path.join(directory, 'source.xlsx')
  const input = path.join(directory, 'bundle')
  await writeFile(source, 'synthetic workbook bytes')
  const stored = await preserveAepInput(source, input)
  t.is(await readFile(stored, 'utf8'), 'synthetic workbook bytes')
  t.is((await stat(stored)).mode & 0o777, 0o400)
  t.is(await preserveAepInput(source, input), stored)
  await writeFile(source, 'changed synthetic workbook')
  await t.throwsAsync(() => preserveAepInput(source, input), {code: 'EEXIST'})
  t.is(await readFile(stored, 'utf8'), 'synthetic workbook bytes')
})

test('le manifeste archivé et les hashes des sources sont vérifiés à chaque lecture', async t => {
  const directory = await temporaryDirectory(t)
  await mkdir(path.join(directory, 'raw'))
  const sources = [{name: 'aep.xlsx', sha256: sha('aep')}, {name: 'legacy.xlsx', sha256: sha('legacy')}]
  for (const name of ['aep', 'legacy']) await writeFile(path.join(directory, 'raw', `${name}.xlsx`), name)
  const payload = {version: 1, kind: 'dropt-aep', sources, points: [], declarants: [], exploitations: [], retirements: [], issues: [], decisions: {synthetic: true}}
  const manifest = {...payload, manifestHash: digest(payload)}
  await saveAepManifest(directory, manifest)
  await saveAepManifest(directory, manifest)
  t.deepEqual(await loadAepManifest(directory, digest), manifest)
  const archive = path.join(directory, 'mapping/manifests', `${manifest.manifestHash}.json`)
  const archiveBytes = await readFile(archive, 'utf8')
  await writeFile(path.join(directory, 'raw/aep.xlsx'), 'changed')
  await t.throwsAsync(() => loadAepManifest(directory, digest), {message: 'AEP_SOURCE_HASH_MISMATCH'})
  await writeFile(path.join(directory, 'mapping/manifest.json'), JSON.stringify({...manifest, points: [{id: 'tampered'}]}))
  await t.throwsAsync(() => loadAepManifest(directory, digest), {message: 'AEP_MANIFEST_HASH_MISMATCH'})
  t.is(await readFile(archive, 'utf8'), archiveBytes)
})

test('une source ne peut pas sortir de raw par un chemin relatif', async t => {
  const directory = await temporaryDirectory(t)
  const payload = {sources: [{name: '../outside.xlsx', sha256: 'a'.repeat(64)}]}
  await saveAepManifest(directory, {...payload, manifestHash: digest(payload)})
  await t.throwsAsync(() => loadAepManifest(directory, digest), {message: 'AEP_SOURCE_HASH_MISMATCH'})
})

test('la preuve exige restauration, cible et état identiques puis rehash la sauvegarde physique', async t => {
  const directory = await temporaryDirectory(t)
  const backupFile = path.join(directory, 'backup.json')
  const proofFile = path.join(directory, 'proof.json')
  await writeFile(backupFile, 'synthetic scoped backup')
  const proof = {target: 'prod', restoreMatched: true, restoredAt: '2026-10-12T00:00:00Z', backupFile,
    backupSha256: sha('synthetic scoped backup'), stateHash: review().stateHash}
  await writeFile(proofFile, JSON.stringify(proof))
  await t.notThrowsAsync(() => verifyBackupProof(proofFile, 'prod', review()))
  for (const change of [{target: 'testing'}, {restoreMatched: false}, {restoredAt: 'invalid'},
    {backupFile: 'relative.json'}, {stateHash: 'e'.repeat(64)}, {backupSha256: 'e'.repeat(64)}]) {
    await writeFile(proofFile, JSON.stringify({...proof, ...change}))
    await t.throwsAsync(() => verifyBackupProof(proofFile, 'prod', review()))
  }
  await writeFile(proofFile, JSON.stringify(proof))
  await writeFile(backupFile, 'modified backup')
  await t.throwsAsync(() => verifyBackupProof(proofFile, 'prod', review()))
})

test('les sorties sont privées, exclusives et remplacées seulement explicitement', async t => {
  const directory = await temporaryDirectory(t)
  const output = path.join(directory, 'receipt.json')
  await writePrivateJson(output, {status: 'PREPARED'})
  t.is((await stat(output)).mode & 0o777, 0o600)
  await t.throwsAsync(() => writePrivateJson(output, {status: 'OTHER'}), {code: 'EEXIST'})
  t.deepEqual(JSON.parse(await readFile(output, 'utf8')), {status: 'PREPARED'})
  await writePrivateJson(output, {status: 'COMMITTED'}, {replace: true})
  t.deepEqual(JSON.parse(await readFile(output, 'utf8')), {status: 'COMMITTED'})
})

test('une URL locale ne peut pas se faire passer pour la base production native', async t => {
  const directory = await temporaryDirectory(t)
  const environment = path.join(directory, 'synthetic.env')
  await writeFile(environment, 'DATABASE_URL=postgresql://synthetic:local-only@localhost:5432/synthetic\n')
  await t.throwsAsync(() => connectionOptions({values: {target: 'prod', 'target-env': environment}, port: 55441}))
})

test('l’empreinte du code couvre un contenu SHA256', async t => {
  t.regex(await aepCodeHash(), /^[a-f0-9]{64}$/)
})
