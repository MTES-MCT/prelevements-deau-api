import test from 'ava'
import {sha256, manifestLines} from '../lib/core.js'
import {historyPlanHash} from '../lib/history-target.js'
import {recoveredDocumentScope, planRecoveredDocument, assertRecoveredDocumentBackup,
  RECOVER_DOCUMENT_OPERATION} from '../lib/recovered-document.js'

export function documentFixture() {
  const file = Buffer.from('%PDF-synthetic-document-fixture')
  const document = {_id: 'document', nom_fichier: 'synthetic.pdf', taille: file.length,
    objectKey: `DEP-974/owner/${sha256(file).slice(0, 8)}/synthetic.pdf`, preleveur: 'owner',
    reference: 'REF-SYNTHETIC', date_signature: '2025-08-22', s3: {missing: true, excluded: true}}
  const content = manifestLines({territory: 'DEP-974', transformationContract: {}}, [
    {kind: 'document', data: document}, {kind: 'declarant', data: {_id: 'owner', id_preleveur: 999999}},
    {kind: 'exploitation', data: {_id: 'exploitation', id_exploitation: 999999, preleveur: 'owner', documents: ['document']}},
    {kind: 'rule', data: {_id: 'rule', preleveur: 'owner', document: 'document', exploitations: ['exploitation']}}
  ])
  const input = {legacyDocumentId: 'document', file, sourceUrl: 'https://example.test/original.pdf'}
  const scope = recoveredDocumentScope(content, input)
  const before = {owner: {userId: 'user', declarantRole: 'PRELEVEUR', user: {id: 'user', deletedAt: null}},
    exploitations: [{id: 'exploitation', sourceId: scope.exploitationSourceIds[0], declarantUserId: 'user'}],
    rules: [{id: 'rule', declarantUserId: 'user', documentId: null, value: 123,
      exploitations: [{declarantPointPrelevementId: 'exploitation'}]}], documents: []}
  return {file, content, input, scope, before}
}

test('document récupéré : empreinte et taille source, propriétaire et références stables', t => {
  const {scope, file, content, input} = documentFixture()
  t.is(scope.sha256, sha256(file))
  t.is(scope.documentSourceId, 'reunion:DEP-974:document:document:owner:owner')
  t.is(scope.document.signatureDate, '2025-08-22T00:00:00.000Z')
  t.throws(() => recoveredDocumentScope(content, {...input, file: Buffer.from('%PDF-different-document-fixtur')}))
  t.throws(() => recoveredDocumentScope(content, {...input, sourceUrl: 'https://user:secret@example.test/file'}))
  t.throws(() => recoveredDocumentScope(content.replace('"missing":true', '"missing":false'), input))
})

test('document récupéré : refuse collision S3, propriétaire différent, règle déjà liée et document modifié', t => {
  const {scope, before} = documentFixture()
  t.deepEqual(planRecoveredDocument(scope, before, {missing: true}).changes,
    {document: 1, exploitationLinks: 1, ruleLinks: 1, object: 1})
  t.throws(() => planRecoveredDocument(scope, before, {sha256: 'wrong', size: scope.size}))
  t.throws(() => planRecoveredDocument(scope, {...before, rules: [{...before.rules[0], documentId: 'other'}]}, {missing: true}))
  t.throws(() => planRecoveredDocument(scope, {...before, exploitations: [{...before.exploitations[0], declarantUserId: 'other'}]}, {missing: true}))
  const planned = planRecoveredDocument(scope, before, {missing: true})
  const after = {...before, documents: [{...planned.expected, id: 'doc', exploitations: [{declarantPointPrelevementId: 'exploitation'}]}],
    rules: [{...before.rules[0], documentId: 'doc'}]}
  t.deepEqual(planRecoveredDocument(scope, after, {sha256: scope.sha256, size: scope.size}).changes,
    {document: 0, exploitationLinks: 0, ruleLinks: 0, object: 0})
  t.throws(() => planRecoveredDocument(scope, {...after, documents: [{...after.documents[0], reference: 'changed'}]}, {missing: true}))
})

test('document récupéré : sauvegarde liée à la source et à l’état exact de la simulation', t => {
  const {scope, before} = documentFixture()
  const plan = planRecoveredDocument(scope, before, {missing: true})
  const sourceHash = historyPlanHash(scope)
  const snapshot = {operation: RECOVER_DOCUMENT_OPERATION, sourceHash, rows: before}
  const evidence = {operation: RECOVER_DOCUMENT_OPERATION, sourceHash, planHash: plan.planHash, rowsSha256: historyPlanHash(before)}
  t.notThrows(() => assertRecoveredDocumentBackup(evidence, snapshot, plan, sourceHash))
  t.throws(() => assertRecoveredDocumentBackup({...evidence, planHash: 'stale'}, snapshot, plan, sourceHash))
  t.throws(() => assertRecoveredDocumentBackup(evidence, {...snapshot, rows: {...before, documents: [{}]}}, plan, sourceHash))
})
