import {randomUUID} from 'node:crypto'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {parseArgs} from 'node:util'
import {validateProdAdminDatabaseUrl} from './network/prod-database-target.js'
import {requireDisposableDatabase} from '../lib/util/test-helpers/disposable-database.js'
import {applyCampaignPublications, previewCampaignPublications, verifyCampaignPublications,
  privatePublicationReportDirectory, readPrivatePublicationReport, writePrivatePublicationReport,
  validatePublicationRecheckScope} from './lib/campaign-publication-recheck.js'

export function parsePublicationRecheckArguments(args) {
  const {values} = parseArgs({args, strict: true, allowPositionals: false, options: {
    mode: {type: 'string'}, target: {type: 'string'}, 'campaign-id': {type: 'string'},
    'response-ids': {type: 'string'}, report: {type: 'string'},
    'expected-report': {type: 'string'}, 'expected-report-hash': {type: 'string'}, 'backup-dir': {type: 'string'}
  }})
  if (!['preview', 'apply', 'verify'].includes(values.mode)) throw new Error('--mode preview, apply ou verify est obligatoire.')
  const scope = validatePublicationRecheckScope({target: values.target, campaignId: values['campaign-id'],
    responseIds: values['response-ids']?.split(',')})
  if (!values.report) throw new Error('--report est obligatoire.')
  if (values.mode !== 'preview' && (!values['expected-report'] || !values['expected-report-hash'])) {
    throw new Error('--expected-report et --expected-report-hash sont obligatoires.')
  }
  if (values.mode === 'apply' && !values['backup-dir']) throw new Error('--backup-dir est obligatoire pour appliquer.')
  return {...scope, mode: values.mode, reportPath: path.resolve(values.report),
    expectedReportPath: values['expected-report'], expectedReportHash: values['expected-report-hash'], backupDir: values['backup-dir']}
}

async function main() {
  const options = parsePublicationRecheckArguments(process.argv.slice(2))
  await privatePublicationReportDirectory(path.dirname(options.reportPath))
  if (options.expectedReportPath) options.expectedReport = await readPrivatePublicationReport(options.expectedReportPath)
  if (options.backupDir) {
    const backupDir = await privatePublicationReportDirectory(options.backupDir)
    options.onBeforeApply = backup => writePrivatePublicationReport(path.join(backupDir, `before-${backup.responseId}-${randomUUID()}.json`), backup)
    options.onAfterEntry = entry => writePrivatePublicationReport(path.join(backupDir, `committed-${entry.responseId}-${randomUUID()}.json`), entry)
  }
  await import('../lib/config/env.js')
  if (options.target === 'prod') validateProdAdminDatabaseUrl(process.env.DATABASE_URL)
  else requireDisposableDatabase()
  const {prisma} = await import('../db/prisma.js')
  try {
    const operation = {preview: previewCampaignPublications, apply: applyCampaignPublications, verify: verifyCampaignPublications}[options.mode]
    const report = await operation(prisma, options)
    await writePrivatePublicationReport(options.reportPath, report)
    console.log(JSON.stringify({operation: report.operation, mode: report.mode, complete: report.complete,
      campaignId: report.campaignId, reportHash: report.reportHash, counts: report.counts, reasons: report.reasons,
      responses: report.entries.map(entry => ({responseId: entry.responseId, status: entry.publicationStatus,
        changed: entry.changed, verified: entry.verified}))}, null, 2))
    if (!report.complete) process.exitCode = 1
  } catch (error) {
    await writePrivatePublicationReport(path.join(path.dirname(options.reportPath), `failure-${randomUUID()}.json`), {
      operation: 'recheck-campaign-publications', complete: false, mode: options.mode,
      campaignId: options.campaignId, responseIds: options.responseIds, expectedReportHash: options.expectedReportHash,
      error: {name: error.name, message: error.message, code: error.code, stack: error.stack}
    })
    throw new Error('Reprise interrompue. Consulter le rapport privé failure et les journaux committed avant de reprendre.', {cause: error})
  } finally {
    await prisma.$disconnect()
    await globalThis.pgPool?.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    // Never dump driver errors or connection strings to the operator console.
    console.error(error.message.startsWith('Reprise interrompue.') ? error.message
      : 'Commande refusée : vérifier les arguments, la cible et les permissions des fichiers privés.')
    process.exitCode = 1
  })
}
