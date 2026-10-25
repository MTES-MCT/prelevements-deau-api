#!/usr/bin/env node
import process from 'node:process'
import path from 'node:path'
import {parseArgs, parseEnv} from 'node:util'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readFile, mkdir, writeFile, rename, unlink, stat} from 'node:fs/promises'
import {fetchHistoricalDossiers, collectDossierFiles, fetchDeletedDossiers, DN_ENDPOINT} from './lib/dn-client.js'
import {sanitizeArchive} from './capture-legacy.js'

const hash = data => createHash('sha256').update(data).digest('hex')
async function save(file, value) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`
  await writeFile(file, bytes, {flag: 'wx', mode: 0o600})
  return hash(bytes)
}

export async function captureDn({archive}) {
  const root = path.resolve(archive)
  if (!root.startsWith(`${process.env.HOME}/.local/share/preservonsleau/imports/`)) throw new Error('Archive privée obligatoire')
  process.umask(0o077)
  const output = path.join(root, 'dn')
  await mkdir(output, {recursive: true, mode: 0o700})
  const sourceManifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'))
  const existing = new Map(sourceManifest.objects.filter(item => !item.missing).map(item => [item.key.normalize('NFC'), item]))
  const env = parseEnv(execFileSync('scalingo', ['--app', 'prelevement-deau-api', 'env'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}))
  const startedAt = new Date().toISOString()
  const dossiers = []
  const files = new Map()
  for await (const dossier of fetchHistoricalDossiers({token: env.DS_API_TOKEN})) {
    const sanitized = sanitizeArchive(collectDossierFiles(dossier, dossier.number, files))
    const relativePath = `dn/${dossier.number}.json`
    const sha256 = await save(path.join(root, relativePath), sanitized)
    dossiers.push({number: dossier.number, state: dossier.state, updatedAt: dossier.dateDerniereModification,
      relativePath, sha256})
    if (dossiers.length % 100 === 0) console.log(JSON.stringify({stage: 'dn', dossiers: dossiers.length}))
  }
  const attachments = []
  for (const [key, file] of files) {
    if (existing.has(key.normalize('NFC'))) { attachments.push({...existing.get(key.normalize('NFC')), dnChecksum: file.checksum}); continue }
    const relativePath = `objects/dn-${hash(key)}`
    const filename = path.join(root, relativePath)
    try { await stat(filename); throw new Error('Objet DN déjà présent sans manifeste') } catch (error) { if (error.code !== 'ENOENT') throw error }
    const url = new URL(file.url)
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('URL de pièce DN invalide')
    const response = await fetch(url, {signal: AbortSignal.timeout(120_000)})
    if (!response.ok) {
      attachments.push({key, filename: file.filename, dnChecksum: file.checksum, available: false,
        issue: `DN_HTTP_${response.status}`})
      continue
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    // ActiveStorage checksum is base64 MD5; validate it when provided in this format.
    if (/^[A-Za-z\d+/]{22}==$/.test(file.checksum)
      && createHash('md5').update(bytes).digest('base64') !== file.checksum) throw new Error('Checksum pièce DN incohérent')
    const temporary = `${filename}.part`
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
    await writeFile(temporary, bytes, {flag: 'wx', mode: 0o600})
    await rename(temporary, filename)
    attachments.push({key, relativePath, size: bytes.length, sha256: hash(bytes), contentType: file.contentType,
      filename: file.filename, dnChecksum: file.checksum, recoveredFromDn: true})
  }
  const deletedDossiers = await fetchDeletedDossiers({token: env.DS_API_TOKEN})
  const pendingDeletedDossiers = await fetchDeletedDossiers({token: env.DS_API_TOKEN, pending: true})
  const manifest = {version: 1, deletedDossiers, pendingDeletedDossiers, endpoint: DN_ENDPOINT, demarcheNumber: 80149, startedAt,
    completedAt: new Date().toISOString(), sourceReadOnly: true, dossiers, attachments}
  const sha256 = await save(path.join(output, 'manifest.json'), manifest)
  await writeFile(path.join(output, 'manifest.json.sha256'), `${sha256}\n`, {flag: 'wx', mode: 0o600})
  console.log(JSON.stringify({stage: 'dn-complete', dossiers: dossiers.length, attachments: attachments.length,
    recovered: attachments.filter(item => item.recoveredFromDn).length,
    missing: attachments.filter(item => item.available === false).length}))
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const {values} = parseArgs({options: {archive: {type: 'string'}}})
  captureDn({archive: values.archive}).catch(error => {
    console.error(JSON.stringify({stage: 'dn-failed', error: error.name, code: error.code ?? null,
      message: error.message?.startsWith('Réponse GraphQL') ? error.message : undefined}))
    process.exitCode = 1
  })
}
