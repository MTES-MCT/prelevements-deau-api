import {createHash, randomUUID} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {chmod, link, mkdir, mkdtemp, open, readFile, rename, rmdir, stat, unlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'

import {
  GetBucketLocationCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3
} from '@aws-sdk/client-s3'
import {Upload} from '@aws-sdk/lib-storage'
import {PrismaPg} from '@prisma/adapter-pg'
import prismaPkg from '@prisma/client'
import dotenv from 'dotenv'
import pgPkg from 'pg'

import {TARGET_POLICIES, sha256} from './core.js'

const {PrismaClient} = prismaPkg
const {Pool} = pgPkg
const DEFAULT_S3_STREAM_TIMEOUT_MS = 120_000
const S3_RANGE_SIZE = 8 * 1024 * 1024

async function withS3Timeout(label, operation, timeoutMs = DEFAULT_S3_STREAM_TIMEOUT_MS) {
  const controller = new AbortController()
  let timeout
  const timeoutError = new Error(`${label}: délai de ${timeoutMs} ms dépassé`)
  const timeoutPromise = new Promise((resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort(timeoutError)
      reject(timeoutError)
    }, timeoutMs)
  })

  try {
    return await Promise.race([operation(controller.signal), timeoutPromise])
  } finally {
    clearTimeout(timeout)
  }
}

function isRetryableS3Error(error) {
  const statusCode = error.$metadata?.httpStatusCode
  return !statusCode || statusCode === 408 || statusCode === 429 || statusCode >= 500
}

async function withS3Retries(label, operation, timeoutMs) {
  const attempts = 3
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await withS3Timeout(label, operation, timeoutMs)
    } catch (error) {
      lastError = error
      if (attempt === attempts || !isRetryableS3Error(error)) {
        break
      }

      await new Promise(resolve => {
        setTimeout(resolve, attempt * 250)
      })
    }
  }

  const contextualError = new Error(`${label}: ${lastError.message}`, {cause: lastError})
  contextualError.name = lastError.name
  contextualError.$metadata = lastError.$metadata
  throw contextualError
}

export async function completeS3Upload(
  upload,
  label,
  timeoutMs = DEFAULT_S3_STREAM_TIMEOUT_MS
) {
  let timeout
  const timeoutError = new Error(`${label}: délai de ${timeoutMs} ms dépassé`)
  const timeoutPromise = new Promise((resolve, reject) => {
    timeout = setTimeout(() => {
      Promise.resolve().then(() => upload.abort()).catch(() => {})
      reject(timeoutError)
    }, timeoutMs)
  })

  try {
    return await Promise.race([upload.done(), timeoutPromise])
  } finally {
    clearTimeout(timeout)
  }
}

export async function completeS3UploadWithRetries(
  createUpload,
  label,
  timeoutMs = DEFAULT_S3_STREAM_TIMEOUT_MS
) {
  const attempts = 3
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const upload = createUpload()
    try {
      return await completeS3Upload(upload, label, timeoutMs)
    } catch (error) {
      lastError = error
      await Promise.resolve().then(() => upload.abort()).catch(() => {})
      if (attempt === attempts || !isRetryableS3Error(error)) {
        break
      }

      await new Promise(resolve => {
        setTimeout(resolve, attempt * 250)
      })
    }
  }

  const contextualError = new Error(`${label}: ${lastError.message}`, {cause: lastError})
  contextualError.name = lastError.name
  contextualError.$metadata = lastError.$metadata
  throw contextualError
}

