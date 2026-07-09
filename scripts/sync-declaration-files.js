#!/usr/bin/env node
import process from 'node:process'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import pgPkg from 'pg'
import dotenv from 'dotenv'
import {GetObjectCommand, S3} from '@aws-sdk/client-s3'
import {Upload} from '@aws-sdk/lib-storage'

const {Pool} = pgPkg
const DECLARATIONS_BUCKET = 'declarations'

function printUsage() {
  console.log(`Usage: npm run sync:declaration-files -- <code-ou-uuid> --source-env <path> [options]

Options:
  --source-env <path>            Env source: DB + S3 lus en lecture seule
  --target-env <path>            Env cible S3 à alimenter (défaut: .env)
  --dry-run                      Affiche les fichiers sans copier
  --allow-production-target      Autorise explicitement une cible prod
  --help                         Affiche cette aide

Exemple:
  npm run sync:declaration-files -- TFPMDU --source-env /tmp/prod.env --target-env .env
`)
}

function readOptionValue(arguments_, index, optionName) {
  const value = arguments_[index + 1]

  if (!value || value.startsWith('--')) {
    throw new Error(`Option ${optionName} attend une valeur`)
  }

  return value
}

function parseArguments(arguments_) {
  const options = {
    declarationIdentifier: undefined,
    sourceEnv: undefined,
    targetEnv: '.env',
    dryRun: false,
    allowProductionTarget: false,
    help: false
  }

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]

    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }

    if (argument === '--source-env') {
      options.sourceEnv = readOptionValue(arguments_, index, argument)
      index += 1
      continue
    }

    if (argument === '--target-env') {
      options.targetEnv = readOptionValue(arguments_, index, argument)
      index += 1
      continue
    }

    if (argument === '--dry-run') {
      options.dryRun = true
      continue
    }

    if (argument === '--allow-production-target') {
      options.allowProductionTarget = true
      continue
    }

    if (argument.startsWith('--')) {
      throw new Error(`Option inconnue: ${argument}`)
    }

    if (options.declarationIdentifier) {
      throw new Error(
        `Un seul identifiant de déclaration est attendu: ${options.declarationIdentifier}, ${argument}`
      )
    }

    options.declarationIdentifier = argument
  }

  return options
}

async function loadEnvFile(filePath) {
  const content = await readFile(filePath)
  return dotenv.parse(content)
}

function getRequiredEnv(env, name, label) {
  const value = env[name]

  if (!value) {
    throw new Error(`${label}: variable ${name} manquante`)
  }

  return value
}

function getBucketName(env) {
  return `${getRequiredEnv(env, 'S3_BUCKET_PREFIX', 'S3')}${DECLARATIONS_BUCKET}`
}

function isLocalEndpoint(endpoint) {
  return endpoint.includes('localhost') || endpoint.includes('127.0.0.1') || endpoint.includes('minio')
}

function createS3Client(env, label) {
  const endpoint = getRequiredEnv(env, 'S3_ENDPOINT', label)

  return new S3({
    region: getRequiredEnv(env, 'S3_REGION', label),
    endpoint,
    s3BucketEndpoint: true,
    forcePathStyle: isLocalEndpoint(endpoint) || env.NODE_ENV !== 'production',
    credentials: {
      accessKeyId: getRequiredEnv(env, 'S3_ACCESS_KEY', label),
      secretAccessKey: getRequiredEnv(env, 'S3_SECRET_KEY', label)
    }
  })
}

function isProductionTarget(envFile, env) {
  const values = [
    path.basename(envFile),
    env.APP_ENV,
    env.NODE_ENV,
    env.SCALINGO_APP_NAME
  ].filter(Boolean)

  return values.some(value => /\bprod(?:uction)?\b/i.test(value))
}

async function findDeclarationFiles(databaseUrl, declarationIdentifier) {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1
  })

  try {
    const result = await pool.query(
      `
        SELECT
          d.id,
          d.code,
          df.id AS "fileId",
          df.type,
          df.filename,
          df."storageKey"
        FROM "Declaration" d
        INNER JOIN "DeclarationFile" df ON df."declarationId" = d.id
        WHERE d.id::text = $1 OR upper(d.code) = upper($1)
        ORDER BY df."createdAt" ASC
      `,
      [declarationIdentifier]
    )

    return result.rows
  } finally {
    await pool.end()
  }
}

async function copyObject({sourceClient, targetClient, sourceBucket, targetBucket, storageKey}) {
  const normalizedStorageKey = storageKey.normalize('NFC')
  const object = await sourceClient.send(
    new GetObjectCommand({
      Bucket: sourceBucket,
      Key: normalizedStorageKey
    })
  )

  if (!object.Body) {
    throw new Error(`Objet vide ou illisible: ${storageKey}`)
  }

  const upload = new Upload({
    client: targetClient,
    params: {
      Bucket: targetBucket,
      Key: normalizedStorageKey,
      Body: object.Body,
      ContentType: object.ContentType,
      ContentDisposition: object.ContentDisposition
    }
  })

  await upload.done()
}

async function main() {
  const options = parseArguments(process.argv.slice(2))

  if (options.help) {
    printUsage()
    return
  }

  if (!options.declarationIdentifier || !options.sourceEnv) {
    printUsage()
    throw new Error('Code/UUID de déclaration et --source-env sont requis')
  }

  if (path.resolve(options.sourceEnv) === path.resolve(options.targetEnv)) {
    throw new Error('La source et la cible doivent être deux fichiers env distincts')
  }

  const sourceEnv = await loadEnvFile(options.sourceEnv)
  const targetEnv = await loadEnvFile(options.targetEnv)

  if (!options.allowProductionTarget && isProductionTarget(options.targetEnv, targetEnv)) {
    throw new Error(
      'Cible prod détectée. Relance avec --allow-production-target si c’est réellement voulu.'
    )
  }

  const files = await findDeclarationFiles(
    getRequiredEnv(sourceEnv, 'DATABASE_URL', 'source DB'),
    options.declarationIdentifier
  )

  if (files.length === 0) {
    throw new Error(`Aucun fichier trouvé pour ${options.declarationIdentifier}`)
  }

  const [{id, code}] = files
  console.log(
    `[sync-declaration-files] Déclaration ${code} (${id}) - fichiers=${files.length}`
  )

  const sourceBucket = getBucketName(sourceEnv)
  const targetBucket = getBucketName(targetEnv)

  if (options.dryRun) {
    for (const file of files) {
      console.log(`[dry-run] ${file.filename} -> ${file.storageKey}`)
    }

    return
  }

  const sourceClient = createS3Client(sourceEnv, 'source S3')
  const targetClient = createS3Client(targetEnv, 'target S3')

  for (const file of files) {
    console.log(`[sync-declaration-files] Copie ${file.filename}`)
    await copyObject({
      sourceClient,
      targetClient,
      sourceBucket,
      targetBucket,
      storageKey: file.storageKey
    })
  }

  console.log('[sync-declaration-files] OK')
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
