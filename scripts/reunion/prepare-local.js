#!/usr/bin/env node
import process from 'node:process'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {randomBytes, randomUUID} from 'node:crypto'
import {mkdir, writeFile, readFile} from 'node:fs/promises'
import {createTargetPrisma, attestTargetDatabase} from './lib/runtime.js'
import {hashSecret, generateOpaqueToken} from '../../lib/util/secrets.js'

const random = () => randomBytes(32).toString('hex')
export async function prepareLocal({output, credentials = false, refresh = false}) {
  process.umask(0o077)
  const directory = path.resolve(output)
  if (!directory.startsWith(`${process.env.HOME}/.local/share/preservonsleau/imports/`)) throw new Error('Dossier privé durable obligatoire')
  await mkdir(directory, {recursive: true, mode: 0o700})
  let shared
  try { shared = JSON.parse(await readFile(path.join(directory, 'local-secrets.json'), 'utf8')) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    shared = {webhook: random(), audit: random(), board: random(), clientId: `sa_${randomUUID()}`, clientSecret: generateOpaqueToken()}
    await writeFile(path.join(directory, 'local-secrets.json'), `${JSON.stringify(shared)}\n`, {flag: 'wx', mode: 0o600})
  }
  if (!shared.nextauth) {
    shared.nextauth = random()
    await writeFile(path.join(directory, 'local-secrets.json'), `${JSON.stringify(shared)}\n`, {mode: 0o600})
  }
  const target = {
    APP_ENV: 'reunion-local', NODE_ENV: 'development', DATABASE_URL: 'postgresql://pe_reunion:pe_reunion_local_only@127.0.0.1:5433/pe_reunion',
    S3_ENDPOINT: 'http://127.0.0.1:9002', S3_REGION: 'fr-par', S3_ACCESS_KEY: 'reunion_local', S3_SECRET_KEY: 'reunion_local_password', S3_BUCKET_PREFIX: 'reunion-migration-'
  }
  const api = {...target, PORT: '5500', JSON_BODY_LIMIT: '50mb', REDIS_URL: 'redis://127.0.0.1:6382/0', SMTP_HOST: '127.0.0.1', SMTP_PORT: '1026',
    SMTP_FROM: 'Partageons l’eau local <noreply@example.test>', BREVO_API_KEY: '', API_URL: 'http://127.0.0.1:5500', FRONT_URL: 'http://127.0.0.1:3300', AUTH_METHODS: 'magic_link',
    SESSION_TOKEN_TTL: '2592000', AUTH_TOKEN_TTL: '3600', SENTRY_DSN: '', SENTRY_ENV: '', BULLBOARD_PASSWORD: shared.board,
    AUDIT_CONTEXT_SECRET: shared.audit, ORCHESTRATION_BASE_URL: 'http://127.0.0.1:5501', ORCHESTRATION_WEBHOOK_SECRET: shared.webhook,
    MULTIPLE_EXPLOITATIONS_ENABLED: 'true'}
  const orchestration = {NODE_ENV: 'development', PORT: '5501', REDIS_URL: 'redis://127.0.0.1:6382/0', PLE_BASE_URL: api.API_URL,
    PLE_WEBHOOK_SECRET: shared.webhook, CLIENT_ID: shared.clientId, CLIENT_SECRET: shared.clientSecret, BULLBOARD_PASSWORD: shared.board,
    SENTRY_DSN: '', SENTRY_ENV: '', SCHEDULER_ENABLED: 'false', WORKER_JOBS: 'process-declaration',
    WILLIE_API_TOKEN: '', ORANGE_LIVE_OBJECTS_API_KEY: '', RIVES_ET_EAUX_ENABLED: 'false', RIVES_ET_EAUX_API_KEY: '', EVELER_API_IDENTIFIER: '', EVELER_API_SECRET: ''}
  const front = {NODE_ENV: 'development', PORT: '3300', HOSTNAME: '127.0.0.1', NEXTAUTH_URL: `${api.FRONT_URL}/auth/nextauth`, NEXTAUTH_SECRET: shared.nextauth, AUDIT_CONTEXT_SECRET: shared.audit, API_URL: api.API_URL, NEXT_PUBLIC_API_URL: api.API_URL,
    NEXT_PUBLIC_FRONTEND_URL: api.FRONT_URL, NEXT_PUBLIC_CRISP_DISABLED: 'true', MATOMO_DISABLED: 'true', NEXT_PUBLIC_MATOMO_DISABLED: 'true', NEXT_PUBLIC_SENTRY_DSN: '', SENTRY_DSN: '', NEXT_TELEMETRY_DISABLED: '1'}
  for (const [name, env] of Object.entries({target, api, orchestration, front})) {
    const content = `${Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n')}\n`
    const filename = path.join(directory, `${name}-local.env`)
    try { await writeFile(filename, content, {flag: 'wx', mode: 0o600}) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (await readFile(filename, 'utf8') !== content) {
        if (!refresh) throw new Error('Configuration locale différente : utiliser --refresh pour régénérer explicitement', {cause: error})
        await writeFile(filename, content, {mode: 0o600})
      }
    }
  }
  if (credentials) {
    const {prisma, close} = await createTargetPrisma(target.DATABASE_URL)
    try {
      await attestTargetDatabase(prisma, 'local')
      const account = await prisma.serviceAccount.upsert({where: {sourceId: 'reunion:local:orchestration'},
        create: {sourceId: 'reunion:local:orchestration', name: 'Orchestration Réunion locale', description: 'Recette locale sans planifications distantes'}, update: {isActive: true}})
      const existing = await prisma.serviceAccountCredential.findUnique({where: {keyId: shared.clientId}})
      if (!existing) await prisma.serviceAccountCredential.create({data: {serviceAccountId: account.id, keyId: shared.clientId, secretHash: hashSecret(shared.clientSecret), name: 'Local uniquement'}})
      const declarants = await prisma.declarant.findMany({where: {sourceId: {startsWith: 'reunion:DEP-974:declarant:'}}, select: {userId: true}})
      for (const declarant of declarants) {
        const startDate = new Date('1970-01-01')
        await prisma.serviceAccountDeclarant.upsert({where: {serviceAccountId_declarantUserId_startDate: {serviceAccountId: account.id, declarantUserId: declarant.userId, startDate}},
          create: {serviceAccountId: account.id, declarantUserId: declarant.userId, startDate}, update: {endDate: null}})
      }
      console.log(JSON.stringify({stage: 'local-credential-ready', declarants: declarants.length}))
    } finally { await close() }
  }
  console.log(JSON.stringify({stage: 'local-environments-ready', directory, credentials}))
}
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const {values} = parseArgs({options: {output: {type: 'string'}, credentials: {type: 'boolean', default: false}, refresh: {type: 'boolean', default: false}}})
  prepareLocal({output: values.output, credentials: values.credentials, refresh: values.refresh}).catch(error => {
    console.error(JSON.stringify({stage: 'local-prepare-failed', error: error.name, code: error.code ?? null}))
    process.exitCode = 1
  })
}