async function streamS3ObjectRanges(context, key, {
  expectedETag,
  onChunk,
  timeoutMs
} = {}) {
  const normalizedKey = key.normalize('NFC')
  const head = await withS3Retries(`Métadonnées S3 ${normalizedKey}`, abortSignal => (
    context.client.send(new HeadObjectCommand({
      Bucket: context.bucket,
      Key: normalizedKey,
      ...(expectedETag ? {IfMatch: expectedETag} : {})
    }), {abortSignal})
  ), timeoutMs)
  const size = Number(head.ContentLength)
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`Taille S3 invalide pour ${normalizedKey}`)
  }

  const stableETag = expectedETag ?? head.ETag
  let streamedSize = 0
  for (let start = 0; start < size; start += S3_RANGE_SIZE) {
    const end = Math.min(start + S3_RANGE_SIZE - 1, size - 1)
    const range = `bytes=${start}-${end}`
    const rangeResult = await withS3Retries(
      `Lecture S3 ${normalizedKey} ${range}`,
      async abortSignal => {
        const response = await context.client.send(new GetObjectCommand({
          Bucket: context.bucket,
          Key: normalizedKey,
          Range: range,
          ...(stableETag ? {IfMatch: stableETag} : {})
        }), {abortSignal})
        if (!response.Body) {
          throw new Error(`Objet source vide: ${normalizedKey} ${range}`)
        }

        const chunks = []
        let receivedSize = 0
        for await (const chunk of response.Body) {
          chunks.push(chunk)
          receivedSize += chunk.length
        }

        return {chunks, receivedSize}
      },
      timeoutMs
    )
    const expectedRangeSize = end - start + 1
    if (rangeResult.receivedSize !== expectedRangeSize) {
      throw new Error(
        `Plage S3 incomplète pour ${normalizedKey}: ${rangeResult.receivedSize}/${expectedRangeSize}`
      )
    }

    for (const chunk of rangeResult.chunks) {
      await onChunk?.(chunk)
    }

    streamedSize += rangeResult.receivedSize
  }

  return {
    size: streamedSize,
    mimeType: head.ContentType ?? null,
    contentDisposition: head.ContentDisposition ?? null,
    eTag: head.ETag ?? null
  }
}

export async function loadEnv(filePath) {
  if (!filePath) {
    return {}
  }

  return dotenv.parse(await readFile(filePath))
}

export function requireEnv(environment, name, label) {
  const value = environment[name]
  if (!value) {
    throw new Error(`${label}: variable ${name} manquante`)
  }

  return value
}

export function createS3Context(environment, label) {
  const endpoint = requireEnv(environment, 'S3_ENDPOINT', label)
  const client = new S3({
    endpoint,
    region: requireEnv(environment, 'S3_REGION', label),
    forcePathStyle: /localhost|127\.0\.0\.1|minio/i.test(endpoint),
    credentials: {
      accessKeyId: requireEnv(environment, 'S3_ACCESS_KEY', label),
      secretAccessKey: requireEnv(environment, 'S3_SECRET_KEY', label)
    }
  })

  return {
    client,
    bucket: `${requireEnv(environment, 'S3_BUCKET_PREFIX', label)}documents`,
    endpoint: endpoint.replace(/\/+$/, '')
  }
}

export function assertDistinctS3Locations(source, target) {
  if (source.endpoint === target.endpoint && source.bucket === target.bucket) {
    throw new Error('Le bucket S3 cible doit être distinct du bucket source')
  }
}

export async function assertVersionedS3Bucket(context, label = 'S3 cible', expectedRegion) {
  const [versioning, location] = await Promise.all([
    withS3Retries(`Versioning ${label}`, abortSignal => (
      context.client.send(new GetBucketVersioningCommand({Bucket: context.bucket}), {abortSignal})
    )),
    expectedRegion
      ? withS3Retries(`Région ${label}`, abortSignal => (
        context.client.send(new GetBucketLocationCommand({Bucket: context.bucket}), {abortSignal})
      ))
      : undefined
  ])
  if (versioning.Status !== 'Enabled') {
    throw new Error(`${label}: le versioning du bucket ${context.bucket} doit être Enabled`)
  }

  const locationConstraint = location?.LocationConstraint ?? null
  const isScalewayFrParWithoutConstraint = expectedRegion === 'fr-par'
    && context.endpoint === 'https://s3.fr-par.scw.cloud'
    && locationConstraint === null
  if (expectedRegion
    && locationConstraint !== expectedRegion
    && !isScalewayFrParWithoutConstraint) {
    throw new Error(`${label}: la région du bucket doit être ${expectedRegion}`)
  }
}

export async function assertTargetCertificate(target, certificatePath) {
  const policy = TARGET_POLICIES[target]
  if (!policy?.database.tls) {
    return
  }

  let content
  try {
    content = await readFile(certificatePath)
  } catch {
    throw new Error(`Cible ${target}: certificat PostgreSQL illisible`)
  }

  if (sha256(content) !== policy.database.caSha256) {
    throw new Error(`Cible ${target}: certificat PostgreSQL non autorisé`)
  }
}

