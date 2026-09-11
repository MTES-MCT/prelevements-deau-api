import test from 'ava'
import {buildCampaignEmail, campaignLocalDate, enqueueCampaignNotifications, incompleteCampaignRecipients, processCampaignNotification, scheduleCampaignReminders} from '../campaign-delivery.js'
import {prefixEmailSubject} from '../../util/email.js'

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

test('emails : texte échappé, lien authentifié et auteur de la réponse reçue', async t => {
  const result = await buildCampaignEmail({
    kind: 'RECEIPT', campaign: {id: 'campaign', name: '<script>alert(1)</script>', timezone: 'Europe/Paris'},
    submission: {id: 'receipt', version: 2, submittedAt: '2026-09-08T10:00:00Z', createdByUserId: 'collector', createdBy: {firstName: 'Agent'}, response: {kind: 'NEEDS'}}
  }, {frontUrl: 'https://example.test'})
  t.false(result.html.includes('<script>'))
  t.true(result.html.includes('https://example.test/mes-besoins/campaign'))
  t.true(result.html.includes('collector'))
  t.true(result.html.includes('version 2'))
})

function openingNotification(overrides = {}) {
  return {
    id: 'notification', kind: 'OPENING', campaignId: 'campaign', preleveurUserId: 'farmer',
    preleveur: {user: {firstName: 'Camille', lastName: 'Rivière', email: 'camille@example.test', deletedAt: null}, contactEmails: []},
    campaign: {
      id: 'campaign', name: 'Collecte annuelle 2026', status: 'OPEN', timezone: 'Europe/Paris', closesAt: new Date('2026-11-30T23:00:00Z'),
      openingMessage: 'Bonjour à toutes et à tous.\nMerci pour votre participation.',
      ownerCollecteur: {socialReason: 'Syndicat de la Vallée', user: {firstName: 'Alex'}}
    },
    ...overrides
  }
}

test('l’ouverture reprend le gabarit des autres mails, le sujet produit, le collecteur et la date limite incluse', async t => {
  const result = await buildCampaignEmail(openingNotification(), {frontUrl: 'https://example.test'})
  t.is(result.subject, 'Partageons l’Eau - Ouverture de la campagne « Collecte annuelle 2026 »')
  t.is(prefixEmailSubject(result.subject, '[TESTING] '), '[TESTING] Partageons l’Eau - Ouverture de la campagne « Collecte annuelle 2026 »')
  const html = result.html.toLowerCase()
  t.true(html.includes('<!doctype html>'))
  t.true(html.includes('#f4f4f4'))
  t.true(html.includes('#0063cb'))
  t.true(html.includes('arial'))
  t.true(result.html.includes('Bonjour Camille Rivière'))
  t.true(result.html.includes('Syndicat de la Vallée'))
  t.true(result.html.includes('30 novembre 2026 inclus'))
  t.false(result.html.includes('1 décembre 2026'))
  t.true(result.html.includes('https://example.test/mes-index/campaign'))
  t.true(result.html.includes('Répondre à la campagne'))
  t.true(result.html.includes('réponses sont à transmettre séparément'))
  t.true(result.html.includes('Bonjour à toutes et à tous.<br />Merci pour votre participation.'))
  t.false(result.html.includes('undefined'))
})

test('les champs libres sont échappés et le nom de campagne ne peut pas injecter un en-tête', async t => {
  const notification = openingNotification()
  notification.campaign.name = 'Campagne\r\nBcc: intrusion@example.test\u2028suite'
  notification.campaign.ownerCollecteur.socialReason = '<script>alert("collecteur")</script>'
  notification.campaign.openingMessage = '<mj-button href="javascript:evil()">Fraude</mj-button>\n<b>Ne pas interpréter</b>'
  notification.preleveur.user.firstName = '<img src=x onerror=alert(1)>'
  const result = await buildCampaignEmail(notification, {frontUrl: 'https://example.test/private?token=not-for-mail#fragment'})
  t.notRegex(result.subject, /[\r\n\u2028\u2029]/)
  t.true(result.subject.includes('Campagne Bcc: intrusion@example.test suite'))
  t.false(result.html.includes('<script>'))
  t.false(result.html.includes('<img src=x'))
  t.false(result.html.includes('<b>Ne pas interpréter</b>'))
  t.true(result.html.includes('&lt;script&gt;'))
  t.true(result.html.includes('&lt;b&gt;Ne pas interpréter&lt;/b&gt;'))
  t.false(result.html.includes('href="javascript:evil()"'))
  t.false(result.html.includes('not-for-mail'))
  t.false(result.html.includes('fragment'))
})

