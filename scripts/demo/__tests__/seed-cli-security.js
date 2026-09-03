import {chmod, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import test from 'ava'

import {DEFAULT_DATASET, parseArguments} from '../lib/seed-cli.js'
import {
  describeSeedOutcome,
  finalizeSecureJsonReport,
  formatSeedOutcome,
  reserveSecureJsonReport,
  writeSecureJsonReport
} from '../lib/seed-report.js'
import {
  ACCOUNT_KEYS,
  assertApplyConfirmation,
  buildTargetAttestation,
  loadAccounts,
  loadExclusiveSeedInputs,
  loadTargetEnvironment,
  loadTargetPolicy,
  redactSensitive,
  sha256,
  stableStringify
} from '../lib/seed-target.js'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const demoDirectory = path.resolve(testDirectory, '..')
const projectDirectory = path.resolve(demoDirectory, '../..')
const demoCertificatePath = path.resolve(
  testDirectory,
  '../../../deploy/certs/demo/postgres-ca.pem'
)
const DATASET_SHA256 = 'a'.repeat(64)
const ACCOUNTS_SHA256 = 'b'.repeat(64)

const VALID_ACCOUNTS = Object.freeze({
  ddt: 'ddt@example.test',
  sage: 'sage@example.test',
  ougc: 'ougc@example.test',
  industrial: 'industrie@example.test',
  aep: 'aep@example.test',
  irrigant: 'irrigant@example.test'
})

async function createTestDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pe-demo-seed-security-'))
  t.teardown(() => rm(directory, {recursive: true, force: true}))
  return directory
}

async function writePrivateFile(directory, name, content) {
  const filePath = path.join(directory, name)
  await writeFile(filePath, content, {mode: 0o600})
  await chmod(filePath, 0o600)
  return filePath
}

function accountsContent(overrides = {}) {
  return `${JSON.stringify({...VALID_ACCOUNTS, ...overrides}, null, 2)}\n`
}

function localEnvironment(overrides = {}) {
  return {
    APP_ENV: 'local',
    DATABASE_URL: 'postgresql://seed_app:fake-password@127.0.0.1:5432/seed_local',
    ...overrides
  }
}

function demoEnvironment(overrides = {}) {
  const search = new URLSearchParams({
    sslmode: 'verify-full',
    sslrootcert: demoCertificatePath
  })
  return {
    APP_ENV: 'demo',
    DATABASE_URL: `postgresql://prelevements_demo_app:fake-password@rw-ea5a07db-05df-4869-9e57-fa5f5c6c81cc.rdb.fr-par.scw.cloud:17063/prelevements_demo?${search}`,
    ...overrides
  }
}

test('parseArguments expose un apply en dry-run par défaut', t => {
  const options = parseArguments([
    'apply',
    '--target',
    'local',
    '--target-env=.seed-local.env',
    '--accounts',
    'accounts.json'
  ])

  t.deepEqual(options, {
    command: 'apply',
    dataset: DEFAULT_DATASET,
    target: 'local',
    targetEnv: '.seed-local.env',
    accounts: 'accounts.json',
    targetPolicy: undefined,
    report: undefined,
    apply: false,
    confirmTarget: undefined,
    help: false
  })
})

test('parseArguments borne les écritures et la policy custom', t => {
  const common = [
    '--target-env',
    'target.env',
    '--accounts',
    'accounts.json'
  ]

  t.throws(() => parseArguments(['verify', '--target', 'local', ...common, '--apply']), {
    message: /--apply est réservé/
  })
  t.throws(() => parseArguments(['apply', '--target', 'demo', ...common, '--apply']), {
    message: /--report est requis/
  })
  t.throws(() => parseArguments(['preflight', '--target', 'custom', ...common]), {
    message: /--target-policy est requis/
  })
  t.throws(() => parseArguments(['preflight', '--target', 'prod', ...common]), {
    message: /Cible invalide/
  })
  t.throws(() => parseArguments([
    'apply',
    '--target',
    'local',
    ...common,
    '--confirm-target',
    'local:abc'
  ]), {message: /--confirm-target exige/})
})

