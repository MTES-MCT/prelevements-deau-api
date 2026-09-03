#!/usr/bin/env node

import process from 'node:process'

import {
  READ_ONLY_ZONE_PERMISSIONS,
  ZONE_PERMISSION_CODES
} from '../../lib/constants/zone-permissions.js'
import {buildGrivaiseDataset, validateGrivaiseDataset} from './lib/grivaise-dataset.js'
import {SEED_USAGE, parseArguments} from './lib/seed-cli.js'
import {
  describeSeedOutcome,
  finalizeSecureJsonReport,
  formatSeedOutcome,
  reserveSecureJsonReport
} from './lib/seed-report.js'
import {collectSeedState} from './lib/seed-state.js'
import {
  assertApplyConfirmation,
  buildTargetAttestation,
  loadExclusiveSeedInputs,
  redactSensitive,
  sha256,
  stableStringify
} from './lib/seed-target.js'
import {verifySeedState} from './lib/seed-verifier.js'

function countDatasetItems(dataset) {
  return {
    zones: 1,
    agents: 2,
    declarants: dataset.preleveurs.length + 1,
    preleveurs: dataset.preleveurs.length,
    points: dataset.points.length,
    exploitations: dataset.exploitations.length,
    collectorLinks: dataset.collectorLinks.reduce(
      (total, link) => total + link.exploitationSourceIds.length,
      0
    ),
    meters: dataset.meters.length,
    declarations: dataset.declarations.length,
    chunks: dataset.declarations.reduce(
      (total, declaration) => total + declaration.chunks.length,
      0
    ),
    values: dataset.declarations.reduce(
      (declarationTotal, declaration) => declarationTotal + declaration.chunks.reduce(
        (chunkTotal, chunk) => chunkTotal + chunk.values.length,
        0
      ),
      0
    )
  }
}

function useTargetEnvironment(targetEnvironment) {
  process.env.APP_ENV = targetEnvironment.APP_ENV
  process.env.DATABASE_URL = targetEnvironment.DATABASE_URL
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error)
  return redactSensitive({message}).message
}

function printAttestation(attestation, datasetCounts) {
  console.log(
    `[demo-seed] cible=${attestation.target} environnement=${attestation.appEnv} `
    + `base=${attestation.database.name} dataset=${attestation.dataset}`
  )
  console.log(
    `[demo-seed] plan: ${datasetCounts.preleveurs} préleveurs, `
    + `${datasetCounts.points} points, ${datasetCounts.declarations} déclarations, `
    + `${datasetCounts.values} valeurs`
  )
  console.log(`[demo-seed] confirmation d’écriture: ${attestation.confirmation}`)
}

function printVerification(verification) {
  if (verification.success) {
    console.log(`[demo-seed] vérification réussie (${verification.checks.length} contrôles)`)
    return
  }

  console.error(
    `[demo-seed] vérification en échec (${verification.errors.length} contrôle(s))`
  )
  for (const error of verification.errors) {
    console.error(`[demo-seed] - ${error.message}`)
  }
}

async function runConnectedSeed(context, operation) {
  const {authorization, database, databaseModule, dataset, datasetCounts, inputs, options} = context
  operation.connectedDatabase = await databaseModule.assertConnectedDatabaseIdentity({
    database,
    attestation: context.attestation
  })
  operation.preflight = await databaseModule.preflightSeed({
    database,
    dataset,
    accounts: inputs.accounts
  })

  if (operation.preflight.success !== true) {
    throw new Error(
      `Préflight refusé : ${(operation.preflight.issues ?? []).join(' ; ') || 'état cible incompatible'}`
    )
  }

  console.log(
    `[demo-seed] préflight réussi : ${operation.preflight.collisions} collision, `
    + `${operation.preflight.overlappingNonSeedValues} valeur externe en conflit`
  )

  if (options.command === 'apply' && authorization.authorized) {
    operation.apply = await databaseModule.applySeed({
      database,
      dataset,
      accounts: inputs.accounts,
      preflight: operation.preflight
    })
  } else if (options.command === 'apply') {
    operation.apply = {dryRun: true, planned: datasetCounts}
    console.log('[demo-seed] dry-run : aucune écriture effectuée')
  }

  if (options.command === 'verify' || authorization.authorized) {
    operation.state = await databaseModule.withSeedStateSnapshot({
      database,
      databaseUrl: inputs.targetEnvironment.DATABASE_URL,
      collect: snapshotDatabase => collectSeedState({
        database: snapshotDatabase,
        dataset,
        accounts: inputs.accounts,
        zonePermissionCodes: ZONE_PERMISSION_CODES,
        readOnlyZonePermissions: READ_ONLY_ZONE_PERMISSIONS
      })
    })
    operation.verification = verifySeedState(operation.state)
    printVerification(operation.verification)
  }
}

