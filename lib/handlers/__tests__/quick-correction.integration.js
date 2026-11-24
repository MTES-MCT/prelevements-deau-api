/* eslint-disable no-await-in-loop -- Synthetic requests use an isolated scope on the disposable database. */
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import test from 'ava'
import express from 'express'
import request from 'supertest'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {createRoutes} from '../../routes.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

function api(user) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.auth = {type: 'USER_SESSION'}
    req.user = user
    req.userRole = user.role
    next()
  })
  app.use(createRoutes())
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({message: error.message}))
  return request(app)
}

async function fixture(count = 1) {
  const user = role => prisma.user.create({data: {role: 'DECLARANT', declarant: {create: {declarantRole: role, preleveurType: role === 'PRELEVEUR' ? 'IRRIGANT' : null}}}})
  const owner = await user('PRELEVEUR')
  const collector = await user('COLLECTEUR')
  const admin = await prisma.user.create({data: {role: 'ADMIN'}})
  const usage = await prisma.sandreWaterUse.findFirstOrThrow({where: {kind: 'USAGE'}})
  const entries = []
  for (let i = 0; i < count; i++) {
    const point = await prisma.pointPrelevement.create({data: {name: 'Point de test correction ' + randomUUID(), waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'}})
    const exploitation = await prisma.declarantPointPrelevement.create({data: {
      declarantUserId: owner.id, pointPrelevementId: point.id, usageId: usage.id, status: 'EN_ACTIVITE',
      collecteurs: {create: {collecteurUserId: collector.id}}
    }})
    entries.push({pointPrelevementId: point.id, exploitationId: exploitation.id, usageId: usage.id})
  }
  return {owner, collector, admin, entries}
}

function edits(entry) {
  const {id, pointPrelevementId, exploitationId, usageId, value} = entry
  return {id, pointPrelevementId, exploitationId, usageId, value}
}

async function confirmed(t, client, path, body, create = false) {
  const preview = await client.post(path + '/preview').send(body)
  t.is(preview.status, 200, JSON.stringify(preview.body))
  const save = await client[create ? 'post' : 'patch'](path).send({...body, previewToken: preview.body.data.previewToken})
  t.is(save.status, create ? 201 : 200, JSON.stringify(save.body))
  return {preview: preview.body.data, data: save.body.data}
}

integration('aperçu annulable, conversion globale par administrateur, révisions privées et suppression de toutes les lignes', async t => {
  const f = await fixture(2)
  const owner = api(f.owner)
  const admin = api(f.admin)
  const create = {measurementType: 'INDEX', entries: f.entries.map((e, i) => ({...e, readingDate: '2026-01-20', value: i === 0 ? 0 : 50}))}
  const first = await owner.post('/declarations/quick/preview').send(create)
  t.is(first.status, 200, JSON.stringify(first.body))
  t.is(await prisma.declaration.count({where: {declarantUserId: f.owner.id}}), 0)
  const {data: created} = await confirmed(t, owner, '/declarations/quick', create, true)
  const path = '/declarations/' + created.id + '/quick'
  const original = (await admin.get(path)).body.data
  t.is(original.revision, 0)
  t.is(original.sourceId, created.source.id)
  const body = {measurementType: 'VOLUME', revision: original.revision,
    entries: original.entries.map((e, i) => ({...edits(e), value: i * 10,
      periodStartDate: '2026-02-01', periodEndDate: i === 0 ? '2026-02-01' : '2026-02-03'}))}
  const {preview, data} = await confirmed(t, admin, path, body)
  t.is(preview.changes.length, 2)
  t.is(data.revision, 1)
  const saved = await owner.get(path)
  t.is(saved.body.data.measurementType, 'VOLUME')
  t.deepEqual(saved.body.data.entries.map(e => e.value).sort((a,b) => a-b), [0,10])
  t.false(Object.hasOwn(saved.body.data, 'before'))
  const rev = await prisma.quickDeclarationRevision.findFirstOrThrow({where: {declarationId: created.id}})
  t.is(rev.actorUserId, f.admin.id)
  t.is(rev.before.measurementType, 'INDEX')
  t.is(rev.after.measurementType, 'VOLUME')
  t.is((await prisma.declaration.findUniqueOrThrow({where: {id: created.id}})).createdByDeclarantUserId, f.owner.id)
  t.is((await admin.patch(path).send({...body, previewToken: preview.previewToken})).status, 409)
  const reverse = {measurementType: 'INDEX', revision: 1, entries: saved.body.data.entries.map(e => ({...edits(e), value: 12, readingDate: '2026-03-04'}))}
  await confirmed(t, owner, path, reverse)
  await confirmed(t, admin, path, {measurementType: 'INDEX', revision: 2, entries: []})
  t.deepEqual((await owner.get(path)).body.data.entries, [])
  const source = await prisma.source.findUniqueOrThrow({where: {id: created.source.id}})
  t.is(source.metadata.entriesCount, 0)
  t.truthy(source.metadata.quickModifiedAt)
})

integration('les droits portent sur toutes les lignes du dossier et les identités restent stables en correction', async t => {
  const f = await fixture(2)
  const {data} = await confirmed(t, api(f.owner), '/declarations/quick', {measurementType:'INDEX', readingDate:'2026-01-01',
    entries:f.entries.map(e=>({...e,value:20}))}, true)
  const path = '/declarations/' + data.id + '/quick'
  const collector = api(f.collector)
  const original = (await collector.get(path)).body.data
  t.is(original.entries.length, 2)
  const stranger = (await fixture()).owner
  t.is((await api(stranger).get(path)).status, 403)
  t.is((await api({role:'INSTRUCTOR',id:f.admin.id}).get(path)).status, 403)
  const altered = {measurementType:'INDEX', revision:0, entries:original.entries.map(e=>({...edits(e),readingDate:'2026-01-01'}))}
  altered.entries[0].pointPrelevementId = altered.entries[1].pointPrelevementId
  t.is((await collector.post(path + '/preview').send(altered)).status, 403)
  await prisma.declarantCollecteurExploitation.deleteMany({where:{collecteurUserId:f.collector.id,exploitationId:f.entries[0].exploitationId}})
  t.is((await collector.get(path)).status, 403)
  t.is((await collector.post(path + '/preview').send({measurementType:'INDEX',revision:0,entries:[]})).status, 403)
  await prisma.source.update({where:{id:data.source.id},data:{metadata:{manualQuickDeclaration:true, collectionCampaignId:'campaign'}}})
  t.is((await api(f.admin).get(path)).status, 404)
  await prisma.declaration.update({where:{id:data.id},data:{dataSourceType:'SPREADSHEET'}})
  t.is((await api(f.admin).get(path)).status, 404)
})

integration('un nouveau voisin invalide la confirmation et la lecture précédente n’empêche pas une nouvelle date', async t => {
  const f = await fixture()
  const owner = api(f.owner)
  const body = (date, value) => ({measurementType:'INDEX',entries:[{...f.entries[0],readingDate:date,value}]})
  await confirmed(t, owner, '/declarations/quick', body('2026-01-01',100), true)
  const candidate = body('2026-01-20',80)
  const first = await owner.post('/declarations/quick/preview').send(candidate)
  t.true(first.body.data.warnings.some(w=>w.code === 'INDEX_BELOW_PREVIOUS'))
  const earlier = await owner.post('/declarations/quick/preview').send(body('2025-12-31',80))
  t.false(earlier.body.data.warnings.some(w=>w.code === 'INDEX_BELOW_PREVIOUS'))
  await confirmed(t, owner, '/declarations/quick', body('2026-01-10',110), true)
  t.is((await owner.post('/declarations/quick').send({...candidate,previewToken:first.body.data.previewToken})).status,409)
  const accepted = await confirmed(t, owner, '/declarations/quick', candidate, true)
  t.true(accepted.preview.warnings.some(w=>w.code === 'INDEX_BELOW_PREVIOUS' && w.neighborValue === 110))
})

integration('une ancienne saisie suit son exploitation datée et ne peut être déplacée sur une exploitation successive', async t => {
  const f = await fixture()
  const entry = f.entries[0]
  const {data} = await confirmed(t, api(f.owner), '/declarations/quick', {
    readingDate: '2024-05-01', entries: [{...entry, value: 12}]
  }, true)
  const chunkId = data.source.chunks[0].id
  await prisma.chunk.update({where: {id: chunkId}, data: {preleveurUserId: null, exploitationId: null}})
  await prisma.declarantPointPrelevement.update({where: {id: entry.exploitationId},
    data: {countingCode: 'ANCIEN', startDate: new Date('2023-01-01'), endDate: new Date('2024-12-31')}})
  await prisma.declarantPointPrelevement.create({data: {declarantUserId: f.owner.id, pointPrelevementId: entry.pointPrelevementId,
    startDate: new Date('2025-01-01'), countingCode: 'SUIVANT', usageId: entry.usageId}})
  const path = '/declarations/' + data.id + '/quick'
  const collector = api(f.collector)
  const result = await collector.get(path)
  t.is(result.status, 200, JSON.stringify(result.body))
  const [old] = result.body.data.entries
  t.is(old.exploitationId, null)
  t.is(old.effectiveExploitationId, entry.exploitationId)
  t.is(old.countingCode, 'ANCIEN')
  const payload = {measurementType: 'INDEX', revision: 0, entries: [{...edits(old), readingDate: '2025-05-01', value: 14}]}
  delete payload.entries[0].exploitationId
  t.is((await collector.post(path + '/preview').send(payload)).status, 403)
  payload.entries[0].readingDate = '2024-06-01'
  await confirmed(t, collector, path, payload)
  t.is((await collector.get(path)).body.data.entries[0].value, 14)
  const persisted = await prisma.chunk.findUniqueOrThrow({where: {id: chunkId}})
  t.is(persisted.exploitationId, null)
})

integration('deux confirmations du même aperçu n’appliquent et n’auditent la correction qu’une fois', async t => {
  const f = await fixture()
  const owner = api(f.owner)
  const {data} = await confirmed(t, owner, '/declarations/quick', {
    measurementType: 'VOLUME', periodStartDate: '2026-02-01', periodEndDate: '2026-02-03',
    entries: [{...f.entries[0], value: 22}]
  }, true)
  const path = '/declarations/' + data.id + '/quick'
  const original = (await owner.get(path)).body.data
  const body = {revision: 0, measurementType: 'VOLUME',
    entries: [{...edits(original.entries[0]), periodStartDate: '2026-02-01', periodEndDate: '2026-02-04', value: 29}]}
  const preview = await owner.post(path + '/preview').send(body)
  t.is(preview.status, 200)
  const payload = {...body, previewToken: preview.body.data.previewToken}
  const results = await Promise.all([owner.patch(path).send(payload), owner.patch(path).send(payload)])
  t.deepEqual(results.map(r => r.status).sort(), [200, 409])
  t.is(await prisma.quickDeclarationRevision.count({where: {declarationId: data.id}}), 1)
})

integration('un volume direct partiellement écrasé reste archivé après retrait du dossier qui l’a remplacé', async t => {
  const f = await fixture()
  const owner = api(f.owner)
  const declare = (start, end, value) => ({
    measurementType: 'VOLUME', entries: [{...f.entries[0], periodStartDate: start, periodEndDate: end, value}]
  })
  const previous = await confirmed(t, owner, '/declarations/quick', declare('2026-05-05', '2026-05-15', 60), true)
  const replacing = await confirmed(t, owner, '/declarations/quick', declare('2026-05-14', '2026-05-25', 20), true)
  const overlap = replacing.preview.warnings.find(w => w.code === 'VOLUME_OVERLAP')
  t.is(overlap.declarationCode, previous.data.code)
  t.is(overlap.periodStartDate, '2026-05-05')
  t.is(overlap.periodEndDate, '2026-05-15')
  t.is((await owner.get('/declarations/' + previous.data.id + '/quick')).body.data.entries.length, 0)
  await confirmed(t, owner, '/declarations/' + replacing.data.id + '/quick', {measurementType: 'VOLUME', revision: 0, entries: []})
  t.is(await prisma.chunkValue.count({where: {chunk: {pointPrelevementId: f.entries[0].pointPrelevementId}}}), 0)
  t.is(await prisma.chunkValueReplacement.count({where: {replacedSourceId: previous.data.source.id}}), 1)
})

integration('relevé précédent et réactivation d’un index à date identique sans volume dérivé', async t => {
  const f = await fixture()
  const owner = api(f.owner)
  const draft = (readingDate, value) => ({measurementType: 'INDEX', entries: [{...f.entries[0], value, readingDate}]})
  await confirmed(t, owner, '/declarations/quick', draft('2026-04-15', 10), true)
  const replacement = await confirmed(t, owner, '/declarations/quick', draft('2026-04-15', 11), true)
  const third = await owner.post('/declarations/quick/preview').send(draft('2026-04-15', 12))
  t.is(third.status, 200, JSON.stringify(third.body))
  const sameDate = third.body.data.warnings.filter(warning => warning.code === 'INDEX_SAME_DATE')
  t.deepEqual(sameDate.map(warning => warning.value), [11])
  const path = '/declarations/' + replacement.data.id + '/quick'
  const original = (await owner.get(path)).body.data
  t.falsy(original.entries[0].previousReading)
  const payload = {revision: 0, measurementType: 'INDEX', entries: []}
  const first = await owner.post(path + '/preview').send(payload)
  t.is(first.status, 200, JSON.stringify(first.body))
  const restored = first.body.data.warnings.find(w => w.code === 'PREVIOUS_INDEX_RESTORED')
  t.is(restored.value, 10)
  t.is(restored.entryId, original.entries[0].id)
  t.is(first.body.data.changes.length, 0)
  await confirmed(t, owner, '/declarations/quick', draft('2026-04-10', 3), true)
  const previous = (await owner.get(path)).body.data.entries[0].previousReading
  t.is(previous.date, '2026-04-10')
  t.is(previous.value, 3)
})

integration('index : ajout, modification, déplacement et retrait atomiques avec un aperçu stable et un audit complet', async t => {
  const {owner, admin, entries: [a, b, c, d, e]} = await fixture(5)
  const actor = api(owner)
  const adminApi = api(admin)
  const index = (entry, date, value) => ({...entry, readingDate: date, value})
  await confirmed(t, actor, '/declarations/quick', {measurementType: 'INDEX', entries: [index(d, '2026-06-01', 80)]}, true)
  const {data: dossier} = await confirmed(t, actor, '/declarations/quick', {measurementType: 'INDEX',
    entries: [index(a, '2026-06-10', 50), index(b, '2026-06-10', 100), index(c, '2026-06-10', 20)]}, true)
  const path = '/declarations/' + dossier.id + '/quick'
  const original = (await adminApi.get(path)).body.data
  const originalById = new Map(original.entries.map(row => [row.exploitationId, row]))
  const existing = exploitation => edits(originalById.get(exploitation.exploitationId))
  const inputs = [index(existing(a), '2026-06-10', 55), index(existing(b), '2026-06-12', 100),
    index(d, '2026-06-10', 8), index(e, '2026-06-10', 0)]
  const body = {measurementType: 'INDEX', revision: 0, entries: inputs}
  const p1 = await adminApi.post(path + '/preview').send(body)
  t.is(p1.status, 200, JSON.stringify(p1.body))
  const p2 = await adminApi.post(path + '/preview').send({...body, entries: [...inputs].reverse()})
  t.deepEqual(p1.body.data, p2.body.data)
  const warning = p1.body.data.warnings.find(w => w.code === 'INDEX_BELOW_PREVIOUS')
  t.is(warning.exploitationId, d.exploitationId)
  t.is(warning.neighborValue, 80)
  t.false(Object.hasOwn(warning, 'entryId'))
  t.deepEqual((await actor.get(path)).body.data.entries, original.entries)
  const payload = {...body, previewToken: p1.body.data.previewToken}
  const confirmedRequests = await Promise.all([adminApi.patch(path).send(payload), adminApi.patch(path).send(payload)])
  t.deepEqual(confirmedRequests.map(r => r.status).sort(), [200, 409])
  const saved = (await actor.get(path)).body.data
  t.is(saved.revision, 1)
  t.is(saved.entries.length, 4)
  const savedById = new Map(saved.entries.map(row => [row.exploitationId, row]))
  t.is(savedById.get(a.exploitationId).id, existing(a).id)
  t.is(savedById.get(a.exploitationId).value, 55)
  t.is(savedById.get(b.exploitationId).readingDate, '2026-06-12')
  t.false(savedById.has(c.exploitationId))
  t.is(savedById.get(d.exploitationId).value, 8)
  t.is(savedById.get(e.exploitationId).value, 0)
  const added = await prisma.chunk.findUniqueOrThrow({where: {id: savedById.get(d.exploitationId).id}})
  t.is(added.preleveurUserId, owner.id)
  t.is(added.submittedByDeclarantUserId, null)
  const audit = await prisma.quickDeclarationRevision.findUniqueOrThrow({where: {declarationId_revision: {declarationId: dossier.id, revision: 1}}})
  t.is(audit.actorUserId, admin.id)
  t.is(audit.effectiveUserId, admin.id)
  t.is(audit.before.entries.length, 3)
  t.is(audit.after.entries.length, 4)
  t.true(audit.after.entries.some(row => row.id === added.id))
  t.is((await prisma.declaration.findUniqueOrThrow({where: {id: dossier.id}})).createdByDeclarantUserId, owner.id)
})

integration('volume : un comptage ajouté remplace un comptage retiré à effectif constant et les deux restent soumis aux droits', async t => {
  const {owner, collector, entries: [a, b, c]} = await fixture(3)
  const actor = api(owner)
  const delegate = api(collector)
  const vol = (entry, value) => ({...entry, value, periodStartDate: '2026-05-01', periodEndDate: '2026-05-03'})
  const {data: dossier} = await confirmed(t, actor, '/declarations/quick', {measurementType: 'VOLUME', entries: [vol(a, 12), vol(b, 5)]}, true)
  const path = '/declarations/' + dossier.id + '/quick'
  const before = (await delegate.get(path)).body.data
  const line = (draft, entry) => edits(draft.entries.find(e => e.exploitationId === entry.exploitationId))
  // Keep A unchanged, remove B, add C with zero. The number of rows and unchanged retained values are identical.
  const body = {measurementType: 'VOLUME', revision: 0, entries: [vol(line(before, a), 12), vol(c, 0)]}
  const {preview} = await confirmed(t, delegate, path, body)
  t.true(preview.changes.some(change => change.exploitationId === b.exploitationId && change.before === 5 && change.after === null))
  t.true(preview.changes.some(change => change.exploitationId === c.exploitationId && change.before === null && change.after === 0))
  const after = (await delegate.get(path)).body.data
  t.is(after.revision, 1)
  const added = await prisma.chunk.findUniqueOrThrow({where: {id: line(after, c).id}})
  t.is(added.submittedByDeclarantUserId, collector.id)
  t.is(added.collecteurUserId, collector.id)
  t.is(added.preleveurUserId, owner.id)
  await confirmed(t, delegate, path, {measurementType: 'VOLUME', revision: 1, entries: [vol(line(after, a), 12)]})
  await prisma.declarantCollecteurExploitation.deleteMany({where: {collecteurUserId: collector.id, exploitationId: c.exploitationId}})
  t.is((await delegate.get(path)).status, 403)
  t.is((await delegate.post(path + '/preview').send({revision: 2, measurementType: 'VOLUME', entries: []})).status, 403)
  await confirmed(t, actor, path, {revision: 2, measurementType: 'VOLUME', entries: []})
  t.deepEqual((await actor.get(path)).body.data.availableEntries, [])
  t.is((await actor.post(path + '/preview').send({revision: 3, measurementType: 'VOLUME', entries: [vol(b, 40)]})).status, 409)
})

integration('options d’ajout filtrées et autorisation revérifiée à l’enregistrement', async t => {
  const {owner, collector, admin, entries: [a,b,c,d,e]} = await fixture(5)
  const stranger = await fixture()
  const ownerApi = api(owner)
  const delegate = api(collector)
  const adminApi = api(admin)
  const date = '2026-02-01'
  const {data: dossier} = await confirmed(t, ownerApi, '/declarations/quick', {
    measurementType: 'INDEX', readingDate: date, entries: [{...a, value: 1}]
  }, true)
  const path = '/declarations/' + dossier.id + '/quick'
  await prisma.declarantPointPrelevement.update({where: {id: b.exploitationId}, data: {countingCode: 'BIS'}})
  await prisma.declarantPointPrelevement.update({where: {id: c.exploitationId}, data: {excludeFromQuickDeclaration: true}})
  await prisma.pointPrelevement.update({where: {id: d.pointPrelevementId}, data: {collectionMode: 'EXTERNAL'}})
  await prisma.declarantCollecteurExploitation.deleteMany({where: {collecteurUserId: collector.id, exploitationId: e.exploitationId}})
  const original = (await delegate.get(path)).body.data
  t.deepEqual(original.availableEntries.map(o => o.exploitationId).sort(), [a.exploitationId, b.exploitationId].sort())
  const option = original.availableEntries.find(o => o.exploitationId === b.exploitationId)
  t.is(option.countingCode, 'BIS')
  t.truthy(option.usageLabel)
  t.truthy(option.pointName)
  t.is(option.usageId, b.usageId)
  t.is(option.compteurId, null)
  const allowed = [a.exploitationId, b.exploitationId, e.exploitationId].sort()
  t.deepEqual((await ownerApi.get(path)).body.data.availableEntries.map(o => o.exploitationId).sort(), allowed)
  t.deepEqual((await adminApi.get(path)).body.data.availableEntries.map(o => o.exploitationId).sort(), allowed)
  const saved = {...edits(original.entries[0]), readingDate: date}
  const candidate = x => ({measurementType: 'INDEX', revision: 0, readingDate: date, entries: [saved, {...x, value: 0}]})
  for (const bad of [c, d, e, stranger.entries[0], {...b, pointPrelevementId: a.pointPrelevementId}, {...b, usageId: randomUUID()}]) {
    t.is((await delegate.post(path + '/preview').send(candidate(bad))).status, 403)
  }
  t.is((await adminApi.post(path + '/preview').send(candidate(stranger.entries[0]))).status, 403)
  t.is((await delegate.post(path + '/preview').send(candidate(a))).status, 400)
  const duplicate = candidate(b)
  duplicate.entries.push(duplicate.entries[1])
  t.is((await delegate.post(path + '/preview').send(duplicate)).status, 400)
  const withoutIdentity = candidate(b)
  delete withoutIdentity.entries[1].exploitationId
  t.is((await delegate.post(path + '/preview').send(withoutIdentity)).status, 400)
  const preview = await delegate.post(path + '/preview').send(candidate(b))
  t.is(preview.status, 200, JSON.stringify(preview.body))
  await prisma.declarantCollecteurExploitation.deleteMany({where: {collecteurUserId: collector.id, exploitationId: b.exploitationId}})
  t.is((await delegate.patch(path).send({...candidate(b), previewToken: preview.body.data.previewToken})).status, 403)
  t.is((await ownerApi.get(path)).body.data.entries.length, 1)
})

integration('deux comptages du même point restent distincts lors d’une conversion avec ajout', async t => {
  const {owner, entries: [a]} = await fixture()
  await prisma.declarantPointPrelevement.update({where: {id: a.exploitationId}, data: {countingCode: 'CANAL-A'}})
  const sibling = await prisma.declarantPointPrelevement.create({data: {declarantUserId: owner.id,
    pointPrelevementId: a.pointPrelevementId, usageId: a.usageId, countingCode: 'CANAL-B', status: 'EN_ACTIVITE'}})
  const actor = api(owner)
  const {data: dossier} = await confirmed(t, actor, '/declarations/quick', {
    measurementType: 'INDEX', readingDate: '2026-07-18', entries: [{...a, value: 50}]
  }, true)
  const path = '/declarations/' + dossier.id + '/quick'
  const before = (await actor.get(path)).body.data
  t.deepEqual(before.availableEntries.map(row => row.countingCode), ['CANAL-A', 'CANAL-B'])
  const draft = {measurementType: 'VOLUME', revision: 0, entries: [
    {...edits(before.entries[0]), value: 50, periodStartDate: '2026-07-01', periodEndDate: '2026-07-18'},
    {...a, exploitationId: sibling.id, value: 17, periodStartDate: '2026-07-12', periodEndDate: '2026-07-22'}
  ]}
  const {preview} = await confirmed(t, actor, path, draft)
  t.deepEqual(preview.changes.map(row => row.after).sort((a,b) => a-b), [17,50])
  const read = (await actor.get(path)).body.data
  t.is(read.measurementType, 'VOLUME')
  t.true(read.entries.some(row => row.countingCode === 'CANAL-B' && row.value === 17 && row.periodStartDate === '2026-07-12'))
})

integration('une correction signale les anomalies d’index et de volumes directs sur les seules séries touchées', async t => {
  const {owner, entries: [a, b]} = await fixture(2)
  const actor = api(owner)
  const dated = (e, day, value) => ({...e, readingDate: '2026-01-'+day, value})
  await confirmed(t, actor, '/declarations/quick', {measurementType: 'INDEX', entries: [dated(a,'01',100),dated(b,'01',100)]}, true)
  await confirmed(t, actor, '/declarations/quick', {measurementType: 'VOLUME',
    entries: [{...a, periodStartDate: '2026-01-05', periodEndDate: '2026-01-06', value: 7}]}, true)
  const {preview: original, data} = await confirmed(t, actor, '/declarations/quick', {
    measurementType: 'INDEX', entries: [dated(a,'10',80),dated(b,'10',110)]
  }, true)
  t.true(original.warnings.some(w => w.code === 'INDEX_BELOW_PREVIOUS' && w.exploitationId === a.exploitationId))
  t.true(original.warnings.some(w => w.code === 'DIRECT_VOLUME_PRIORITY' && w.exploitationId === a.exploitationId))
  const path = '/declarations/' + data.id + '/quick'
  const draft = (await actor.get(path)).body.data
  const rows = draft.entries.map(e => dated(edits(e), '10', e.exploitationId === a.exploitationId ? 80 : 90))
  const {preview} = await confirmed(t, actor, path, {measurementType: 'INDEX', revision: 0, entries: rows})
  t.deepEqual(preview.warnings.map(w => [w.code, w.exploitationId]), [['INDEX_BELOW_PREVIOUS', b.exploitationId]])
  const second = await actor.post(path+'/preview').send({measurementType: 'INDEX', revision: 1,
    entries: rows.map(row => ({...row,value: row.exploitationId === a.exploitationId ? 79 : row.value}))})
  t.is(second.status, 200, JSON.stringify(second.body))
  t.true(second.body.data.warnings.every(w => w.exploitationId === a.exploitationId))
  t.deepEqual(second.body.data.warnings.map(w => w.code).sort(), ['DIRECT_VOLUME_PRIORITY','INDEX_BELOW_PREVIOUS'])
})
