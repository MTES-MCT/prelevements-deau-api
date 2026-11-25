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

const receipt = (declarationId, revision) => prisma.declarationReceipt.findUniqueOrThrow({
  where: {declarationId_revision: {declarationId, revision}}
})

integration('le récapitulatif fige le précédent, le volume de chaque relevé et la période suivante à la confirmation', async t => {
  const {owner, collector, admin, entries: [a, b, c, d]} = await fixture(4)
  const submitter = await prisma.user.update({where: {id: collector.id}, data: {email: randomUUID() + '@example.test'}})
  const delegate = api(submitter)
  const site = api(owner)
  for (const [i, row] of [a, b, c, d].entries()) {
    await prisma.declarantPointPrelevement.update({where: {id: row.exploitationId}, data: {countingCode: String(i + 1)}})
  }
  await prisma.pointPrelevement.update({where: {id: b.pointPrelevementId}, data: {flowType: 'REJET'}})
  const create = (readingDate, entries) => ({measurementType: 'INDEX', readingDate, entries, declarantUserId: owner.id})
  const start = '/declarations/quick'
  await confirmed(t, site, start, create('2026-01-01', [{...a, value: 10}, {...b, value: 0}]), true)
  const {data} = await confirmed(t, delegate, start, {...create('2026-01-12', [{...b, value: 0}, {...a, value: 18}, {...c, value: 9}]),
    formExploitationIds: [a,b,c,d].map(e => e.exploitationId)}, true)
  const received = await receipt(data.id, 0)
  t.is(received.kind, 'QUICK_CREATED')
  t.is(received.recipientUserId, collector.id)
  const [zero, main, first] = received.snapshot.series
  t.deepEqual(received.snapshot.series.map(row => row.countingCode), ['2','1','3'])
  t.is(zero.flowType, 'REJET')
  t.deepEqual(zero.after.previousReading, {date: '2026-01-01', value: 0})
  t.is(zero.after.computedVolume, 0)
  t.is(main.after.computedVolume, 8)
  t.is(first.after.computedVolume, null)
  t.is(first.after.previousReading, null)
  t.true(received.snapshot.series.every(row => row.status === 'ADDED' && !row.before))

  await confirmed(t, site, start, create('2026-01-20', [{...a, value: 40}]), true)
  const editPath = '/declarations/' + data.id + '/quick'
  const service = api(admin)
  const original = (await service.get(editPath)).body.data.entries
  const entry = ref => original.find(row => row.exploitationId === ref.exploitationId)
  const updated = {measurementType: 'INDEX', revision: 0, readingDate: '2026-01-12',
    entries: [{...edits(entry(a)), value: 17}, edits(entry(b)), {...d, value: 5}],
    receiptRowOrder: [{id: entry(c).id}, {id: randomUUID()}, {exploitationId: d.exploitationId}, {id: entry(b).id}, {id: entry(a).id}]}
  const preview = await service.post(editPath + '/preview').send(updated)
  t.is(preview.status, 200)
  t.is(await prisma.declarationReceipt.count({where: {declarationId: data.id}}), 1)
  const confirm = {...updated, previewToken: preview.body.data.previewToken}
  t.is((await service.patch(editPath).send(confirm)).status, 200)
  t.is((await service.patch(editPath).send(confirm)).status, 409)
  const saved = await receipt(data.id, 1)
  t.is(saved.recipientUserId, collector.id)
  t.is(saved.kind, 'QUICK_UPDATED')
  const rows = saved.snapshot.series
  t.deepEqual(rows.map(row => [row.countingCode, row.status]), [['3','REMOVED'], ['4','ADDED'], ['2','UNCHANGED'], ['1','MODIFIED']])
  t.is(rows[0].after, null)
  t.is(rows[1].before, null)
  t.is(rows[2].after.computedVolume, 0)
  t.deepEqual(rows[3].after.previousReading, {date: '2026-01-01', value: 10})
  t.is(rows[3].before.computedVolume, 8)
  t.is(rows[3].after.computedVolume, 7)
  t.deepEqual(rows[3].periods.map(p => [p.periodStartDate, p.periodEndDate, p.before, p.after]),
    [['2026-01-01','2026-01-12',8,7], ['2026-01-12','2026-01-20',22,23]])
  t.deepEqual((await receipt(data.id, 0)).snapshot, received.snapshot)
  const now = (await service.get(editPath)).body.data.entries
  await confirmed(t, service, editPath, {...updated, revision: 1, entries: now.map(edits)})
  t.is(await prisma.declarationReceipt.count({where: {declarationId: data.id}}), 2)
})

