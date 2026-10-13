import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'
import {readFile, copyFile, chmod, mkdir, open} from 'node:fs/promises'
import {constants} from 'node:fs'
import {createHash} from 'node:crypto'
import {assertPrivateOutput, writePrivateJson} from '../../sage-overlap/lib/cli.js'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const commands = ['prepare', 'review', 'apply', 'verify', 'rollback']
const sourceOptions = ['aep-file', 'legacy-file', 'decisions']

function validateRemoteArguments(command, values) {
  if (!['testing', 'prod'].includes(values.target) || !values['target-env'] || !values.report || sourceOptions.some(key => values[key])) throw new Error('AEP_TARGET_ARGUMENTS_INVALID')
  if (!/^\d+$/.test(values['tunnel-port'] ?? '') || Number(values['tunnel-port']) < 1024 || Number(values['tunnel-port']) > 65535) throw new Error('AEP_TUNNEL_REQUIRED')
  if (values.apply && (!values['against-report'] || (command === 'apply' && !values['backup-proof']))) throw new Error('AEP_REVIEW_AND_BACKUP_REQUIRED')
  const backupAllowed = values.apply && command === 'apply'
  if ((!backupAllowed && values['backup-proof']) || (!['apply', 'rollback'].includes(command) && values['against-report'])) throw new Error('AEP_REPORT_ARGUMENTS_INVALID')
  const inputs = [values['against-report'], values['backup-proof'], values['target-env']].filter(Boolean).map(file => path.resolve(file))
  if (inputs.includes(path.resolve(values.report))) throw new Error('AEP_OUTPUT_OVERWRITES_INPUT')
}

export function parseAepOptions(args) {
  const {positionals, values} = parseArgs({args, allowPositionals: true, options: {
    ...Object.fromEntries(['input', 'target', 'target-env', 'tunnel-port', 'report', 'against-report', 'backup-proof', ...sourceOptions]
      .map(key => [key, {type: 'string'}])),
    apply: {type: 'boolean', default: false}
  }})
  const command = positionals[0]
  if (positionals.length !== 1 || !commands.includes(command) || !values.input) throw new Error('AEP_ARGUMENTS_INVALID')
  if (values.apply && !['apply', 'rollback'].includes(command)) throw new Error('AEP_APPLY_OPTION_INVALID')
  if (command === 'rollback' && !values.apply) throw new Error('AEP_ROLLBACK_APPLY_REQUIRED')
  if (command === 'prepare') {
    if (sourceOptions.some(key => !values[key]) || ['target', 'target-env', 'tunnel-port', 'against-report', 'backup-proof', 'report'].some(key => values[key])) throw new Error('AEP_PREPARE_ARGUMENTS_INVALID')
  } else validateRemoteArguments(command, values)
  return {command, values, port: Number(values['tunnel-port']), input: path.resolve(values.input)}
}

export const fileSha256 = async filename => createHash('sha256').update(await readFile(filename)).digest('hex')

export async function aepCodeHash() {
  const files = ['scripts/dropt/import-aep.js', 'scripts/dropt/lib/aep-cli.js', 'scripts/dropt/lib/aep-source.js',
    'scripts/dropt/lib/aep-apply.js', 'scripts/dropt/lib/aep-rollback.js', 'scripts/sage-overlap/lib/cli.js', 'lib/services/zone-resource-types.js',
    'scripts/network/prod-database-target.js', 'scripts/network/testing-database-target.js', 'db/connection-options.js']
  const hash = createHash('sha256')
  for (const filename of files) hash.update(filename).update(await readFile(path.join(repository, filename)))
  return hash.digest('hex')
}

export async function preserveAepInput(filename, input) {
  const destination = path.join(input, 'raw', path.basename(filename))
  await assertPrivateOutput(destination)
  try {
    await copyFile(filename, destination, constants.COPYFILE_EXCL)
    await chmod(destination, 0o400)
  } catch (error) {
    if (error.code !== 'EEXIST' || await fileSha256(filename) !== await fileSha256(destination)) throw error
  }
  const file = await open(destination, 'r')
  try { await file.sync() } finally { await file.close() }
  const directory = await open(path.dirname(destination), 'r')
  try { await directory.sync() } finally { await directory.close() }
  return destination
}

export async function saveAepManifest(input, manifest) {
  const archive = path.join(input, 'mapping/manifests', `${manifest.manifestHash}.json`)
  await mkdir(path.dirname(archive), {recursive: true, mode: 0o700})
  try { await writePrivateJson(archive, manifest) } catch (error) {
    if (error.code !== 'EEXIST' || JSON.stringify(JSON.parse(await readFile(archive, 'utf8'))) !== JSON.stringify(manifest)) throw error
  }
  await writePrivateJson(path.join(input, 'mapping/manifest.json'), manifest, {replace: true})
}

export async function loadAepManifest(input, digest) {
  const manifest = JSON.parse(await readFile(path.join(input, 'mapping/manifest.json'), 'utf8'))
  const {manifestHash, ...payload} = manifest
  if (digest(payload) !== manifestHash) throw new Error('AEP_MANIFEST_HASH_MISMATCH')
  for (const source of manifest.sources) {
    if (!source.name || path.basename(source.name) !== source.name || await fileSha256(path.join(input, 'raw', source.name)) !== source.sha256) throw new Error('AEP_SOURCE_HASH_MISMATCH')
  }
  return manifest
}

export function assertAepReviewedReport(report, {target, codeHash, manifestHash}) {
  if (!report || report.operation !== 'import-dropt-aep' || report.target !== target || report.codeHash !== codeHash
    || report.manifestHash !== manifestHash || report.applied !== false || report.complete !== true || report.blocked?.length
    || !/^[a-f0-9]{64}$/.test(report.stateHash ?? '') || !/^[a-f0-9]{64}$/.test(report.planHash ?? '')) throw new Error('AEP_REVIEW_MISMATCH')
}
