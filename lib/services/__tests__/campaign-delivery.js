import test from 'ava'
import {buildCampaignEmail, campaignLocalDate, enqueueCampaignNotifications, incompleteCampaignRecipients, processCampaignNotification, scheduleCampaignReminders} from '../campaign-delivery.js'

test('les relances distinguent les deux volets et gardent la dernière transmission pendant une correction', t => {
  const targets = [{preleveurUserId: 'complete'}, {preleveurUserId: 'missing'}, {preleveurUserId: 'missing'}]
  const responses = [
    {preleveurUserId: 'complete', kind: 'INDEX', latestSubmissionId: 'i', status: 'DRAFT'},
    {preleveurUserId: 'complete', kind: 'NEEDS', latestSubmissionId: 'n'},
    {preleveurUserId: 'missing', kind: 'INDEX', latestSubmissionId: 'i2'}
  ]
  t.deepEqual(incompleteCampaignRecipients(targets, responses), ['missing'])
  t.is(campaignLocalDate(new Date('2026-09-08T22:30:00Z')), '2026-09-09')
})

test('outbox : dédoublonnage par transmission ou journée locale, sans envoyer de mail', async t => {
  const writes = []
  const client = {campaignNotification: {async createMany(query) {
    writes.push(query)
    return {count: query.data.length}
  }}}
  const campaign = {id: 'campaign', timezone: 'Europe/Paris'}
  await enqueueCampaignNotifications(client, {campaign, kind: 'RECEIPT', submission: {id: 'submission'}, preleveurUserIds: ['farmer', 'farmer']})
  await enqueueCampaignNotifications(client, {campaign, kind: 'REMINDER', now: new Date('2026-09-08T22:30:00Z'), preleveurUserIds: ['farmer']})
  t.true(writes[0].skipDuplicates)
  t.is(writes[0].data.length, 1)
  t.is(writes[0].data[0].dedupeKey, 'campaign:RECEIPT:farmer:submission')
  t.is(writes[1].data[0].dedupeKey, 'campaign:REMINDER:farmer:2026-09-09')
})

test('emails : texte échappé, lien authentifié et auteur du récépissé', t => {
  const result = buildCampaignEmail({
    kind: 'RECEIPT', campaign: {id: 'campaign', name: '<script>alert(1)</script>', timezone: 'Europe/Paris'},
    submission: {id: 'receipt', version: 2, submittedAt: '2026-09-08T10:00:00Z', createdByUserId: 'collector', createdBy: {firstName: 'Agent'}, response: {kind: 'NEEDS'}}
  }, {frontUrl: 'https://example.test'})
  t.false(result.html.includes('<script>'))
  t.true(result.html.includes('https://example.test/mes-besoins/campaign'))
  t.true(result.html.includes('collector'))
  t.true(result.html.includes('version 2'))
})

test('échec SMTP : notification conservée pour reprise sans toucher à la transmission', async t => {
  const updates = []
  const client = {campaignNotification: {
    async updateMany() {
      return {count: 1}
    },
    async findUnique() {
      return {
        kind: 'RECEIPT', campaign: {id: 'campaign', name: 'Test', timezone: 'Europe/Paris'},
        preleveur: {user: {email: 'farmer@example.test', deletedAt: null}, contactEmails: []},
        submission: {id: 'receipt', version: 1, submittedAt: '2026-09-08T10:00:00Z', createdByUserId: 'farmer', response: {kind: 'INDEX'}}
      }
    },
    async update(query) {
      updates.push(query)
    }
  }}
  const result = await processCampaignNotification('notification', {client, frontUrl: 'https://example.test', async mailer() {
    throw new Error('secret SMTP detail')
  }})
  t.deepEqual(result, {failed: true})
  t.is(updates[0].data.status, 'FAILED')
  t.is(updates[0].data.error, 'ECHEC_ENVOI')
  t.false(JSON.stringify(updates).includes('secret SMTP'))
})

test('relance planifiée à J-14 dans le fuseau de la campagne, uniquement les réponses manquantes', async t => {
  let enqueued
  const client = {
    campaign: {async findMany() {
      return [{id: 'campaign', timezone: 'Europe/Paris', reminderDays: [14, 3], closesAt: new Date('2026-09-22T21:59:00Z'), targets: [{preleveurUserId: 'farmer'}], responses: []}]
    }},
    campaignNotification: {async createMany(query) {
      enqueued = query
      return {count: query.data.length}
    }}
  }
  t.deepEqual(await scheduleCampaignReminders({client, now: new Date('2026-09-08T07:00:00Z')}), {queuedCount: 1})
  t.is(enqueued.data[0].preleveurUserId, 'farmer')
  t.deepEqual(await scheduleCampaignReminders({client, now: new Date('2026-09-08T08:00:00Z')}), {queuedCount: 0})
})
