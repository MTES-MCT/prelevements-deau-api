import test from 'ava'
import ExcelJS from 'exceljs'
import {processCampaignExport} from '../campaign-delivery.js'

function exportTarget(id, {preleveurUserId = 'farmer', zoneId = 'zone', meters = []} = {}) {
  return {
    id, campaignId: 'campaign', pointPrelevementId: `point-${id}`, exploitationId: `exploitation-${id}`, preleveurUserId,
    pointPrelevement: {name: `Référence ${id}`, usageName: `Forage ${id}`, flowType: 'PRELEVEMENT', collectionMode: 'MANUAL', zones: [{zoneId}]},
    exploitation: {usageId: 'usage', usage: {label: 'Irrigation'}, collecteurs: [], status: 'EN_ACTIVITE'},
    preleveur: {socialReason: `Exploitation ${preleveurUserId}`, user: {firstName: 'Alex', lastName: 'Martin'}},
    meters
  }
}

function exportResponse(preleveurUserId, kind, snapshot = {}) {
  return {
    id: `response-${preleveurUserId}-${kind}`, preleveurUserId, kind, status: 'SUBMITTED',
    draft: {comment: 'BROUILLON CONFIDENTIEL'},
    latestSubmissionId: `submission-${preleveurUserId}-${kind}`,
    latestSubmission: {
      id: `submission-${preleveurUserId}-${kind}`, createdByUserId: 'author-uuid', version: 1,
      submittedAt: new Date('2026-09-10T10:00:00Z'), snapshot, publication: {totals: []}
    }
  }
}

function exportClient({
  targets = [exportTarget('first')], responses = [], selectedTargetIds = targets.map(target => target.id),
  user = {id: 'admin', role: 'ADMIN'}, authors = [], claimed = true,
  permissionZones = {}, authorError
} = {}) {
  const queries = {campaign: [], responses: [], authors: [], rights: []}
  const writes = []
  const uploads = []
  const client = {
    campaignExport: {
      async updateMany(query) {
        queries.claim = query
        return {count: claimed ? 1 : 0}
      },
      async findUnique(query) {
        queries.export = query
        return {id: 'export', campaignId: 'campaign', targetIds: selectedTargetIds, createdBy: user}
      },
      async update(query) {
        writes.push(query)
      }
    },
    campaign: {async findUnique(query) {
      queries.campaign.push(query)
      return {
        id: 'campaign', name: 'Campagne 2026', status: 'OPEN', ownerCollecteurUserId: 'owner', zoneId: 'zone',
        managers: [], targets, indexDates: ['2026-01-01', '2026-07-01'], timezone: 'Europe/Paris',
        periods: [{id: 'needs-period', kind: 'NEEDS', label: 'Besoins annuels', startDate: new Date('2027-01-01'), endDate: new Date('2028-01-01')}]
      }
    }},
    campaignResponse: {async findMany(query) {
      queries.responses.push(query)
      return responses.filter(response => query.where.preleveurUserId.in.includes(response.preleveurUserId))
    }},
    campaignSubmission: {async findMany(query) {
      queries.authors.push(query)
      if (authorError) {
        throw authorError
      }

      return authors.filter(author => query.where.id.in.includes(author.id))
    }},
    instructorZone: {async findMany(query) {
      queries.rights.push(query)
      return (permissionZones[query.where.permissions.some.permission] ?? []).map(zoneId => ({zoneId}))
    }}
  }
  const storageFactory = bucket => ({async uploadObject(...args) {
    uploads.push({bucket, args})
  }})
  return {client, queries, writes, uploads, storageFactory}
}

async function exportedText(uploads) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(uploads[0].args[1])
  return JSON.stringify(workbook.worksheets.map(sheet => sheet.getSheetValues()))
}