test('les chargeurs utilisent uniquement les trois fichiers explicitement fournis', async t => {
  const directory = await createTestDirectory(t)
  const targetEnv = await writePrivateFile(
    directory,
    'target.env',
    'APP_ENV=local\nDATABASE_URL=postgresql://seed_app:file-password@127.0.0.1:5432/seed_local\n'
  )
  const accounts = await writePrivateFile(directory, 'accounts.json', accountsContent())
  const previousDatabaseUrl = process.env.DATABASE_URL
  process.env.DATABASE_URL = 'postgresql://outside:outside@production.example/prod'
  t.teardown(() => {
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl
    }
  })

  const loaded = await loadExclusiveSeedInputs({target: 'local', targetEnv, accounts})

  t.is(loaded.targetEnvironment.APP_ENV, 'local')
  t.true(loaded.targetEnvironment.DATABASE_URL.includes('file-password'))
  t.deepEqual(loaded.accounts, VALID_ACCOUNTS)
  t.is(loaded.targetPolicy, undefined)
})

test('target-env et accounts doivent être des fichiers privés', async t => {
  const directory = await createTestDirectory(t)
  const targetEnv = await writePrivateFile(
    directory,
    'target.env',
    'APP_ENV=local\nDATABASE_URL=postgresql://seed_app:fake-password@127.0.0.1/seed_local\n'
  )
  const accounts = await writePrivateFile(directory, 'accounts.json', accountsContent())
  await chmod(targetEnv, 0o644)

  await t.throwsAsync(loadTargetEnvironment(targetEnv), {message: /chmod 600/})
  await chmod(accounts, 0o640)
  await t.throwsAsync(loadAccounts(accounts), {message: /chmod 600/})
})

test('accounts normalise six emails distincts et refuse toute dérive', async t => {
  const directory = await createTestDirectory(t)
  const normalizedPath = await writePrivateFile(directory, 'accounts.json', accountsContent({
    ddt: '  DDT@EXAMPLE.TEST  '
  }))

  const accounts = await loadAccounts(normalizedPath)
  t.deepEqual(Object.keys(accounts), ACCOUNT_KEYS)
  t.is(accounts.ddt, 'ddt@example.test')
  t.true(Object.isFrozen(accounts))

  const duplicatePath = await writePrivateFile(directory, 'duplicates.json', accountsContent({
    sage: 'DDT@example.test'
  }))
  await t.throwsAsync(loadAccounts(duplicatePath), {message: /utilisent le même email/})

  const missing = {...VALID_ACCOUNTS}
  delete missing.irrigant
  const missingPath = await writePrivateFile(
    directory,
    'missing.json',
    `${JSON.stringify(missing)}\n`
  )
  await t.throwsAsync(loadAccounts(missingPath), {message: /compte\(s\) manquant\(s\).*irrigant/})

  const extraPath = await writePrivateFile(directory, 'extra.json', accountsContent({other: 'x@example.test'}))
  await t.throwsAsync(loadAccounts(extraPath), {message: /propriété\(s\) inconnue\(s\).*other/})

  const invalidPath = await writePrivateFile(directory, 'invalid.json', accountsContent({aep: 'invalide'}))
  await t.throwsAsync(loadAccounts(invalidPath), {message: /adresse email valide/})
})

test('les exemples publics et la documentation restent alignés avec la CLI', async t => {
  const directory = await createTestDirectory(t)
  const targetEnv = await writePrivateFile(
    directory,
    'target-local.env',
    await readFile(path.join(demoDirectory, 'target-local.env.example'), 'utf8')
  )
  const accounts = await writePrivateFile(
    directory,
    'accounts.json',
    await readFile(path.join(demoDirectory, 'accounts.example.json'), 'utf8')
  )
  const inputs = await loadExclusiveSeedInputs({target: 'local', targetEnv, accounts})
  const attestation = await buildTargetAttestation({
    target: 'local',
    targetEnvironment: inputs.targetEnvironment,
    dataset: DEFAULT_DATASET,
    datasetSha256: DATASET_SHA256,
    accountsSha256: ACCOUNTS_SHA256
  })
  const customPolicy = await loadTargetPolicy(
    path.join(demoDirectory, 'target-policy.example.json')
  )
  const packageJson = JSON.parse(await readFile(
    path.join(projectDirectory, 'package.json'),
    'utf8'
  ))
  const documentation = await readFile(path.join(demoDirectory, 'README.md'), 'utf8')

  t.deepEqual(Object.keys(inputs.accounts), ACCOUNT_KEYS)
  t.regex(attestation.confirmation, /^local:[a-f\d]{12}$/)
  t.false(customPolicy.production)
  t.is(packageJson.scripts['seed:demo'], 'node scripts/demo/seed-demo.js')
  for (const expectedText of [
    'preflight',
    'apply --apply',
    'verify',
    '--target local',
    '--target demo',
    '--target custom',
    'chmod 600',
    'S3',
    'aucun email',
    'legacy uniquement'
  ]) {
    t.true(documentation.includes(expectedText), `README incomplet : ${expectedText}`)
  }
})

