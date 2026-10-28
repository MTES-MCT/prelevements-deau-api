#!/usr/bin/env node
import process from 'node:process'
import path from 'node:path'
import {readFile} from 'node:fs/promises'
import {parseArgs} from 'node:util'
import {PutObjectCommand} from '@aws-sdk/client-s3'
import {loadEnv, verifyManifestChecksum, createS3Context, assertVersionedS3Bucket, hashS3Object} from './lib/runtime.js'
import {reservePrivateReport} from './lib/access-cli.js'
import {historyTarget, historyPlanHash, assertHistorySimulation, HISTORY_TARGET_OPTIONS, historyTargetArguments} from './lib/history-target.js'
import {RECOVER_DOCUMENT_OPERATION, recoveredDocumentScope, captureRecoveredDocumentState,
  planRecoveredDocument, assertRecoveredDocumentBackup, applyRecoveredDocument} from './lib/recovered-document.js'

async function ensureObject(storage, scope, file) {
  const existing = await hashS3Object(storage, scope.storageKey)
  if (existing.missing) {
    try {
      await storage.client.send(new PutObjectCommand({Bucket: storage.bucket, Key: scope.storageKey,
        Body: file, ContentType: 'application/pdf', IfNoneMatch: '*',
        Metadata: {sha256: scope.sha256}}), {abortSignal: AbortSignal.timeout(60000)})
    } catch (error) {
      if (error.$metadata?.httpStatusCode !== 412) throw error
    }
  }
  const verified = await hashS3Object(storage, scope.storageKey)
  if (verified.sha256 !== scope.sha256 || verified.size !== scope.size) throw new Error('Vérification S3 différente du PDF original')
  return verified
}

export async function restoreDocument({manifest, legacyDocumentId, file: filename, sourceUrl,
  targetEnv, reportFile, target = 'local', apply = false, ...targetOptions}) {
  process.umask(0o077)
  const {content} = await verifyManifestChecksum(path.resolve(manifest))
  const file = await readFile(filename)
  const scope = recoveredDocumentScope(content, {legacyDocumentId, file, sourceUrl})
  const sourceHash = historyPlanHash(scope)
  const configuration = await loadEnv(targetEnv)
  const context = await historyTarget({target, configuration, sourceHash, targetEnv, apply, withStorage: false, ...targetOptions})
  let output, storage
  try {
    storage = createS3Context(configuration, 'Document réglementaire récupéré')
    if (target === 'testing') await assertVersionedS3Bucket(storage, 'Documents testing', 'fr-par')
    output = await reservePrivateReport(reportFile)
    const evidence = apply && target === 'testing' ? JSON.parse(await readFile(targetOptions.backupEvidence, 'utf8')) : undefined
    const snapshot = evidence ? JSON.parse(await readFile(evidence.backupFile, 'utf8')) : undefined
    const result = await context.prisma.$transaction(async tx => {
      if (!apply) await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
      if (apply) {
        await tx.$queryRawUnsafe('SELECT "userId" FROM "Declarant" WHERE "sourceId"=$1 FOR UPDATE', scope.ownerSourceId)
        await tx.$queryRawUnsafe('SELECT id FROM "DeclarantPointPrelevement" WHERE "sourceId"=ANY($1::text[]) ORDER BY id FOR UPDATE', scope.exploitationSourceIds)
        await tx.$queryRawUnsafe('SELECT id FROM "ResourceRule" WHERE "sourceId"=ANY($1::text[]) ORDER BY id FOR UPDATE', scope.ruleSourceIds)
      }
      const object = await hashS3Object(storage, scope.storageKey)
      const before = await captureRecoveredDocumentState(tx, scope)
      const plan = planRecoveredDocument(scope, before, object)
      if (apply && target === 'testing') {
        assertHistorySimulation(context.expected, {target, operation: RECOVER_DOCUMENT_OPERATION, sourceHash,
          planHash: plan.planHash, attestation: context.attestation})
        assertRecoveredDocumentBackup(evidence, snapshot, plan, sourceHash)
      }
      if (!apply) return {...plan, object, verified: false}
      const restoredObject = await ensureObject(storage, scope, file)
      const documentId = await applyRecoveredDocument(tx, plan)
      const after = await captureRecoveredDocumentState(tx, scope)
      const replay = planRecoveredDocument(scope, after, restoredObject)
      const stable = state => ({owner: state.owner, exploitations: state.exploitations,
        rules: state.rules.map(({documentId: _document, updatedAt: _updated, ...row}) => row)})
      if (Object.values(replay.changes).some(Boolean) || historyPlanHash(stable(before)) !== historyPlanHash(stable(after))) {
        throw new Error('Des champs métier ont changé pendant le rattachement du document')
      }
      return {...plan, documentId, object: restoredObject, after, verified: true}
    }, {timeout: 180000})
    const report = {createdAt: new Date().toISOString(), target, operation: RECOVER_DOCUMENT_OPERATION,
      apply, complete: true, attestation: context.attestation, backup: context.backup, sourceHash, scope, ...result}
    await output.writeFile(`${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify({operation: report.operation, target, apply, changes: result.changes, verified: result.verified}))
    return report
  } finally {
    await output?.close()
    storage?.client.destroy()
    await context.close()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const {values} = parseArgs({options: {...HISTORY_TARGET_OPTIONS,
    manifest: {type: 'string'}, 'legacy-document-id': {type: 'string'}, file: {type: 'string'},
    'source-url': {type: 'string'}, 'target-env': {type: 'string'}, report: {type: 'string'}, apply: {type: 'boolean', default: false}}})
  await restoreDocument({manifest: values.manifest, legacyDocumentId: values['legacy-document-id'],
    file: values.file, sourceUrl: values['source-url'], targetEnv: values['target-env'], reportFile: values.report,
    apply: values.apply, ...historyTargetArguments(values)})
}