test('les rappels et confirmations de réception gardent le même style et dirigent vers le bon volet', async t => {
  const notification = openingNotification({kind: 'REMINDER', pendingKinds: ['NEEDS']})
  const reminder = await buildCampaignEmail(notification, {frontUrl: 'https://example.test'})
  t.is(reminder.subject, 'Partageons l’Eau - Rappel : votre réponse est attendue « Collecte annuelle 2026 »')
  t.true(reminder.html.includes('https://example.test/mes-besoins/campaign'))
  t.true(reminder.html.includes('Compléter mes réponses'))
  const receipt = await buildCampaignEmail(openingNotification({kind: 'RECEIPT', submission: {
    id: 'receipt', version: 2, submittedAt: '2026-09-08T10:00:00Z', createdByUserId: 'farmer', createdBy: {firstName: 'Camille'}, response: {kind: 'INDEX'}
  }}), {frontUrl: 'https://example.test'})
  t.is(receipt.subject, 'Partageons l’Eau - Accusé de réception « Collecte annuelle 2026 »')
  t.true(receipt.html.includes('https://example.test/mes-index/campaign'))
  t.true(receipt.html.includes('Consulter ma réponse'))
  t.true(receipt.html.includes('Relevés de compteurs'))
  t.true(receipt.html.includes('a bien été reçue. Vous pouvez la consulter dans votre espace.'))
  t.false(receipt.html.includes('récépissé'))
  t.false(receipt.html.includes('historique'))
  t.true(receipt.html.includes('8 septembre 2026'))
  t.true(receipt.html.includes('version 2'))
  t.false(receipt.html.includes('Merci pour votre participation'))
  t.true(reminder.html.toLowerCase().includes('#0063cb'))
  t.true(receipt.html.toLowerCase().includes('#0063cb'))
})

test('une échéance horaire après minuit ne recule pas d’une journée et aucune date n’est inventée', async t => {
  const notification = openingNotification()
  notification.campaign.closesAt = '2026-09-30T22:00:10Z'
  const timed = await buildCampaignEmail(notification, {frontUrl: 'https://example.test'})
  t.true(timed.html.includes('1 octobre 2026'))
  t.false(timed.html.includes('30 septembre 2026 inclus'))
  notification.campaign.closesAt = null
  const withoutDeadline = await buildCampaignEmail(notification, {frontUrl: 'https://example.test'})
  t.true(withoutDeadline.html.includes('Aucune date limite définie'))
})

// Vérifie explicitement le refus d’un protocole exécutable.
for (const frontUrl of ['javascript:alert(1)', 'data:text/html,hello', 'ftp://example.test', 'https://user:secret@example.test']) {
  test(`les emails refusent une URL de site dangereuse : ${new URL(frontUrl).protocol}`, async t => {
    await t.throwsAsync(() => buildCampaignEmail(openingNotification(), {frontUrl}), {message: 'URL du site invalide.'})
  })
}

function notificationClient(notification, {targets = [{preleveurUserId: 'farmer'}], responses = [], claimed = true} = {}) {
  const writes = []
  const queries = {}
  const client = {
    campaignNotification: {
      async updateMany(query) {
        queries.claim = query
        return {count: claimed ? 1 : 0}
      },
      async findUnique(query) {
        queries.notification = query
        return notification
      },
      async update(query) {
        writes.push(query)
      }
    },
    campaignTarget: {async findMany(query) {
      queries.targets = query
      return targets
    }},
    campaignResponse: {async findMany(query) {
      queries.responses = query
      return responses
    }}
  }
  return {client, queries, writes}
}

test('le worker envoie le mail standard au contact principal puis confirme son envoi dans l’outbox', async t => {
  const notification = openingNotification()
  notification.preleveur.contactEmails = [{email: 'contact@example.test', isPrimary: true}]
  const {client, queries, writes} = notificationClient(notification)
  const deliveries = []
  const now = new Date('2026-09-10T09:00:00Z')
  const result = await processCampaignNotification(notification.id, {client, now, frontUrl: 'https://example.test', async mailer(...args) {
    deliveries.push(args)
    t.is(writes.length, 0)
  }})
  t.deepEqual(result, {sent: true})
  t.is(deliveries.length, 1)
  t.is(deliveries[0][0], 'contact@example.test')
  t.true(deliveries[0][1].startsWith('Partageons l’Eau - '))
  t.true(deliveries[0][2].includes('Syndicat de la Vallée'))
  t.true(deliveries[0][2].includes('https://example.test/mes-index/campaign'))
  t.deepEqual(queries.notification.include.campaign.include.ownerCollecteur.select, {socialReason: true, user: {select: {firstName: true, lastName: true}}})
  t.deepEqual(queries.claim.data.attempts, {increment: 1})
  t.deepEqual(writes[0].data, {status: 'SENT', sentAt: now, leaseUntil: null, error: null})
})