integration('un ancien formulaire peut créer sans aperçu et conserve la distinction entre prélèvement et rejet', async t => {
  const {owner, entries} = await fixture(2)
  const actor = api(owner)
  const [withdrawal, discharge] = entries
  await prisma.pointPrelevement.update({where: {id: discharge.pointPrelevementId}, data: {flowType: 'REJET'}})
  const period = {periodStartDate: '2026-04-01', periodEndDate: '2026-04-30'}
  for (const [entry, measurementType, total] of [
    [withdrawal, 'VOLUME_PRELEVE', 'totalWaterVolumeWithdrawn'],
    [discharge, 'VOLUME_REJETE', 'totalWaterVolumeDischarged']
  ]) {
    const created = await actor.post('/declarations/quick').send({
      measurementType, ...period, entries: [{pointPrelevementId: entry.pointPrelevementId, usageId: entry.usageId, value: 14}]
    })
    t.is(created.status, 201, JSON.stringify(created.body))
    const {source} = created.body.data
    t.is(source.metadata.measurementType, 'VOLUME')
    t.is(source.metadata[total], 14)
    t.is(source.chunks[0].exploitationId, entry.exploitationId)
    const editPath = '/declarations/' + created.body.data.id + '/quick'
    const saved = (await actor.get(editPath)).body.data
    const missingPreview = await actor.patch(editPath).send({
      measurementType: 'VOLUME', revision: 0, ...period, entries: [{...edits(saved.entries[0]), value: 15}]
    })
    t.is(missingPreview.status, 409)
    t.is((await actor.get(editPath)).body.data.revision, 0)
  }
})

