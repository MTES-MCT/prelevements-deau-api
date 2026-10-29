#!/usr/bin/env node
import process from 'node:process'
import path from 'node:path'
import {parseArgs, parseEnv} from 'node:util'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createWriteStream} from 'node:fs'
import {mkdir, open, readFile, rename, stat, unlink, writeFile} from 'node:fs/promises'
import {pipeline} from 'node:stream/promises'
import {Transform} from 'node:stream'
import {pathToFileURL} from 'node:url'
import {S3Client, ListObjectsV2Command, GetObjectCommand} from '@aws-sdk/client-s3'

const COLLECTIONS = ['territoires', 'points_prelevement', 'preleveurs', 'exploitations', 'regles',
  'documents', 'users', 'dossiers', 'dossier_attachments', 'series', 'series_values', 'integrations_journalieres']

// Keep the archive useful for migration without retaining authentication or signed URLs.
export function sanitizeArchive(value) {
  if (Array.isArray(value)) return value.map(sanitizeArchive)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(password|passwordHash|token|accessToken|refreshToken|secret|authorization|session)$/i.test(key))
    .map(([key, item]) => [key, sanitizeArchive(item)]))
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      url.username = ''
      url.password = ''
      if ([...url.searchParams.keys()].some(key => /token|signature|credential|authorization|x-amz|x-goog/i.test(key))) {
        url.search = ''
      }
      return url.toString()
    } catch { return value }
  }
  return value
}

const digest = value => createHash('sha256').update(value).digest('hex')
async function json(filename, value) {
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, {flag: 'wx', mode: 0o600})
}

async function captureMongo(database, output, BSON) {
  const documents = await database.collection('documents').find({territoire: 'DEP-974'}).toArray()
  const documentIds = new Set(documents.map(item => String(item._id)))
  for (const collection of ['exploitations', 'regles']) {
    const references = await database.collection(collection).find({territoire: 'DEP-974'},
      {projection: {documents: 1, document: 1}}).toArray()
    for (const row of references) for (const id of [...(row.documents ?? []), row.document].filter(Boolean)) {
      if (!documentIds.has(String(id))) {
        const document = await database.collection('documents').findOne({_id: id})
        if (document) { documents.push(document); documentIds.add(String(id)) }
      }
    }
  }
  const counts = {}
  const files = []
  for (const collection of COLLECTIONS) {
    const relativePath = `mongo/${collection}.ejsonl`
    const filename = path.join(output, relativePath)
    const file = await open(filename, 'wx', 0o600)
    const hash = createHash('sha256')
    let count = 0
    const rows = collection === 'documents' ? documents : database.collection(collection).find(
      collection === 'users' ? {'roles.territoire': 'DEP-974'} : {},
      collection === 'users' ? {projection: {_id: 1, email: 1, nom: 1, prenom: 1, structure: 1,
        fonction: 1, telephone: 1, roles: 1, createdAt: 1, updatedAt: 1, deletedAt: 1}} : {}
    ).sort({_id: 1}).batchSize(1000)
    try {
      for await (const row of rows) {
        const line = `${JSON.stringify(sanitizeArchive(BSON.EJSON.serialize(row, {relaxed: false})))}\n`
        await file.write(line)
        hash.update(line)
        count += 1
      }
    } finally { await file.close() }
    counts[collection] = count
    files.push({collection, relativePath, count, sha256: hash.digest('hex')})
    console.log(JSON.stringify({stage: 'mongo', collection, count}))
  }
  return {counts, files, documents}
}

async function downloadObject(client, item, output) {
  const relativePath = `objects/${digest(`${item.bucket}/${item.key}`)}`
  const filename = path.join(output, relativePath)
  const evidencePath = `${filename}.json`
  try {
    const previous = JSON.parse(await readFile(evidencePath, 'utf8'))
    if ((await stat(filename)).size === previous.size && previous.etag === item.etag) return previous
    throw new Error('Archive existante incohérente')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = `${filename}.part`
  await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await client.send(new GetObjectCommand({Bucket: item.bucket, Key: item.key,
        ...(item.etag ? {IfMatch: item.etag} : {})}), {abortSignal: AbortSignal.timeout(180_000)})
      const hash = createHash('sha256')
      let size = 0
      if (item.key.endsWith('.json')) {
        const original = await result.Body.transformToString()
        const sanitized = `${JSON.stringify(sanitizeArchive(JSON.parse(original)))}\n`
        await writeFile(temporary, sanitized, {mode: 0o600})
        hash.update(sanitized)
        size = Buffer.byteLength(sanitized)
      } else {
        await pipeline(result.Body, new Transform({transform(chunk, encoding, callback) {
          size += chunk.length
          hash.update(chunk)
          callback(null, chunk)
        }}), createWriteStream(temporary, {mode: 0o600}))
        if (size !== Number(result.ContentLength)) throw new Error('Taille source incomplète')
      }
      await rename(temporary, filename)
      const evidence = {...item, relativePath, size, sha256: hash.digest('hex'),
        contentType: result.ContentType ?? null, sanitizedJson: item.key.endsWith('.json')}
      await json(evidencePath, evidence)
      return evidence
    } catch (error) {
      lastError = error
      await unlink(temporary).catch(() => {})
      if ([403, 404].includes(error.$metadata?.httpStatusCode)) break
    }
  }
  if (lastError?.$metadata?.httpStatusCode === 404) return {...item, missing: true}
  throw lastError
}