test('le worker dirige un rappel vers les besoins lorsque les relevés ont déjà été transmis', async t => {
  const {client, queries} = notificationClient(openingNotification({kind: 'REMINDER'}), {responses: [{preleveurUserId: 'farmer', kind: 'INDEX', latestSubmissionId: 'index'}]})
  const deliveries = []
  t.deepEqual(await processCampaignNotification('notification', {client, now: new Date('2026-09-10'), frontUrl: 'https://example.test', async mailer(...args) {
    deliveries.push(args)
  }}), {sent: true})
  t.true(deliveries[0][2].includes('https://example.test/mes-besoins/campaign'))
  t.deepEqual(queries.responses.where, {campaignId: 'campaign', preleveurUserId: 'farmer'})
})

for (const kind of ['OPENING', 'REMINDER']) {
  test(`une notification ${kind} anticipée est différée sans consommer de tentative SMTP`, async t => {
    const notification = openingNotification({kind})
    const opensAt = new Date('2026-09-15T09:00:00Z')
    notification.campaign.opensAt = opensAt
    const {client, writes} = notificationClient(notification)
    const deliveries = []
    const mailer = async (...args) => {
      deliveries.push(args)
    }

    const result = await processCampaignNotification('notification', {client, now: new Date('2026-09-10T09:00:00Z'), frontUrl: 'https://example.test', mailer})
    t.deepEqual(result, {deferred: true})
    t.deepEqual(deliveries, [])
    t.deepEqual(writes[0].data, {status: 'PENDING', attempts: {decrement: 1}, leaseUntil: opensAt, error: null})
    t.deepEqual(await processCampaignNotification('notification', {client, now: opensAt, frontUrl: 'https://example.test', mailer}), {sent: true})
    t.is(deliveries.length, 1)
  })
}

test('un échec SMTP à l’ouverture conserve l’invitation pour reprise sans revenir sur la campagne', async t => {
  const {client, writes} = notificationClient(openingNotification())
  const result = await processCampaignNotification('notification', {client, now: new Date('2026-09-10'), frontUrl: 'https://example.test', async mailer() {
    throw new Error('Détail SMTP confidentiel')
  }})
  t.deepEqual(result, {failed: true})
  t.is(writes[0].data.status, 'FAILED')
  t.is(writes[0].data.error, 'ECHEC_ENVOI')
  t.false(JSON.stringify(writes).includes('confidentiel'))
})

for (const reason of ['DELETED', 'OPTED_OUT', 'CLOSED', 'OUT_OF_SCOPE', 'ALREADY_ANSWERED', 'ALREADY_CLAIMED']) {
  test(`le worker ne sollicite pas le SMTP pour une notification non éligible : ${reason}`, async t => {
    const notification = openingNotification({kind: 'REMINDER'})
    notification.preleveur.user.deletedAt = reason === 'DELETED' ? new Date() : null
    notification.preleveur.declarationNotificationsEnabled = reason !== 'OPTED_OUT'
    notification.campaign.status = reason === 'CLOSED' ? 'CLOSED' : 'OPEN'
    const {client, writes} = notificationClient(notification, {
      targets: reason === 'OUT_OF_SCOPE' ? [] : [{preleveurUserId: 'farmer'}],
      responses: reason === 'ALREADY_ANSWERED' ? ['INDEX', 'NEEDS'].map(kind => ({preleveurUserId: 'farmer', kind, latestSubmissionId: kind})) : [],
      claimed: reason !== 'ALREADY_CLAIMED'
    })
    const result = await processCampaignNotification('notification', {client, now: new Date('2026-09-10'), frontUrl: 'https://example.test', async mailer() {
      t.fail('Aucun email ne doit être envoyé.')
    }})
    t.deepEqual(result, reason === 'ALREADY_CLAIMED' ? {claimed: false} : {skipped: true})
    t.is(writes.length, reason === 'ALREADY_CLAIMED' ? 0 : 1)
  })
}

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
  const keys = new Set()
  const client = {
    campaign: {async findMany() {
      return [{id: 'campaign', timezone: 'Europe/Paris', reminderDays: [14, 3], closesAt: new Date('2026-09-22T21:59:00Z'), targets: [{preleveurUserId: 'farmer'}], responses: []}]
    }},
    campaignNotification: {async createMany(query) {
      enqueued = query
      const pending = query.data.filter(item => !keys.has(item.dedupeKey))
      for (const item of pending) {
        keys.add(item.dedupeKey)
      }

      return {count: pending.length}
    }}
  }
  t.deepEqual(await scheduleCampaignReminders({client, now: new Date('2026-09-08T07:00:00Z')}), {queuedCount: 1})
  t.is(enqueued.data[0].preleveurUserId, 'farmer')
  t.deepEqual(await scheduleCampaignReminders({client, now: new Date('2026-09-08T08:00:00Z')}), {queuedCount: 0})
})