integration('aperçu annulable, conversion globale par administrateur, révisions privées et suppression de toutes les lignes', async t => {
  const f = await fixture(2)
  const outletId = f.entries[1].pointPrelevementId
  await prisma.pointPrelevement.update({where: {id: outletId}, data: {flowType: 'REJET'}})
  const owner = api(f.owner)
  const admin = api(f.admin)
  const create = {measurementType: 'INDEX', entries: f.entries.map((e, i) => ({...e, readingDate: '2026-01-20', value: i === 0 ? 0 : 50}))}
  const first = await owner.post('/declarations/quick/preview').send(create)
  t.is(first.status, 200, JSON.stringify(first.body))
  t.is(await prisma.declaration.count({where: {declarantUserId: f.owner.id}}), 0)
  const {data: created} = await confirmed(t, owner, '/declarations/quick', create, true)
  const path = '/declarations/' + created.id + '/quick'
  const original = (await admin.get(path)).body.data
  t.deepEqual(Object.fromEntries(original.entries.map(row => [row.pointPrelevementId, row.flowType])), {
    [f.entries[0].pointPrelevementId]: 'PRELEVEMENT', [outletId]: 'REJET'
  })
  t.is(original.revision, 0)
  t.is(original.sourceId, created.source.id)
  const body = {measurementType: 'VOLUME', revision: original.revision, periodStartDate: '2026-02-01', periodEndDate: '2026-02-03',
    entries: original.entries.map((e, i) => ({...edits(e), value: i * 10}))}
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
  const converted = (await receipt(created.id, 2)).snapshot
  t.true(converted.series.every(row => row.before.type === 'VOLUME' && row.after.type === 'INDEX' && row.status === 'MODIFIED'))
  const removed = (await receipt(created.id, 3)).snapshot
  t.is(removed.series.length, 2)
  t.true(removed.series.every(row => row.before.type === 'INDEX' && row.after === null && row.status === 'REMOVED'))
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
    formExploitationIds: [a,b,c,d,e].map(e => e.exploitationId),
    entries: [index(a, '2026-06-10', 50), index(b, '2026-06-10', 100), index(c, '2026-06-10', 20)]}, true)
  const path = '/declarations/' + dossier.id + '/quick'
  const original = (await adminApi.get(path)).body.data
  const originalById = new Map(original.entries.map(row => [row.exploitationId, row]))
  const existing = exploitation => edits(originalById.get(exploitation.exploitationId))
  const inputs = [{...existing(a), value: 55}, existing(b), {...d, value: 8}, {...e, value: 0}]
  const body = {measurementType: 'INDEX', revision: 0, readingDate: '2026-06-12', entries: inputs}
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
  t.true(saved.entries.every(row => row.readingDate === '2026-06-12'))
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
  const {data: dossier} = await confirmed(t, actor, '/declarations/quick', {measurementType: 'VOLUME', formExploitationIds: [a,b,c].map(e => e.exploitationId), entries: [vol(a, 12), vol(b, 5)]}, true)
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
  const empty = (await actor.get(path)).body.data
  t.deepEqual(empty.emptyEntries, [])
  t.deepEqual(empty.mapPoints, [])
  t.is((await actor.post(path + '/preview').send({revision: 3, measurementType: 'VOLUME', entries: [vol(b, 40)]})).status, 409)
})

