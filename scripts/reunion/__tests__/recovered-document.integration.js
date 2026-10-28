import process from 'node:process'
import {randomUUID} from 'node:crypto'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../../lib/util/test-helpers/disposable-database.js'
import {captureRecoveredDocumentState, planRecoveredDocument, applyRecoveredDocument} from '../lib/recovered-document.js'

const enabled = process.env.REUNION_ACCESS_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

integration('SQL restaure un document, ses liens et rejoue sans changer les règles ni les droits', async t => {
  const rollback = new Error('ROLLBACK_RECOVERED_DOCUMENT')
  try {
    await prisma.$transaction(async client => {
      const key = randomUUID()
      const owner = await client.user.create({data: {role: 'DECLARANT', email: `${key}@example.test`,
        declarant: {create: {sourceId: `${key}:owner`, socialReason: 'Synthetic', preleveurType: 'AUTRE'}}}})
      const usage = await client.sandreWaterUse.findUniqueOrThrow({where: {code: '2'}})
      const point = await client.pointPrelevement.create({data: {name: key, waterBodyType: 'SOUTERRAIN', flowType: 'PRELEVEMENT'}})
      const exploitation = await client.declarantPointPrelevement.create({data: {sourceId: `${key}:exploitation`,
        declarantUserId: owner.id, pointPrelevementId: point.id, usageId: usage.id}})
      const rule = await client.resourceRule.create({data: {sourceId: `${key}:rule`, declarantUserId: owner.id,
        parameter: 'volume prélevé', unit: 'm³', value: 123.45, constraint: 'MAX', validityStartDate: new Date('2025-01-01'),
        exploitations: {create: {declarantPointPrelevementId: exploitation.id}}}})
      const scope = {ownerSourceId: `${key}:owner`, exploitationSourceIds: [`${key}:exploitation`], ruleSourceIds: [`${key}:rule`],
        documentSourceId: `${key}:document`, storageKey: `${key}/original.pdf`, sha256: 'a'.repeat(64), size: 123,
        document: {contentSha256: 'a'.repeat(64), filename: 'original.pdf', title: 'Synthetic', reference: key,
          nature: null, comment: null, signatureDate: '2025-01-01T00:00:00.000Z', validityEndDate: null,
          deletedAt: null, mimeType: 'application/pdf', size: 123}}
      const before = await captureRecoveredDocumentState(client, scope)
      const plan = planRecoveredDocument(scope, before, {missing: true})
      t.is(plan.changes.ruleLinks, 1)
      t.is(await client.resourceDocument.count({where: {sourceId: scope.documentSourceId}}), 0)
      const id = await applyRecoveredDocument(client, plan)
      const after = await captureRecoveredDocumentState(client, scope)
      t.deepEqual(after.owner, before.owner)
      t.deepEqual(after.exploitations, before.exploitations)
      const {documentId, updatedAt: _afterDate, ...actualRule} = await client.resourceRule.findUniqueOrThrow({where: {id: rule.id}})
      const {documentId: _oldDocument, updatedAt: _beforeDate, ...expectedRule} = rule
      t.deepEqual(actualRule, expectedRule)
      t.is(documentId, id)
      const replay = planRecoveredDocument(scope, after, {sha256: scope.sha256, size: scope.size})
      t.deepEqual(replay.changes, {document: 0, exploitationLinks: 0, ruleLinks: 0, object: 0})
      t.is(await applyRecoveredDocument(client, replay), id)
      t.deepEqual(await captureRecoveredDocumentState(client, scope), after)
      throw rollback
    })
  } catch (error) { if (error !== rollback) throw error }
})