test('la policy local exige PostgreSQL sur loopback', async t => {
  const attestation = await buildTargetAttestation({
    target: 'local',
    targetEnvironment: localEnvironment(),
    dataset: DEFAULT_DATASET,
    datasetSha256: DATASET_SHA256,
    accountsSha256: ACCOUNTS_SHA256
  })

  t.is(attestation.database.host, '127.0.0.1')
  t.is(attestation.database.name, 'seed_local')
  t.false(JSON.stringify(attestation).includes('fake-password'))
  t.regex(attestation.confirmation, /^local:[a-f\d]{12}$/)

  await t.throwsAsync(buildTargetAttestation({
    target: 'local',
    targetEnvironment: localEnvironment({
      DATABASE_URL: 'postgresql://seed_app:fake-password@database.example.test:5432/seed_local'
    }),
    dataset: DEFAULT_DATASET,
    datasetSha256: DATASET_SHA256,
    accountsSha256: ACCOUNTS_SHA256
  }), {message: /PostgreSQL doit être loopback/})
})

test('le hash des comptes change la confirmation sans être exposé', async t => {
  const baseArguments = {
    target: 'local',
    targetEnvironment: localEnvironment(),
    dataset: DEFAULT_DATASET,
    datasetSha256: DATASET_SHA256
  }
  const changedAccounts = {
    ...VALID_ACCOUNTS,
    ddt: 'autre-ddt@example.test'
  }
  const firstAccountsSha256 = sha256(stableStringify(VALID_ACCOUNTS))
  const secondAccountsSha256 = sha256(stableStringify(changedAccounts))
  const first = await buildTargetAttestation({
    ...baseArguments,
    accountsSha256: firstAccountsSha256
  })
  const second = await buildTargetAttestation({
    ...baseArguments,
    accountsSha256: secondAccountsSha256
  })
  const serialized = JSON.stringify([first, second])

  t.not(first.confirmation, second.confirmation)
  t.false(Object.hasOwn(first, 'accountsSha256'))
  t.false(serialized.includes(firstAccountsSha256))
  t.false(serialized.includes(secondAccountsSha256))
  for (const email of [...Object.values(VALID_ACCOUNTS), changedAccounts.ddt]) {
    t.false(serialized.includes(email))
  }

  await t.throwsAsync(buildTargetAttestation(baseArguments), {
    message: /accountsSha256 doit être un SHA-256/
  })
  await t.throwsAsync(buildTargetAttestation({
    ...baseArguments,
    accountsSha256: 'invalide'
  }), {message: /accountsSha256 doit être un SHA-256/})
})

test('la policy demo exige le rôle applicatif, TLS verify-full et la CA attendue', async t => {
  const attestation = await buildTargetAttestation({
    target: 'demo',
    targetEnvironment: demoEnvironment(),
    dataset: DEFAULT_DATASET,
    datasetSha256: DATASET_SHA256,
    accountsSha256: ACCOUNTS_SHA256
  })

  t.deepEqual(attestation.database, {
    host: 'rw-ea5a07db-05df-4869-9e57-fa5f5c6c81cc.rdb.fr-par.scw.cloud',
    port: '17063',
    name: 'prelevements_demo',
    user: 'prelevements_demo_app',
    tls: true,
    caSha256: sha256(await readFile(demoCertificatePath))
  })

  await t.throwsAsync(buildTargetAttestation({
    target: 'demo',
    targetEnvironment: demoEnvironment({
      DATABASE_URL: demoEnvironment().DATABASE_URL.replace('prelevements_demo_app', 'demo_admin')
    }),
    dataset: DEFAULT_DATASET,
    datasetSha256: DATASET_SHA256,
    accountsSha256: ACCOUNTS_SHA256
  }), {message: /identité PostgreSQL non autorisée \(user\)/})

  await t.throwsAsync(buildTargetAttestation({
    target: 'demo',
    targetEnvironment: demoEnvironment({
      DATABASE_URL: demoEnvironment().DATABASE_URL.replace('verify-full', 'require')
    }),
    dataset: DEFAULT_DATASET,
    datasetSha256: DATASET_SHA256,
    accountsSha256: ACCOUNTS_SHA256
  }), {message: /TLS PostgreSQL exige/})
})