export async function attestTargetDatabase(prisma, target) {
  const policy = TARGET_POLICIES[target]?.database
  const [identity] = await prisma.$queryRawUnsafe(`
    SELECT
      current_database() AS "name",
      current_user AS "user",
      inet_server_port() AS "port",
      COALESCE(
        (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()),
        false
      ) AS "tls"
  `)
  const actual = {
    name: identity?.name,
    user: identity?.user,
    port: String(identity?.port ?? ''),
    tls: Boolean(identity?.tls)
  }
  const expected = {...policy, port: policy?.serverPort}
  for (const key of ['name', 'user', 'port', 'tls']) {
    if (actual[key] !== expected[key]) {
      throw new Error(`Cible ${target}: identité PostgreSQL connectée non autorisée (${key})`)
    }
  }

  return actual
}

export async function hashS3Object(context, key, {timeoutMs} = {}) {
  try {
    const hash = createHash('sha256')
    const object = await streamS3ObjectRanges(context, key, {
      timeoutMs,
      onChunk(chunk) {
        hash.update(chunk)
      }
    })

    return {sha256: hash.digest('hex'), ...object}
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return {missing: true}
    }

    throw error
  }
}

// Le spool local valide ETag, hash et taille avant de rendre la clé finale visible.
// eslint-disable-next-line complexity
export async function copyS3Object({
  source,
  target,
  sourceKey,
  targetKey,
  expectedSha256,
  expectedETag,
  expectedSize,
  filename,
  mimeType
}) {
  const normalizedTargetKey = targetKey.normalize('NFC')
  try {
    const existing = await withS3Retries(`Métadonnées S3 cible ${normalizedTargetKey}`, abortSignal => (
      target.client.send(new HeadObjectCommand({
        Bucket: target.bucket,
        Key: normalizedTargetKey
      }), {abortSignal})
    ))

    const hasExpectedSize = expectedSize === undefined
      || expectedSize === null
      || Number(existing.ContentLength) === Number(expectedSize)
    if (existing.Metadata?.sha256 === expectedSha256 && hasExpectedSize) {
      return 'unchanged'
    }

    throw new Error(`La clé S3 cible existe avec un checksum différent: ${targetKey}`)
  } catch (error) {
    if (!(error.name === 'NotFound' || error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404)) {
      throw error
    }
  }

  let temporaryDirectory
  let temporaryFile
  let temporaryHandle
  let operationError
  let outcome
  try {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'pe-reunion-document-'))
    await chmod(temporaryDirectory, 0o700)
    temporaryFile = path.join(temporaryDirectory, 'content')
    temporaryHandle = await open(temporaryFile, 'wx', 0o600)
    const hash = createHash('sha256')
    const sourceResult = await streamS3ObjectRanges(source, sourceKey, {
      expectedETag,
      async onChunk(chunk) {
        hash.update(chunk)
        let offset = 0
        while (offset < chunk.length) {
          const {bytesWritten} = await temporaryHandle.write(
            chunk,
            offset,
            chunk.length - offset
          )
          if (bytesWritten === 0) {
            throw new Error(`Écriture interrompue du spool local: ${sourceKey}`)
          }

          offset += bytesWritten
        }
      }
    })

    await temporaryHandle.close()
    temporaryHandle = null
    await chmod(temporaryFile, 0o600)
    const copiedSha256 = hash.digest('hex')
    const contentChanged = copiedSha256 !== expectedSha256
      || (expectedSize !== undefined
        && expectedSize !== null
        && sourceResult.size !== expectedSize)

    if (contentChanged) {
      throw new Error(`L’objet source a changé depuis le snapshot: ${sourceKey}`)
    }

    await completeS3UploadWithRetries(
      () => new Upload({
        client: target.client,
        params: {
          Bucket: target.bucket,
          Key: normalizedTargetKey,
          Body: createReadStream(temporaryFile),
          ContentType: mimeType || sourceResult.mimeType,
          ContentDisposition: sourceResult.contentDisposition
            || (filename ? `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` : undefined),
          Metadata: {
            sha256: expectedSha256,
            migration: 'reunion-dep-974',
            verification: 'complete'
          }
        }
      }),
      `Envoi S3 cible ${normalizedTargetKey}`
    )
    outcome = 'created'
  } catch (error) {
    operationError = error
  }

  let cleanupError
  try {
    await temporaryHandle?.close()
    if (temporaryFile) {
      await unlink(temporaryFile).catch(error => {
        if (error.code !== 'ENOENT') {
          throw error
        }
      })
    }

    if (temporaryDirectory) {
      await rmdir(temporaryDirectory)
    }
  } catch (error) {
    cleanupError = error
  }

  if (operationError) {
    throw operationError
  }

  if (cleanupError) {
    throw cleanupError
  }

  return outcome
}

