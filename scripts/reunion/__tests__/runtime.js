import {Buffer} from 'node:buffer'
import {mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {Readable} from 'node:stream'

import test from 'ava'
import {ObjectId} from 'mongodb'

import {
  assertDistinctS3Locations,
  assertManifestOutputsAbsent,
  assertTargetCertificate,
  assertVersionedS3Bucket,
  attestTargetDatabase,
  completeS3Upload,
  completeS3UploadWithRetries,
  copyS3Object,
  hashS3Object,
  normalizeMongoReferences,
  writeManifestAndChecksum
} from '../lib/runtime.js'

test('refuse un bucket cible identique à la source', t => {
  t.throws(() => assertDistinctS3Locations(
    {endpoint: 'https://s3.example.test', bucket: 'documents'},
    {endpoint: 'https://s3.example.test', bucket: 'documents'}
  ), {message: /distinct du bucket source/})
  t.notThrows(() => assertDistinctS3Locations(
    {endpoint: 'https://s3.example.test', bucket: 'source-documents'},
    {endpoint: 'https://s3.example.test', bucket: 'target-documents'}
  ))
})

test('exige un bucket cible avec versioning Enabled', async t => {
  const context = {
    bucket: 'target-documents',
    client: {send: async () => ({Status: 'Suspended'})}
  }

  await t.throwsAsync(assertVersionedS3Bucket(context), {message: /doit être Enabled/})
  context.client.send = async () => ({Status: 'Enabled'})
  await t.notThrowsAsync(assertVersionedS3Bucket(context))
})

test('accepte la localisation vide propre à Scaleway fr-par sans élargir les autres cibles', async t => {
  const context = {
    bucket: 'testing-documents',
    endpoint: 'https://s3.fr-par.scw.cloud',
    client: {
      async send(command) {
        return command.constructor.name === 'GetBucketVersioningCommand'
          ? {Status: 'Enabled'}
          : {LocationConstraint: null}
      }
    }
  }

  await t.notThrowsAsync(assertVersionedS3Bucket(context, 'S3 cible', 'fr-par'))

  context.endpoint = 'https://s3.example.test'
  await t.throwsAsync(assertVersionedS3Bucket(context, 'S3 cible', 'fr-par'), {
    message: /région du bucket doit être fr-par/
  })

  context.endpoint = 'https://s3.fr-par.scw.cloud'
  context.client.send = async command => command.constructor.name === 'GetBucketVersioningCommand'
    ? {Status: 'Enabled'}
    : {LocationConstraint: 'nl-ams'}
  await t.throwsAsync(assertVersionedS3Bucket(context, 'S3 cible', 'fr-par'), {
    message: /région du bucket doit être fr-par/
  })
})

test('refuse un certificat PostgreSQL testing qui ne correspond pas à la CA autorisée', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pe-reunion-ca-test-'))
  t.teardown(() => rm(directory, {recursive: true, force: true}))
  const certificatePath = path.join(directory, 'postgres-ca.pem')
  await writeFile(certificatePath, 'mauvaise CA')

  await t.throwsAsync(assertTargetCertificate('testing', certificatePath), {
    message: /certificat PostgreSQL non autorisé/
  })
  await t.notThrowsAsync(assertTargetCertificate('local'))
})

test('atteste l’identité PostgreSQL réellement connectée', async t => {
  const prisma = {
    async $queryRawUnsafe() {
      return [{name: 'pe_reunion', user: 'pe_reunion', port: 5432, tls: false}]
    }
  }

  t.deepEqual(await attestTargetDatabase(prisma, 'local'), {
    name: 'pe_reunion',
    user: 'pe_reunion',
    port: '5432',
    tls: false
  })
  prisma.$queryRawUnsafe = async () => [{
    name: 'prod-partageons-leau-api',
    user: 'pe_reunion',
    port: 5432,
    tls: false
  }]
  await t.throwsAsync(attestTargetDatabase(prisma, 'local'), {
    message: /identité PostgreSQL connectée non autorisée/
  })
})

test('borne une lecture S3 qui ne répond jamais', async t => {
  let signal
  const context = {
    bucket: 'source',
    client: {
      async send(command, options) {
        signal = options.abortSignal
        return new Promise(() => {})
      }
    }
  }

  const error = await t.throwsAsync(
    hashS3Object(context, 'document-bloqué.pdf', {timeoutMs: 10})
  )

  t.regex(error.message, /délai de 10 ms dépassé/)
  t.true(signal.aborted)
})

test('borne et annule un upload S3 qui ne répond jamais', async t => {
  let aborted = false
  const upload = {
    async abort() {
      aborted = true
    },
    async done() {
      return new Promise(() => {})
    }
  }

  const error = await t.throwsAsync(completeS3Upload(upload, 'upload test', 10))

  t.regex(error.message, /délai de 10 ms dépassé/)
  t.true(aborted)
})