test('une cible custom exige une policy non-production exacte et sans secret', async t => {
  const directory = await createTestDirectory(t)
  const certificatePath = await writePrivateFile(directory, 'ca.pem', 'fake public CA')
  const policy = {
    version: 1,
    name: 'review',
    production: false,
    appEnv: 'review',
    database: {
      host: 'db.review.example.test',
      port: '5432',
      name: 'review_database',
      user: 'review_app',
      tls: true,
      caSha256: sha256('fake public CA')
    }
  }
  const policyPath = path.join(directory, 'policy.json')
  await writeFile(policyPath, `${JSON.stringify(policy)}\n`)
  const loadedPolicy = await loadTargetPolicy(policyPath)
  const search = new URLSearchParams({sslmode: 'verify-full', sslrootcert: certificatePath})
  const attestation = await buildTargetAttestation({
    target: 'custom',
    targetEnvironment: {
      APP_ENV: 'review',
      DATABASE_URL: `postgresql://review_app:fake-password@db.review.example.test:5432/review_database?${search}`
    },
    targetPolicy: loadedPolicy,
    dataset: DEFAULT_DATASET,
    datasetSha256: DATASET_SHA256,
    accountsSha256: ACCOUNTS_SHA256
  })

  t.is(attestation.policyName, 'review')
  t.regex(attestation.confirmation, /^custom:[a-f\d]{12}$/)

  const productionPolicyPath = path.join(directory, 'unsafe-policy.json')
  await writeFile(productionPolicyPath, `${JSON.stringify({...policy, production: true})}\n`)
  await t.throwsAsync(loadTargetPolicy(productionPolicyPath), {message: /production doit valoir exactement false/})

  const knownProductionPath = path.join(directory, 'known-unsafe.json')
  await writeFile(knownProductionPath, `${JSON.stringify({
    ...policy,
    database: {...policy.database, host: '51.15.219.67'}
  })}\n`)
  await t.throwsAsync(loadTargetPolicy(knownProductionPath), {message: /cible production interdite/})

  const secretPolicyPath = path.join(directory, 'secret-policy.json')
  await writeFile(secretPolicyPath, `${JSON.stringify({...policy, databasePassword: 'do-not-store'})}\n`)
  await t.throwsAsync(loadTargetPolicy(secretPolicyPath), {message: /ne doit contenir aucun secret/})
})

test('les indices de production sont toujours refusés', async t => {
  await t.throwsAsync(buildTargetAttestation({
    target: 'local',
    targetEnvironment: localEnvironment({APP_ENV: 'production'}),
    dataset: DEFAULT_DATASET,
    datasetSha256: DATASET_SHA256,
    accountsSha256: ACCOUNTS_SHA256
  }), {message: /APP_ENV doit valoir local ou development|production interdite/})

  await t.throwsAsync(buildTargetAttestation({
    target: 'local',
    targetEnvironment: localEnvironment({
      DATABASE_URL: 'postgresql://prod_app:fake-password@127.0.0.1:5432/prod_database'
    }),
    dataset: DEFAULT_DATASET,
    datasetSha256: DATASET_SHA256,
    accountsSha256: ACCOUNTS_SHA256
  }), {message: /production interdite/})
})

test('assertApplyConfirmation exige la confirmation liée à l’attestation', async t => {
  const attestation = await buildTargetAttestation({
    target: 'local',
    targetEnvironment: localEnvironment(),
    dataset: DEFAULT_DATASET,
    datasetSha256: DATASET_SHA256,
    accountsSha256: ACCOUNTS_SHA256
  })

  t.deepEqual(assertApplyConfirmation({
    command: 'apply',
    target: 'local',
    apply: false
  }, attestation), {authorized: false, dryRun: true})

  t.throws(() => assertApplyConfirmation({
    command: 'apply',
    target: 'local',
    apply: true,
    confirmTarget: 'local:incorrect'
  }, attestation), {message: new RegExp(attestation.confirmation)})

  t.deepEqual(assertApplyConfirmation({
    command: 'apply',
    target: 'local',
    apply: true,
    confirmTarget: attestation.confirmation
  }, attestation), {authorized: true, dryRun: false})
})