async function runDatabaseSeed(context, operation) {
  const [databaseModule, prismaModule] = await Promise.all([
    import('./lib/seed-database.js'),
    import('../../db/prisma.js')
  ])
  const {prisma} = prismaModule
  let operationError

  try {
    await prisma.$connect()
    await runConnectedSeed({...context, database: prisma, databaseModule}, operation)
  } catch (error) {
    operationError = error
  }

  try {
    await prisma.$disconnect()
  } catch (error) {
    operationError ??= error
  }

  if (operationError) {
    throw operationError
  }
}

async function executeCommand(options) {
  const dataset = buildGrivaiseDataset()
  validateGrivaiseDataset(dataset)
  const datasetSha256 = sha256(stableStringify(dataset))
  const datasetCounts = countDatasetItems(dataset)
  const inputs = await loadExclusiveSeedInputs(options)
  const accountsSha256 = sha256(stableStringify(inputs.accounts))
  const attestation = await buildTargetAttestation({
    target: options.target,
    targetEnvironment: inputs.targetEnvironment,
    targetPolicy: inputs.targetPolicy,
    dataset: options.dataset,
    datasetSha256,
    accountsSha256
  })
  const authorization = assertApplyConfirmation(options, attestation)
  const startedAt = new Date().toISOString()

  printAttestation(attestation, datasetCounts)
  const reportReservation = options.report
    ? await reserveSecureJsonReport(options.report, {
      version: 1,
      command: options.command,
      dryRun: authorization.dryRun,
      startedAt,
      attestation,
      dataset: {
        id: dataset.metadata.id,
        version: dataset.metadata.version,
        sha256: datasetSha256,
        counts: datasetCounts
      }
    })
    : null
  if (reportReservation) {
    console.log(`[demo-seed] chemin du rapport réservé: ${reportReservation.absolutePath}`)
  }

  useTargetEnvironment(inputs.targetEnvironment)

  const operation = {}
  let operationError

  try {
    await runDatabaseSeed({
      options,
      authorization,
      attestation,
      dataset,
      datasetCounts,
      inputs
    }, operation)
  } catch (error) {
    operationError = error
  }

  const outcome = describeSeedOutcome({
    command: options.command,
    authorized: authorization.authorized,
    apply: operation.apply,
    verification: operation.verification,
    operationError
  })
  const printOutcome = outcome.success ? console.log : console.error
  printOutcome(formatSeedOutcome(outcome))
  const report = {
    version: 1,
    ...outcome,
    command: options.command,
    dryRun: authorization.dryRun,
    startedAt,
    completedAt: new Date().toISOString(),
    attestation,
    connectedDatabase: operation.connectedDatabase,
    dataset: {
      id: dataset.metadata.id,
      version: dataset.metadata.version,
      sha256: datasetSha256,
      counts: datasetCounts
    },
    preflight: operation.preflight,
    apply: operation.apply,
    state: operation.state,
    verification: operation.verification,
    ...(operationError ? {error: {message: safeErrorMessage(operationError)}} : {})
  }

  if (reportReservation) {
    try {
      const reportPath = await finalizeSecureJsonReport(reportReservation, report)
      console.log(`[demo-seed] rapport écrit: ${reportPath}`)
    } catch (reportError) {
      if (operationError) {
        throw new Error(
          `${safeErrorMessage(operationError)} ; rapport non finalisé : ${safeErrorMessage(reportError)}`,
          {cause: operationError}
        )
      }

      throw reportError
    }
  }

  if (operationError) {
    throw operationError
  }

  if (operation.verification && !operation.verification.success) {
    process.exitCode = 1
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    console.log(SEED_USAGE)
    return
  }

  await executeCommand(options)
}

main().catch(error => {
  console.error(`[demo-seed] échec: ${safeErrorMessage(error)}`)
  process.exitCode = 1
})
