#!/usr/bin/env node
import process from 'node:process'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {readFile, writeFile} from 'node:fs/promises'
import {createInterface} from 'node:readline'
import {S3Client, PutObjectCommand, HeadObjectCommand} from '@aws-sdk/client-s3'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
async function fileHash(filename) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(filename)) hash.update(bytes)
  return hash.digest('hex')
}

export async function restoreArchive({archive, mongoDriver, apply = false}) {
  const root = path.resolve(archive)
  const manifestBytes = await readFile(path.join(root, 'manifest.json'))
  if (sha256(manifestBytes) !== (await readFile(path.join(root, 'manifest.json.sha256'), 'utf8')).trim()) throw new Error('Manifeste modifié')
  const manifest = JSON.parse(manifestBytes)
  const {MongoClient, BSON} = await import(mongoDriver ? pathToFileURL(path.resolve(mongoDriver)).href : 'mongodb')
  // Deliberately fixed local destinations. No URL or source credentials can override them.
  const mongo = new MongoClient('mongodb://127.0.0.1:27018/reunion_source_20261025', {maxPoolSize: 2})
  const s3 = new S3Client({endpoint: 'http://127.0.0.1:9002', region: 'fr-par', forcePathStyle: true,
    credentials: {accessKeyId: 'reunion_local', secretAccessKey: 'reunion_local_password'}})
  const report = {apply, archiveSha256: sha256(manifestBytes), collections: [], objects: {created: 0, unchanged: 0, missing: 0}}
  try {
    await mongo.connect()
    const database = mongo.db('reunion_source_20261025')
    for (const file of manifest.mongo) {
      const filename = path.join(root, file.relativePath)
      if (await fileHash(filename) !== file.sha256) throw new Error('Collection archivée modifiée')
      const collection = database.collection(file.collection)
      const existingCount = await collection.countDocuments()
      if (existingCount && existingCount !== file.count) throw new Error('Source locale déjà partiellement remplie')
      let count = 0
      let batch = []
      for await (const line of createInterface({input: createReadStream(filename), crlfDelay: Infinity})) {
        if (!line) continue
        const row = BSON.EJSON.parse(line, {relaxed: false})
        count += 1
        if (existingCount) {
          const existing = await collection.findOne({_id: row._id})
          if (JSON.stringify(BSON.EJSON.serialize(existing)) !== JSON.stringify(BSON.EJSON.serialize(row))) throw new Error('Source locale différente de l’archive')
        } else if (apply) {
          batch.push(row)
          if (batch.length >= 1000) { await collection.insertMany(batch); batch = [] }
        }
      }
      if (batch.length) await collection.insertMany(batch)
      if (count !== file.count) throw new Error('Nombre de documents archivé incohérent')
      report.collections.push({collection: file.collection, count, unchanged: Boolean(existingCount)})
      console.log(JSON.stringify({stage: 'restore-mongo', collection: file.collection, count}))
    }
    for (const item of manifest.objects) {
      if (item.missing) { report.objects.missing += 1; continue }
      const filename = path.join(root, item.relativePath)
      if (await fileHash(filename) !== item.sha256) throw new Error('Objet archivé modifié')
      const Bucket = item.kind === 'document' ? 'reunion-source-documents' : 'reunion-source-ds'
      let existing
      try { existing = await s3.send(new HeadObjectCommand({Bucket, Key: item.key})) } catch (error) {
        if (error.$metadata?.httpStatusCode !== 404) throw error
      }
      if (existing) {
        if (existing.Metadata?.sha256 !== item.sha256 || Number(existing.ContentLength) !== item.size) throw new Error('Objet source local différent')
        report.objects.unchanged += 1
      } else if (apply) {
        await s3.send(new PutObjectCommand({Bucket, Key: item.key, Body: createReadStream(filename), ContentLength: item.size,
          ContentType: item.contentType ?? undefined, Metadata: {sha256: item.sha256}}))
        report.objects.created += 1
      }
    }
    const filename = path.join(root, `restore-${apply ? 'apply' : 'simulation'}-${Date.now()}.json`)
    await writeFile(filename, `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx', mode: 0o600})
    console.log(JSON.stringify({stage: 'restored', ...report.objects, report: filename}))
    return report
  } finally { await mongo.close(); s3.destroy() }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const {values} = parseArgs({options: {archive: {type: 'string'}, 'mongo-driver': {type: 'string'}, apply: {type: 'boolean', default: false}}})
  restoreArchive({archive: values.archive, mongoDriver: values['mongo-driver'], apply: values.apply}).catch(error => {
    console.error(JSON.stringify({stage: 'restore-failed', error: error.name, message: error.message, code: error.code ?? null}))
    process.exitCode = 1
  })
}