test('redactSensitive retire les secrets explicites et les mots de passe URL', t => {
  const redacted = redactSensitive({
    DATABASE_URL: 'postgresql://user:database-password@database.example.test/db',
    nested: {
      clientSecret: 'client-secret',
      callback: 'https://user:url-password@example.test/path',
      safe: 'visible'
    }
  })
  const serialized = JSON.stringify(redacted)

  t.false(serialized.includes('database-password'))
  t.false(serialized.includes('client-secret'))
  t.false(serialized.includes('url-password'))
  t.true(serialized.includes('visible'))
})

test('writeSecureJsonReport publie atomiquement un rapport 0600 expurgé', async t => {
  const directory = await createTestDirectory(t)
  const reportPath = path.join(directory, 'report.json')
  const result = await writeSecureJsonReport(reportPath, {
    ok: true,
    password: 'report-secret',
    databaseUrl: 'postgresql://user:url-secret@database.example.test/db'
  })
  const reportStat = await stat(reportPath)
  const content = await readFile(reportPath, 'utf8')

  t.is(result, reportPath)
  t.is(reportStat.mode & 0o777, 0o600)
  t.false(content.includes('report-secret'))
  t.false(content.includes('url-secret'))
  const directoryEntries = await readdir(directory)
  t.deepEqual(directoryEntries.sort(), ['report.json'])
  await t.throwsAsync(writeSecureJsonReport(reportPath, {ok: false}), {code: 'EEXIST'})
})

test('un rapport est réservé avant mutation puis finalisé sans fenêtre sans trace', async t => {
  const directory = await createTestDirectory(t)
  const reportPath = path.join(directory, 'reserved-report.json')
  const reservation = await reserveSecureJsonReport(reportPath, {
    command: 'apply',
    databaseUrl: 'postgresql://user:reservation-secret@database.example.test/db'
  })
  const reservedStat = await stat(reportPath)
  const reserved = JSON.parse(await readFile(reportPath, 'utf8'))

  t.is(reservedStat.mode & 0o777, 0o600)
  t.is(reserved.status, 'RESERVED_BEFORE_DATABASE_OPERATION')
  t.false(JSON.stringify(reserved).includes('reservation-secret'))

  await finalizeSecureJsonReport(reservation, {success: false, status: 'FAILED'})
  const finalized = JSON.parse(await readFile(reportPath, 'utf8'))
  t.deepEqual(finalized, {success: false, status: 'FAILED'})
})

test('la finalisation refuse une réservation remplacée', async t => {
  const directory = await createTestDirectory(t)
  const reportPath = path.join(directory, 'replaced-report.json')
  const reservation = await reserveSecureJsonReport(reportPath)
  await rm(reportPath)
  await writeFile(reportPath, '{"unsafe":true}\n', {mode: 0o600})

  await t.throwsAsync(
    finalizeSecureJsonReport(reservation, {success: true}),
    {message: /réservation du rapport|jeton de réservation/}
  )
})

test('le rapport distingue explicitement un échec survenu après commit', t => {
  t.deepEqual(describeSeedOutcome({
    command: 'apply',
    authorized: true,
    apply: {success: true},
    operationError: new Error('lecture impossible')
  }), {
    success: false,
    status: 'COMMITTED_POSTCHECK_FAILED',
    databaseWriteStatus: 'COMMITTED'
  })

  t.deepEqual(describeSeedOutcome({
    command: 'apply',
    authorized: true,
    apply: {success: true},
    verification: {success: false}
  }), {
    success: false,
    status: 'COMMITTED_VERIFICATION_FAILED',
    databaseWriteStatus: 'COMMITTED'
  })

  t.deepEqual(describeSeedOutcome({
    command: 'apply',
    authorized: true,
    operationError: new Error('transaction refusée')
  }), {
    success: false,
    status: 'FAILED',
    databaseWriteStatus: 'NOT_CONFIRMED'
  })

  t.deepEqual(describeSeedOutcome({command: 'apply', authorized: true}), {
    success: false,
    status: 'APPLY_NOT_CONFIRMED',
    databaseWriteStatus: 'NOT_CONFIRMED'
  })
})

test('le statut opérateur expose sans ambiguïté le résultat et l’écriture en base', t => {
  t.is(
    formatSeedOutcome({
      status: 'COMMITTED_POSTCHECK_FAILED',
      databaseWriteStatus: 'COMMITTED'
    }),
    '[demo-seed] status=COMMITTED_POSTCHECK_FAILED databaseWriteStatus=COMMITTED'
  )
})
