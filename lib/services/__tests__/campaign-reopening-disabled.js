import test from 'ava'
import {reopenCampaignResponse} from '../campaigns.js'
import {getCampaignResponseScope} from '../campaign-permissions.js'

const farmer = {id: 'farmer', role: 'DECLARANT'}
const collector = {id: 'collector', role: 'DECLARANT'}
const admin = {id: 'admin', role: 'ADMIN'}
const instructor = {id: 'instructor', role: 'INSTRUCTOR'}

function accessFixture(status = 'OPEN') {
  const targets = [{
    id: 'target', preleveurUserId: farmer.id, pointPrelevement: {collectionMode: 'MANUAL'},
    exploitation: {status: 'EN_ACTIVITE', collecteurs: [{collecteurUserId: collector.id}]}
  }]
  return {
    campaign: {status, indexDates: []}, targets,
    permissions: {canManage: true}, responseTargetCounts: new Map([[farmer.id, 1]])
  }
}

for (const user of [farmer, collector, admin, instructor]) {
  for (const kind of ['INDEX', 'NEEDS']) {
    test(`la réouverture ${kind} est retirée pour ${user.id}, sans aucune lecture ni écriture`, async t => {
      const accesses = []
      const client = new Proxy({}, {get(_object, key) {
        accesses.push(key)
        throw new Error('Aucun accès aux données n’est permis.')
      }})
      const error = await t.throwsAsync(reopenCampaignResponse(user, 'campaign', kind, {
        preleveurUserId: farmer.id, expectedVersion: 0, reason: 'Ancienne commande', reopenUntil: new Date('2030-01-01')
      }, {client}))
      t.is(error.statusCode, 410)
      t.is(error.message, 'La réouverture manuelle des réponses n’est plus disponible.')
      t.deepEqual(accesses, [])
    })
  }
}

for (const status of ['DRAFT', 'OPEN', 'CLOSED']) {
  test(`aucun rôle ne reçoit canReopen dans une campagne ${status}, même avec gestion et périmètre complet`, t => {
    const access = accessFixture(status)
    for (const user of [farmer, collector, admin, instructor]) {
      const scope = getCampaignResponseScope(access, user, farmer.id)
      t.true(scope.complete)
      t.true(scope.permissions.canManage)
      t.false(scope.permissions.canReopen)
    }
  })
}

test('la correction ordinaire d’une réponse transmise reste autorisée pendant la saisie ouverte', t => {
  const access = accessFixture()
  const response = {status: 'SUBMITTED', latestSubmissionId: 'official', draft: {comment: 'Conservé'}}
  for (const user of [farmer, collector]) {
    const {permissions} = getCampaignResponseScope(access, user, farmer.id, response)
    t.true(permissions.canEdit)
    t.true(permissions.canSubmit)
    t.false(permissions.canReopen)
  }

  t.deepEqual(response, {status: 'SUBMITTED', latestSubmissionId: 'official', draft: {comment: 'Conservé'}})
})

test('une ancienne fenêtre de réouverture reste utilisable sans créer de nouvelle réouverture ni toucher à son historique', t => {
  const access = accessFixture('CLOSED')
  const response = {
    status: 'DRAFT', latestSubmissionId: 'official', reopenUntil: new Date(Date.now() + 86_400_000),
    reopenedAt: '2026-09-01T09:00:00Z', reopenedByUserId: admin.id, reopenReason: 'Motif historique',
    draft: {comment: 'Brouillon conservé'}, latestSubmission: {snapshot: {comment: 'Transmission conservée'}}
  }
  const initial = structuredClone(response)
  const {permissions} = getCampaignResponseScope(access, farmer, farmer.id, response)
  t.true(permissions.canEdit)
  t.true(permissions.canSubmit)
  t.false(permissions.canReopen)
  t.deepEqual(response, initial)
})

test('sans ancienne fenêtre valide, une campagne clôturée reste non modifiable', t => {
  const access = accessFixture('CLOSED')
  for (const reopenUntil of [null, new Date(Date.now() - 86_400_000)]) {
    const {permissions} = getCampaignResponseScope(access, farmer, farmer.id, {status: 'DRAFT', reopenUntil})
    t.false(permissions.canEdit)
    t.false(permissions.canSubmit)
    t.false(permissions.canReopen)
  }
})