integration('cases vides du formulaire et coordonnées PostGIS limitées au périmètre autorisé', async t => {
  const {owner, collector, admin, entries: [a,b,c,d,e,unlisted]} = await fixture(6)
  const stranger = await fixture()
  const ownerApi = api(owner)
  const delegate = api(collector)
  const adminApi = api(admin)
  const date = '2026-02-01'
  const {data: dossier} = await confirmed(t, ownerApi, '/declarations/quick', {
    measurementType: 'INDEX', readingDate: date, formExploitationIds: [a,b,c,d,e].map(row => row.exploitationId), entries: [{...a, value: 1}]
  }, true)
  const path = '/declarations/' + dossier.id + '/quick'
  await prisma.declarantPointPrelevement.update({where: {id: b.exploitationId}, data: {countingCode: 'BIS'}})
  await prisma.declarantPointPrelevement.update({where: {id: c.exploitationId}, data: {excludeFromQuickDeclaration: true}})
  await prisma.pointPrelevement.update({where: {id: d.pointPrelevementId}, data: {collectionMode: 'EXTERNAL'}})
  await prisma.declarantCollecteurExploitation.deleteMany({where: {collecteurUserId: collector.id, exploitationId: e.exploitationId}})
  for (const [i, row] of [a,b,c,d,e,unlisted].entries()) {
    await prisma.$executeRaw`UPDATE "PointPrelevement" SET coordinates = ST_SetSRID(ST_MakePoint(${i}::float8, 45.5),4326) WHERE id=${row.pointPrelevementId}::uuid`
  }
  const original = (await delegate.get(path)).body.data
  t.false(Object.hasOwn(original,'availableEntries'))
  t.deepEqual(original.emptyEntries.map(o => o.exploitationId), [b.exploitationId])
  t.deepEqual(original.mapPoints.map(p => [p.id,p.coordinates]), [
    [a.pointPrelevementId,{type: 'Point', coordinates:[0,45.5]}], [b.pointPrelevementId,{type: 'Point', coordinates:[1,45.5]}]
  ])
  t.false(Object.hasOwn(original.entries[0], 'coordinates'))
  const option = original.emptyEntries.find(o => o.exploitationId === b.exploitationId)
  t.is(option.countingCode, 'BIS')
  t.truthy(option.usageLabel)
  t.truthy(option.pointName)
  t.is(option.usageId, b.usageId)
  t.is(option.compteurId, null)
  const allowed = [b.exploitationId, e.exploitationId].sort()
  t.deepEqual((await ownerApi.get(path)).body.data.emptyEntries.map(o => o.exploitationId).sort(), allowed)
  t.deepEqual((await adminApi.get(path)).body.data.emptyEntries.map(o => o.exploitationId).sort(), allowed)
  const saved = {...edits(original.entries[0]), readingDate: date}
  const candidate = x => ({measurementType: 'INDEX', revision: 0, readingDate: date, entries: [saved, {...x, value: 0}]})
  for (const bad of [c, d, e, unlisted, stranger.entries[0], {...b, pointPrelevementId: a.pointPrelevementId}, {...b, usageId: randomUUID()}]) {
    t.is((await delegate.post(path + '/preview').send(candidate(bad))).status, 403)
  }
  t.is((await adminApi.post(path + '/preview').send(candidate(stranger.entries[0]))).status, 403)
  t.is((await adminApi.post(path + '/preview').send(candidate(unlisted))).status, 403)
  t.is((await ownerApi.post(path + '/preview').send({...candidate(unlisted),formExploitationIds: [unlisted.exploitationId]})).status, 400)
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
    measurementType: 'INDEX', readingDate: '2026-07-18', formExploitationIds: [a.exploitationId,sibling.id], entries: [{...a, value: 50}]
  }, true)
  const path = '/declarations/' + dossier.id + '/quick'
  const before = (await actor.get(path)).body.data
  t.deepEqual(before.emptyEntries.map(row => row.countingCode), ['CANAL-B'])
  t.deepEqual(before.mapPoints.map(row => row.id), [a.pointPrelevementId])
  const draft = {measurementType: 'VOLUME', revision: 0, periodStartDate: '2026-07-12', periodEndDate: '2026-07-22',
    entries: [edits(before.entries[0]), {...a, exploitationId: sibling.id, value: 17}]}
  const {preview} = await confirmed(t, actor, path, draft)
  t.deepEqual(preview.changes.map(row => row.after).sort((a,b) => a-b), [17,50])
  const read = (await actor.get(path)).body.data
  t.is(read.measurementType, 'VOLUME')
  t.true(read.entries.some(row => row.countingCode === 'CANAL-B' && row.value === 17 && row.periodStartDate === '2026-07-12'))
  const {snapshot} = await receipt(dossier.id, 1)
  t.deepEqual(snapshot.series.map(row => [row.countingCode, row.before?.type, row.after.type]), [
    ['CANAL-A', 'INDEX', 'VOLUME'], ['CANAL-B', undefined, 'VOLUME']
  ])
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
  const [overlap, ordinary] = (await receipt(data.id, 0)).snapshot.series
  t.true(overlap.warnings.some(w => w.code === 'DIRECT_VOLUME_PRIORITY' && w.message))
  t.is(overlap.after.computedVolume, null)
  t.deepEqual(overlap.after.previousReading, {date: '2026-01-01', value: 100})
  t.is(ordinary.after.computedVolume, 10)
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