test('recrée un upload S3 après une erreur transitoire', async t => {
  let created = 0
  let aborted = 0
  const result = await completeS3UploadWithRetries(() => {
    created += 1
    return {
      async abort() {
        aborted += 1
      },
      async done() {
        if (created === 1) {
          const error = new Error('internal error')
          error.name = 'InternalError'
          error.$metadata = {httpStatusCode: 500}
          throw error
        }

        return {ETag: 'ok'}
      }
    }
  }, 'upload test')

  t.deepEqual(result, {ETag: 'ok'})
  t.is(created, 2)
  t.is(aborted, 1)
})

test('ne retente pas un upload S3 refusé', async t => {
  let created = 0
  const error = await t.throwsAsync(completeS3UploadWithRetries(() => {
    created += 1
    return {
      async abort() {},
      async done() {
        const forbidden = new Error('forbidden')
        forbidden.name = 'AccessDenied'
        forbidden.$metadata = {httpStatusCode: 403}
        throw forbidden
      }
    }
  }, 'upload test'))

  t.regex(error.message, /upload test: forbidden/)
  t.is(created, 1)
})

test('reprend une plage S3 interrompue sans dupliquer son contenu', async t => {
  const content = Buffer.from('abc')
  let rangeCalls = 0
  const context = {
    bucket: 'source',
    client: {
      async send(command) {
        if (command.constructor.name === 'HeadObjectCommand') {
          return {ContentLength: content.length, ETag: '"stable"'}
        }

        rangeCalls += 1
        if (rangeCalls === 1) {
          throw new Error('aborted')
        }

        return {Body: Readable.from([content])}
      }
    }
  }

  const result = await hashS3Object(context, 'document.pdf')

  t.is(rangeCalls, 2)
  t.is(result.size, content.length)
  t.is(result.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test.serial('un manifeste publié est immuable et reste inchangé au rejeu du snapshot', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pe-reunion-manifest-test-'))
  t.teardown(() => rm(directory, {recursive: true, force: true}))
  const manifestPath = path.join(directory, 'snapshot.jsonl')
  const initialContent = '{"version":1}\n'

  const digest = await writeManifestAndChecksum(manifestPath, initialContent)
  const earlyError = await t.throwsAsync(assertManifestOutputsAbsent(manifestPath))
  const error = await t.throwsAsync(
    writeManifestAndChecksum(manifestPath, '{"version":2}\n')
  )

  t.regex(earlyError.message, /Manifeste immuable déjà présent/)
  t.regex(error.message, /Manifeste immuable déjà présent/)
  t.is(await readFile(manifestPath, 'utf8'), initialContent)
  t.is(
    await readFile(`${manifestPath}.sha256`, 'utf8'),
    `${digest}  snapshot.jsonl\n`
  )
  const manifestStat = await stat(manifestPath)
  const checksumStat = await stat(`${manifestPath}.sha256`)
  t.is(manifestStat.mode & 0o777, 0o600)
  t.is(checksumStat.mode & 0o777, 0o600)
})

test('normalise une référence document hexadécimale string pour retrouver un ObjectId soft-deleted', async t => {
  const id = '6946ea0288fffc5c07117206'
  const values = await normalizeMongoReferences([id, new ObjectId(id), 'legacy-string-id'])

  t.true(values.includes(id))
  t.true(values.some(value => value instanceof ObjectId && value.toHexString() === id))
  t.true(values.includes('legacy-string-id'))
  t.is(values.filter(value => value instanceof ObjectId && value.toHexString() === id).length, 1)
})

test.serial('refuse une source modifiée avant upload final et nettoie le spool', async t => {
  const prefix = 'pe-reunion-document-'
  const entriesBefore = await readdir(tmpdir())
  const before = new Set(entriesBefore.filter(name => name.startsWith(prefix)))
  const changedContent = Buffer.from('contenu modifié')
  let targetCalls = 0
  const target = {
    bucket: 'target',
    client: {
      async send() {
        targetCalls += 1
        const error = new Error('absent')
        error.name = 'NotFound'
        error.$metadata = {httpStatusCode: 404}
        throw error
      }
    }
  }
  const source = {
    bucket: 'source',
    client: {
      async send(command) {
        if (command.constructor.name === 'HeadObjectCommand') {
          return {ContentLength: changedContent.length, ETag: '"source-etag"'}
        }

        return {Body: Readable.from([changedContent])}
      }
    }
  }

  await t.throwsAsync(copyS3Object({
    source,
    target,
    sourceKey: 'source.txt',
    targetKey: 'target.txt',
    expectedSha256: '0'.repeat(64),
    expectedSize: changedContent.length,
    filename: 'document.txt',
    mimeType: 'text/plain'
  }), {message: /changé depuis le snapshot/})

  const entriesAfter = await readdir(tmpdir())
  const after = entriesAfter.filter(name => name.startsWith(prefix))
  t.false(after.some(name => !before.has(name)))
  t.is(targetCalls, 1)
})