test('export worker : une seule lecture groupée des auteurs, noms des points et compteurs historiques déjà chargés', async t => {
  const meters = ['Ancien-001', 'Nouveau-002'].map((serialNumber, index) => ({
    id: `binding-${index}`, compteurId: `meter-${index}`, compteur: {id: `meter-${index}`, serialNumber, deletedAt: index === 0 ? new Date() : null}
  }))
  const targets = [exportTarget('first', {meters}), exportTarget('second', {preleveurUserId: 'other'})]
  const responses = [
    exportResponse('farmer', 'INDEX', {
      readings: [{targetId: 'first', compteurId: 'meter-0', readingDate: '2026-01-01', value: '123.4567'}],
      meterEvents: [{
        targetId: 'first', type: 'REPLACEMENT', at: '2026-03-01', previousCompteurId: 'meter-0', nextCompteurId: 'meter-1',
        previousIndex: '200', nextIndex: '0', reason: 'Remplacement prévu'
      }]
    }),
    exportResponse('other', 'NEEDS', {needs: [{targetId: 'second', periodId: 'needs-period', requestedVolume: '500.0001'}]})
  ]
  const before = structuredClone({targets, responses})
  const context = exportClient({targets, responses, authors: [
    {id: responses[0].latestSubmissionId, createdBy: {firstName: 'Camille', lastName: 'Rivière', declarant: null}},
    {id: responses[1].latestSubmissionId, createdBy: {firstName: null, lastName: null, declarant: {socialReason: 'Syndicat du Canal'}}}
  ]})
  t.deepEqual(await processCampaignExport('export', context), {completed: true})
  t.is(context.queries.authors.length, 1)
  t.deepEqual(context.queries.authors[0], {
    where: {id: {in: responses.map(response => response.latestSubmissionId)}, response: {campaignId: 'campaign', preleveurUserId: {in: ['farmer', 'other']}}},
    select: {id: true, createdBy: {select: {firstName: true, lastName: true, declarant: {select: {socialReason: true}}}}}
  })
  const text = await exportedText(context.uploads)
  for (const expected of ['Camille Rivière', 'Syndicat du Canal', 'Forage first', 'Référence first', 'Exploitation farmer', 'Irrigation', 'Ancien-001', 'Nouveau-002', '500.0001']) {
    t.true(text.includes(expected), `Valeur lisible attendue : ${expected}`)
  }

  t.false(text.includes('BROUILLON CONFIDENTIEL'))
  t.false(text.includes('author-uuid'))
  t.is(context.uploads[0].bucket, 'exports')
  t.is(context.uploads[0].args[0], 'campaigns/campaign/export.xlsx')
  t.is(context.writes[0].data.status, 'COMPLETED')
  t.deepEqual({targets, responses}, before)
})

test('export worker : le sous-périmètre filtre les données, commentaires et auteurs avant tout enrichissement', async t => {
  const targets = [exportTarget('first'), exportTarget('hidden'), exportTarget('outside', {preleveurUserId: 'outside'})]
  const responses = [
    exportResponse('farmer', 'NEEDS', {comment: 'COMMENTAIRE GLOBAL CONFIDENTIEL', needs: [
      {targetId: 'first', periodId: 'needs-period', requestedVolume: '300'},
      {targetId: 'hidden', periodId: 'needs-period', requestedVolume: '999.9999'}
    ]}),
    exportResponse('outside', 'NEEDS', {comment: 'AUTRE PRÉLEVEUR CONFIDENTIEL'})
  ]
  const context = exportClient({targets, responses, selectedTargetIds: ['first'], authors: [
    {id: responses[0].latestSubmissionId, createdBy: {firstName: 'Camille', lastName: 'Rivière'}},
    {id: responses[1].latestSubmissionId, createdBy: {firstName: 'AUTEUR HORS PÉRIMÈTRE'}}
  ]})
  t.deepEqual(await processCampaignExport('export', context), {completed: true})
  t.deepEqual(context.queries.authors[0].where, {
    id: {in: [responses[0].latestSubmissionId]}, response: {campaignId: 'campaign', preleveurUserId: {in: ['farmer']}}
  })
  const text = await exportedText(context.uploads)
  t.true(text.includes('Camille Rivière'))
  t.true(text.includes('Forage first'))
  for (const forbidden of ['CONFIDENTIEL', 'HORS PÉRIMÈTRE', 'Forage hidden', 'Forage outside', '999.9999']) {
    t.false(text.includes(forbidden), `Valeur interdite : ${forbidden}`)
  }
})

