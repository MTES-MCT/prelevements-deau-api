import {parseArgs} from 'node:util'
import {readFile, writeFile, mkdir} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {prepareMeterArchiveReplay} from './lib/meter-archive-replay.js'

const {values} = parseArgs({options: {
  manifest: {type: 'string'}, snapshot: {type: 'string'}, archive: {type: 'string'}, output: {type: 'string'}
}})
if (['manifest', 'snapshot', 'archive', 'output'].some(key => !values[key])) {
  throw new Error('--manifest, --snapshot, --archive et --output sont obligatoires. Cette commande prépare uniquement ; aucune requête réseau.')
}
process.umask(0o077)
const json = async filename => JSON.parse(await readFile(filename, 'utf8'))
const directory = path.resolve(values.archive)
const plan = await prepareMeterArchiveReplay({manifest: await json(values.manifest), snapshot: await json(values.snapshot),
  archiveManifest: await json(path.join(directory, 'manifest.json')), readArchiveFile: filename => readFile(path.join(directory, filename))})
await mkdir(path.dirname(path.resolve(values.output)), {recursive: true, mode: 0o700})
await writeFile(path.resolve(values.output), `${JSON.stringify(plan, null, 2)}\n`, {flag: 'wx', mode: 0o600})
console.log(JSON.stringify({planHash: plan.planHash, ...plan.summary}))