export async function captureLegacy({output, mongoTunnelPort, mongoDriver, sourceApp = 'prelevement-deau-api'}) {
  if (sourceApp !== 'prelevement-deau-api' || !/^\d+$/.test(mongoTunnelPort ?? '')) throw new Error('Source ou tunnel invalide')
  const root = path.resolve(output)
  if (!root.startsWith(`${process.env.HOME}/.local/share/preservonsleau/imports/`)) {
    throw new Error('Stockage privé durable hors Git obligatoire')
  }
  process.umask(0o077)
  for (const folder of [root, path.join(root, 'mongo'), path.join(root, 'objects')]) await mkdir(folder, {recursive: true, mode: 0o700})
  const env = parseEnv(execFileSync('scalingo', ['--app', sourceApp, 'env'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}))
  const resolve = value => String(value ?? '').replace(/\$\{?([A-Z][A-Z0-9_]+)\}?/g, (_, key) => env[key] ?? '')
  const startedAt = new Date().toISOString()
  const uri = new URL(resolve(env.SCALINGO_MONGO_URL))
  const servername = uri.hostname
  uri.hostname = '127.0.0.1'
  uri.port = mongoTunnelPort
  uri.searchParams.set('directConnection', 'true')
  const ca = await (await fetch('https://db-api.osc-fr1.scalingo.com/api/ca_certificate',
    {redirect: 'error', signal: AbortSignal.timeout(10_000)})).text()
  const {MongoClient, BSON} = await import(mongoDriver ? pathToFileURL(path.resolve(mongoDriver)).href : 'mongodb')
  const mongo = new MongoClient(uri.toString(), {appName: 'reunion-readonly-archive', maxPoolSize: 1,
    serverSelectionTimeoutMS: 10_000, ca, servername})
  let snapshot
  try {
    await mongo.connect()
    snapshot = await captureMongo(mongo.db(resolve(env.MONGODB_DBNAME)), root, BSON)
  } finally { await mongo.close() }
  await json(path.join(root, 'mongo-manifest.json'), {startedAt, ...snapshot, documents: undefined})
  const client = new S3Client({region: resolve(env.S3_REGION), endpoint: resolve(env.S3_ENDPOINT),
    credentials: {accessKeyId: resolve(env.S3_ACCESS_KEY), secretAccessKey: resolve(env.S3_SECRET_KEY)}})
  const objects = []
  const dsBucket = `${resolve(env.S3_BUCKET_PREFIX)}ds`
  let continuation
  do {
    const page = await client.send(new ListObjectsV2Command({Bucket: dsBucket, Prefix: 'demarche-80149/', ContinuationToken: continuation}))
    objects.push(...(page.Contents ?? []).map(item => ({bucket: dsBucket, kind: 'ds', key: item.Key,
      sourceSize: item.Size, etag: item.ETag, lastModified: item.LastModified})))
    continuation = page.NextContinuationToken
  } while (continuation)
  const documentBucket = `${resolve(env.S3_BUCKET_PREFIX)}documents`
  const documentKeys = [...new Set(snapshot.documents.map(item => item.objectKey).filter(Boolean).map(key => key.normalize('NFC')))]
  objects.push(...documentKeys.map(key => ({bucket: documentBucket, kind: 'document', key})))
  await json(path.join(root, 'object-inventory.json'), objects)
  let index = 0
  const completed = []
  await Promise.all(Array.from({length: 4}, async () => {
    while (index < objects.length) {
      const item = objects[index++]
      completed.push(await downloadObject(client, item, root))
      if (completed.length % 100 === 0) console.log(JSON.stringify({stage: 's3', completed: completed.length, total: objects.length}))
    }
  }))
  client.destroy()
  completed.sort((left, right) => `${left.kind}/${left.key}`.localeCompare(`${right.kind}/${right.key}`))
  const manifest = {version: 1, startedAt, completedAt: new Date().toISOString(), sourceApp,
    sourceReadOnly: true, territory: 'DEP-974', demarcheNumber: 80149, mongo: snapshot.files,
    objects: completed, missingRegulatoryDocumentId: '698ebd5cdf08b37f8d166721',
    scope: 'Collections métier ; agents sans authentification ; S3 démarche 80149 et documents DEP-974/référencés ; URLs signées retirées des JSON'}
  await json(path.join(root, 'manifest.json'), manifest)
  await writeFile(path.join(root, 'manifest.json.sha256'), `${digest(await readFile(path.join(root, 'manifest.json')))}\n`, {flag: 'wx', mode: 0o600})
  console.log(JSON.stringify({stage: 'complete', counts: snapshot.counts, objects: completed.length, missing: completed.filter(item => item.missing).length}))
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const {values} = parseArgs({options: {output: {type: 'string'}, 'mongo-tunnel-port': {type: 'string'}, 'mongo-driver': {type: 'string'}}})
  captureLegacy({output: values.output, mongoTunnelPort: values['mongo-tunnel-port'], mongoDriver: values['mongo-driver']}).catch(error => {
    console.error(JSON.stringify({stage: 'failed', error: error.name, code: error.code ?? null, status: error.$metadata?.httpStatusCode ?? null}))
    process.exitCode = 1
  })
}