test('export worker : aucun chargement d’auteur ni de compteur pour un brouillon jamais transmis', async t => {
  const response = {preleveurUserId: 'farmer', kind: 'INDEX', status: 'DRAFT', draft: {readings: [{targetId: 'first', compteurId: 'PRIVATE-METER', value: '919191.9999'}]}, latestSubmission: null}
  const context = exportClient({responses: [response]})
  t.deepEqual(await processCampaignExport('export', context), {completed: true})
  t.deepEqual(context.queries.authors, [])
  const text = await exportedText(context.uploads)
  t.false(text.includes('PRIVATE-METER'))
  t.false(text.includes('919191.9999'))
})

for (const scenario of ['export périmé', 'droit export retiré', 'compte désactivé', 'déjà pris en charge']) {
  test(`export worker : pas de métadonnées ni de fichier si ${scenario}`, async t => {
    const targets = [exportTarget('first', {zoneId: 'allowed'}), exportTarget('second', {zoneId: 'readonly'})]
    const context = exportClient({
      targets, responses: [exportResponse('farmer', 'NEEDS')],
      selectedTargetIds: scenario === 'export périmé' ? ['second'] : ['first'],
      user: {id: 'agent', role: 'INSTRUCTOR', deletedAt: scenario === 'compte désactivé' ? new Date() : null},
      claimed: scenario !== 'déjà pris en charge',
      permissionZones: {'campaign.read': ['allowed', 'readonly'], 'campaign.export': scenario === 'droit export retiré' ? [] : ['allowed']}
    })
    t.deepEqual(await processCampaignExport('export', context), scenario === 'déjà pris en charge' ? {claimed: false} : {failed: true})
    t.deepEqual(context.queries.authors, [])
    t.deepEqual(context.uploads, [])
    if (['compte désactivé', 'déjà pris en charge'].includes(scenario)) {
      t.deepEqual(context.queries.campaign, [])
      t.deepEqual(context.queries.responses, [])
    }

    t.is(context.writes.length, scenario === 'déjà pris en charge' ? 0 : 1)
  })
}

test('export worker : un agent lit les métadonnées uniquement dans son périmètre exportable', async t => {
  const targets = [exportTarget('first', {zoneId: 'allowed'}), exportTarget('outside', {preleveurUserId: 'outside', zoneId: 'outside'})]
  const responses = [exportResponse('farmer', 'NEEDS'), exportResponse('outside', 'NEEDS')]
  const context = exportClient({
    targets, responses, selectedTargetIds: ['first'], user: {id: 'agent', role: 'INSTRUCTOR'},
    permissionZones: {'campaign.read': ['allowed'], 'campaign.export': ['allowed']},
    authors: [{id: responses[0].latestSubmissionId, createdBy: {firstName: 'Camille', lastName: 'Rivière'}}]
  })
  t.deepEqual(await processCampaignExport('export', context), {completed: true})
  t.deepEqual(context.queries.responses[0].where.preleveurUserId.in, ['farmer'])
  t.deepEqual(context.queries.authors[0].where.id.in, [responses[0].latestSubmissionId])
  const text = await exportedText(context.uploads)
  t.false(text.includes('Exploitation outside'))
})

test('export worker : un échec de lecture des noms reste générique et ne publie aucun fichier incomplet', async t => {
  const context = exportClient({responses: [exportResponse('farmer', 'INDEX')], authorError: new Error('DÉTAIL CONFIDENTIEL SQL')})
  t.deepEqual(await processCampaignExport('export', context), {failed: true})
  t.deepEqual(context.uploads, [])
  t.deepEqual(context.writes[0].data, {status: 'FAILED', leaseUntil: null, error: 'ECHEC_EXPORT_OU_DROITS_MODIFIES'})
  t.false(JSON.stringify(context.writes).includes('CONFIDENTIEL'))
})