test('la relance du jour est rattrapée après une ouverture tardive, sans doublon ni envoi avant 9 h', async t => {
  const campaign = {id: 'campaign', timezone: 'Europe/Paris', reminderDays: [7], opensAt: new Date('2026-09-10T10:00:00Z'), closesAt: new Date('2026-09-17T22:00:00Z'), targets: [{preleveurUserId: 'farmer'}, {preleveurUserId: 'complete'}], responses: [
    {preleveurUserId: 'complete', kind: 'INDEX', latestSubmissionId: 'index'},
    {preleveurUserId: 'complete', kind: 'NEEDS', latestSubmissionId: 'needs'}
  ]}
  const notifications = new Map()
  const client = {
    campaign: {async findMany(query) {
      t.is(query.where.status, 'OPEN')
      return [campaign]
    }},
    campaignNotification: {async createMany({data, skipDuplicates}) {
      t.true(skipDuplicates)
      const pending = data.filter(item => !notifications.has(item.dedupeKey))
      for (const item of pending) {
        notifications.set(item.dedupeKey, item)
      }

      return {count: pending.length}
    }}
  }
  t.deepEqual(await scheduleCampaignReminders({client, now: new Date('2026-09-10T07:00:00Z')}), {queuedCount: 0})
  t.deepEqual(await scheduleCampaignReminders({client, now: new Date('2026-09-10T10:00:00Z')}), {queuedCount: 1})
  t.deepEqual(await scheduleCampaignReminders({client, now: new Date('2026-09-10T15:00:00Z')}), {queuedCount: 0})
  t.deepEqual([...notifications.keys()], ['campaign:REMINDER:farmer:2026-09-10'])
  t.deepEqual(await scheduleCampaignReminders({client, now: new Date('2026-09-11T10:00:00Z')}), {queuedCount: 0})

  notifications.clear()
  campaign.opensAt = new Date('2026-09-09T22:00:00Z')
  t.deepEqual(await scheduleCampaignReminders({client, now: new Date('2026-09-10T06:59:00Z')}), {queuedCount: 0})
  // Premier passage du worker après une interruption pendant le créneau de 9 h.
  t.deepEqual(await scheduleCampaignReminders({client, now: new Date('2026-09-10T16:00:00Z')}), {queuedCount: 1})
})

test('une clôture à minuit compte les relances depuis le dernier jour de réponse, même au changement d’heure', async t => {
  const campaign = {id: 'campaign', timezone: 'Europe/Paris', reminderDays: [14, 0], opensAt: new Date('2026-10-01T00:00:00Z'), closesAt: new Date('2026-11-01T23:00:00Z'), targets: [{preleveurUserId: 'farmer'}], responses: []}
  const client = {
    campaign: {async findMany() {
      return [campaign]
    }},
    campaignNotification: {async createMany(query) {
      return {count: query.data.length}
    }}
  }
  t.deepEqual(await scheduleCampaignReminders({client, now: new Date('2026-10-18T07:00:00Z')}), {queuedCount: 1})
  t.deepEqual(await scheduleCampaignReminders({client, now: new Date('2026-10-19T07:00:00Z')}), {queuedCount: 0})
  t.deepEqual(await scheduleCampaignReminders({client, now: new Date('2026-11-01T08:00:00Z')}), {queuedCount: 1})
  campaign.opensAt = new Date('2026-10-18T10:00:00Z')
  t.deepEqual(await scheduleCampaignReminders({client, now: new Date('2026-10-18T07:00:00Z')}), {queuedCount: 0})
})