for (const measurementType of ['INDEX', 'VOLUME']) {
  const isIndex = measurementType === 'INDEX'
  const dates = isIndex ? {readingDate: '2026-01-11'} : {periodStartDate: '2026-01-04', periodEndDate: '2026-01-11'}
  const alternate = isIndex ? {readingDate: '2026-01-12'} : {periodStartDate: '2026-01-04', periodEndDate: '2026-01-12'}
  const shiftedField = isIndex ? 'readingDate' : 'periodEndDate'

  integration(measurementType + ' : les chemins de saisie refusent les dates divergentes avant écriture et acceptent les anciens clients uniformes', async t => {
    const f = await fixture(2)
    const actor = api(f.owner)
    const entries = f.entries.map((e,i) => ({...e, value: i}))
    const both = {measurementType, ...dates, entries: entries.map(e => ({...e, ...dates}))}
    const conflicting = {...both, entries: [{...entries[0], ...alternate}, entries[1]]}
    for (const suffix of ['', '/preview', '/conflicts']) {
      t.is((await actor.post('/declarations/quick'+suffix).send(conflicting)).status, 400)
      t.is((await actor.post('/declarations/quick'+suffix).send({measurementType, entries: [
        {...entries[0], ...dates}, {...entries[1], ...alternate}
      ]})).status, 400)
    }
    const invalid = isIndex ? {readingDate: '2026-02-30'} : {periodStartDate: '2026-02-04', periodEndDate: '2026-02-03'}
    t.is((await actor.post('/declarations/quick/preview').send({measurementType, ...invalid, entries})).status, 400)
    if (!isIndex) {
      const differentStarts = [{...entries[0], ...dates}, {...entries[1], ...dates, periodStartDate: '2026-01-05'}]
      t.is((await actor.post('/declarations/quick/preview').send({measurementType, entries: differentStarts})).status, 400)
    }
    t.is(await prisma.declaration.count({where: {declarantUserId: f.owner.id}}), 0)
    const legacy = {measurementType, entries: entries.map(e => ({...e, ...dates}))}
    t.is((await actor.post('/declarations/quick/conflicts').send(legacy)).status, 200)
    const preview = await actor.post('/declarations/quick/preview').send(legacy)
    t.is(preview.status, 200)
    const created = await actor.post('/declarations/quick').send({measurementType, ...dates, entries, previewToken: preview.body.data.previewToken})
    t.is(created.status, 201, JSON.stringify(created.body))
    const path = '/declarations/' + created.body.data.id + '/quick'
    const draft = (await actor.get(path)).body.data
    t.is(draft.requiresDateSelection, false)
    t.is(draft[shiftedField], dates[shiftedField])
    const rows = draft.entries.map(edits)
    const wrong = {measurementType, revision: 0, ...dates, entries: [{...rows[0], ...alternate}, rows[1]]}
    t.is((await actor.post(path+'/preview').send(wrong)).status, 400)
    t.is((await actor.patch(path).send({...wrong, previewToken: 'a'.repeat(64)})).status, 400)
    const moved = await confirmed(t, actor, path, {measurementType, revision: 0,
      entries: rows.map(e => ({...e, ...alternate}))})
    t.is(moved.data.revision, 1)
    const updated = (await actor.get(path)).body.data
    t.is(updated[shiftedField], alternate[shiftedField])
    t.true(updated.entries.every(e => e[shiftedField] === alternate[shiftedField]))
  })

  integration(measurementType + ' : un historique hétérogène reste lisible et exige une date commune explicitement choisie', async t => {
    const f = await fixture(2)
    const actor = api(f.owner)
    const {data: dossier} = await confirmed(t, actor, '/declarations/quick', {measurementType, ...dates,
      entries: f.entries.map((e,i) => ({...e, value: i+10}))}, true)
    const path = '/declarations/'+dossier.id+'/quick'
    const chunkId = dossier.source.chunks[0].id
    // Simulate a record written before the common-date rule. Misleading source metadata must not hide the two actual dates.
    const legacyPeriod = isIndex ? {periodStart: new Date('2026-01-12T00:00:00Z'), periodEnd: new Date('2026-01-12T00:15:00Z')}
      : {periodEnd: new Date('2026-01-13T00:00:00Z')}
    await prisma.chunkValue.updateMany({where: {chunkId, valueKind: 'DECLARED'}, data: legacyPeriod})
    const original = (await actor.get(path)).body.data
    t.is(original.requiresDateSelection, true)
    t.false(Object.hasOwn(original, shiftedField))
    t.deepEqual(original.entries.map(e => e[shiftedField]).sort(), ['2026-01-11','2026-01-12'])
    const rows = original.entries.map(e => ({...edits(e), value: 25}))
    const base = {measurementType, revision: 0}
    for (const rejected of [rows, [{...rows[0], ...dates}], rows.map(e => ({...e,...dates}))]) {
      t.is((await actor.post(path+'/preview').send({...base, entries: rejected})).status, 400)
    }
    if (!isIndex) t.is((await actor.post(path+'/preview').send({...base, periodStartDate: dates.periodStartDate,
      entries: rows.map(e => ({...e,...dates}))})).status, 400)
    const opposite = isIndex ? 'VOLUME' : 'INDEX'
    const convertedDates = isIndex ? {periodStartDate: '2026-02-01', periodEndDate: '2026-02-28'} : {readingDate: '2026-02-28'}
    const convert = {revision: 0, measurementType: opposite, entries: rows.map(row => ({...row,...convertedDates}))}
    t.is((await actor.post(path+'/preview').send(convert)).status, 400)
    t.is((await actor.post(path+'/preview').send({...convert,...convertedDates})).status, 200)
    t.deepEqual((await actor.get(path)).body.data.entries, original.entries)
    t.is((await actor.post(path+'/preview').send({...base,entries:[]})).status, 200)
    const aligned = await confirmed(t, actor, path, {...base, ...dates, entries: rows})
    t.is(aligned.data.revision, 1)
    const updated = (await actor.get(path)).body.data
    t.is(updated.requiresDateSelection, false)
    t.true(updated.entries.every(e => e.value === 25 && e[shiftedField] === dates[shiftedField]))
    const audit = await prisma.quickDeclarationRevision.findFirstOrThrow({where: {declarationId: dossier.id}})
    t.deepEqual(audit.before.entries.map(e => e[shiftedField]).sort(), ['2026-01-11','2026-01-12'])
    await prisma.chunkValue.updateMany({where: {chunkId, valueKind: 'DECLARED'}, data: legacyPeriod})
    await confirmed(t, actor, path, {revision: 1, measurementType, entries: []})
    t.deepEqual((await actor.get(path)).body.data.entries, [])
  })
}