export async function createTargetPrisma(databaseUrl) {
  const pool = new Pool({connectionString: databaseUrl, max: 4})
  const prisma = new PrismaClient({adapter: new PrismaPg(pool)})

  return {
    prisma,
    async close() {
      await prisma.$disconnect()
      await pool.end()
    }
  }
}

export async function withMongoDatabase({uri, databaseName}, callback) {
  const {MongoClient} = await import('mongodb')
  const client = new MongoClient(uri, {
    appName: 'pe-reunion-migration',
    maxPoolSize: 4,
    readPreference: 'primaryPreferred'
  })

  try {
    await client.connect()
    return await callback(client.db(databaseName))
  } finally {
    await client.close()
  }
}

export async function normalizeMongoReferences(values) {
  const {ObjectId} = await import('mongodb')
  const normalized = []
  const seen = new Set()

  for (const value of values.filter(Boolean)) {
    const candidates = [value]
    const text = legacyMongoId(value)
    if (ObjectId.isValid(text) && /^[a-f\d]{24}$/i.test(text)) {
      candidates.push(new ObjectId(text))
    }

    for (const candidate of candidates) {
      const key = `${candidate?._bsontype ?? typeof candidate}:${legacyMongoId(candidate)}`
      if (!seen.has(key)) {
        seen.add(key)
        normalized.push(candidate)
      }
    }
  }

  return normalized
}

function legacyMongoId(value) {
  return typeof value?.toHexString === 'function' ? value.toHexString() : String(value)
}

export async function writeSecureFile(filePath, content, {overwrite = true} = {}) {
  const directory = path.dirname(path.resolve(filePath))
  await mkdir(directory, {recursive: true, mode: 0o700})
  const directoryStat = await stat(directory)
  if ((directoryStat.mode & 0o077) !== 0) {
    throw new Error(
      `Répertoire de sortie trop permissif (${directory}); exécuter chmod 700 sur ce répertoire dédié`
    )
  }

  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  try {
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(content)
    } finally {
      await handle.close()
    }

    await chmod(temporaryPath, 0o600)
    if (overwrite) {
      await rename(temporaryPath, filePath)
    } else {
      // Le lien dur publie atomiquement le fichier et échoue si la destination existe.
      await link(temporaryPath, filePath)
      await unlink(temporaryPath)
    }

    await chmod(filePath, 0o600)
  } catch (error) {
    await unlink(temporaryPath).catch(cleanupError => {
      if (cleanupError.code !== 'ENOENT') {
        error.cleanupError = cleanupError
      }
    })
    throw error
  }
}

export async function assertManifestOutputsAbsent(filePath) {
  const checksumPath = `${filePath}.sha256`
  const conflicts = []
  for (const outputPath of [filePath, checksumPath]) {
    try {
      await stat(outputPath)
      conflicts.push(outputPath)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error
      }
    }
  }

  if (conflicts.length > 0) {
    throw new Error(`Manifeste immuable déjà présent: ${conflicts.join(', ')}`)
  }
}

export async function writeManifestAndChecksum(filePath, content) {
  const digest = sha256(content)
  const checksumPath = `${filePath}.sha256`
  await assertManifestOutputsAbsent(filePath)

  await writeSecureFile(
    checksumPath,
    `${digest}  ${path.basename(filePath)}\n`,
    {overwrite: false}
  )
  try {
    await writeSecureFile(filePath, content, {overwrite: false})
  } catch (error) {
    await unlink(checksumPath).catch(cleanupError => {
      if (cleanupError.code !== 'ENOENT') {
        error.cleanupError = cleanupError
      }
    })
    throw error
  }

  return digest
}

export async function verifyManifestChecksum(filePath) {
  const [content, checksumFile] = await Promise.all([
    readFile(filePath, 'utf8'),
    readFile(`${filePath}.sha256`, 'utf8')
  ])
  const expected = checksumFile.trim().split(/\s+/)[0]
  const actual = sha256(content)
  if (expected !== actual) {
    throw new Error(`Checksum du manifeste invalide: attendu=${expected}, calculé=${actual}`)
  }

  return {content, sha256: actual}
}

export async function writeJsonReport(filePath, report) {
  await writeSecureFile(filePath, `${JSON.stringify(report, null, 2)}\n`)
}