integration('un droit acquis après le dépôt ou un changement de point du comptage ne rajoutent aucun emplacement', async t => {
  const {owner, collector, admin, entries: [a,b,c]} = await fixture(3)
  const delegate = api(collector)
  await prisma.declarantCollecteurExploitation.deleteMany({where: {collecteurUserId: collector.id, exploitationId: b.exploitationId}})
  const deposited = {declarantUserId: owner.id, measurementType: 'INDEX', readingDate: '2026-01-01', entries: [{...a,value: 1}]}
  const invalid = {...deposited, formExploitationIds:[a.exploitationId,b.exploitationId]}
  t.is((await delegate.post('/declarations/quick').send(invalid)).status, 403)
  t.is((await delegate.post('/declarations/quick/preview').send(invalid)).status, 403)
  const {data: dossier} = await confirmed(t, delegate, '/declarations/quick', {...deposited, formExploitationIds:[a.exploitationId,c.exploitationId]}, true)
  const path = '/declarations/'+dossier.id+'/quick'
  await prisma.declarantCollecteurExploitation.create({data: {collecteurUserId: collector.id, exploitationId: b.exploitationId}})
  const initial = (await delegate.get(path)).body.data
  t.deepEqual(initial.emptyEntries.map(e => e.exploitationId), [c.exploitationId])
  const forbiddenEntry = {measurementType: 'INDEX', readingDate: '2026-01-01', revision: 0,
    entries: [edits(initial.entries[0]), {...b, value: 2}]}
  t.is((await api(admin).post(path+'/preview').send(forbiddenEntry)).status, 403)
  t.is((await delegate.post(path+'/preview').send(forbiddenEntry)).status, 403)
  const newPoint = await prisma.pointPrelevement.create({data: {name: 'Déplacement de test '+randomUUID(), waterBodyType:'SUPERFICIELLE', flowType:'PRELEVEMENT'}})
  await prisma.declarantPointPrelevement.update({where: {id: c.exploitationId}, data: {pointPrelevementId: newPoint.id}})
  const moved = (await api(admin).get(path)).body.data
  t.deepEqual(moved.emptyEntries, [])
  t.deepEqual(moved.mapPoints.map(p => p.id), [a.pointPrelevementId])
  t.is((await api(admin).post(path+'/preview').send({...forbiddenEntry,
    entries: [edits(initial.entries[0]), {...c, pointPrelevementId: newPoint.id, value: 2}]})).status, 403)
})

integration('ancien dossier sans manifeste : seule une mesure initiale prouvée peut être rétablie', async t => {
  const {owner, entries: [a,b,c]} = await fixture(3)
  const actor = api(owner)
  const original = {measurementType: 'INDEX', readingDate: '2026-02-01', entries: [{...a,value: 1},{...b,value: 2}]}
  const {data: dossier} = await confirmed(t, actor, '/declarations/quick', original, true)
  const path = '/declarations/'+dossier.id+'/quick'
  // Existing dossiers predate the new private table; reproduce both states before and after their first correction.
  await prisma.quickDeclarationForm.delete({where: {declarationId: dossier.id}})
  const before = (await actor.get(path)).body.data
  t.deepEqual(before.emptyEntries, [])
  const kept = edits(before.entries.find(e => e.exploitationId === a.exploitationId))
  const body = {measurementType: 'INDEX', readingDate: '2026-02-01', revision: 0, entries: [kept]}
  await confirmed(t, actor, path, body)
  await prisma.quickDeclarationForm.delete({where: {declarationId: dossier.id}})
  const edited = (await actor.get(path)).body.data
  t.deepEqual(edited.emptyEntries.map(e => e.exploitationId), [b.exploitationId])
  t.is((await actor.post(path+'/preview').send({...body, revision: 1, entries: [kept,{...c,value: 2}]})).status, 403)
  await confirmed(t, actor, path, {...body, revision: 1, entries: [kept,{...b,value: 0}]})
  const restored = (await actor.get(path)).body.data
  t.deepEqual(restored.emptyEntries, [])
  t.true(restored.entries.some(e => e.exploitationId === b.exploitationId && e.value === 0))
})

integration('le formulaire peut présenter plus de 500 comptages tout en déposant une seule mesure', async t => {
  const {owner, entries: [a]} = await fixture()
  const actor = api(owner)
  await prisma.declarantPointPrelevement.update({where: {id: a.exploitationId}, data: {countingCode:'FORM-A'}})
  const extra = Array.from({length:501}, (_,i) => ({id:randomUUID(), pointPrelevementId:a.pointPrelevementId,
    declarantUserId:owner.id, usageId:a.usageId, countingCode:'FORM-'+i, status:'EN_ACTIVITE'}))
  await prisma.declarantPointPrelevement.createMany({data:extra})
  t.teardown(() => prisma.declarantPointPrelevement.deleteMany({where: {id: {in: extra.map(row => row.id)}}}))
  const formExploitationIds = [a.exploitationId, ...extra.map(e => e.id)]
  const {data: dossier} = await confirmed(t, actor, '/declarations/quick', {measurementType:'INDEX',
    readingDate:'2026-01-05', formExploitationIds, entries:[{...a,value:0}]}, true)
  const form = (await actor.get('/declarations/'+dossier.id+'/quick')).body.data
  t.is(form.entries.length, 1)
  t.is(form.emptyEntries.length, 501)
  t.is(form.mapPoints.length, 1)
  t.is(form.mapPoints[0].coordinates, null)
  t.false(Object.hasOwn(dossier.source.metadata,'formExploitationIds'))
})
