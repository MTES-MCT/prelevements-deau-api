import test from 'ava'
import {assertCampaignOpeningTargets, mergeCampaignDraft, normalizePublishedCampaignDraft, serializeCampaign, getCampaignResponseHistory} from '../campaigns.js'

function openingFixture() {
  const campaign = {ownerCollecteurUserId: 'owner', indexDates: ['2025-10-31', '2026-06-01', '2026-10-31']}
  const targets = [{id: 'target', pointPrelevementId: 'point', eligibilityConfirmed: true,
    pointPrelevement: {collectionMode: 'MANUAL'},
    exploitation: {status: 'EN_ACTIVITE', collecteurs: [{collecteurUserId: 'owner'}]}}]
  const bindings = [{id: 'binding', pointPrelevementId: 'point', compteurId: 'meter', compteur: {deletedAt: null}, startDate: null, endDate: null}]
  return {campaign, targets, bindings}
}

test('ouverture : aucun compteur arbitraire ni réglage préalable, les points externes restent interdits', t => {
  const {campaign, targets, bindings} = openingFixture()
  t.notThrows(() => assertCampaignOpeningTargets(campaign, targets, bindings))
  t.notThrows(() => assertCampaignOpeningTargets(campaign, targets, []))
  targets[0].pointPrelevement.collectionMode = null
  t.notThrows(() => assertCampaignOpeningTargets(campaign, targets, bindings))
  t.notThrows(() => assertCampaignOpeningTargets(campaign, targets, []))
  targets[0].pointPrelevement.collectionMode = 'EXTERNAL'
  t.is(t.throws(() => assertCampaignOpeningTargets(campaign, targets, bindings)).statusCode, 409)
  targets[0].pointPrelevement.collectionMode = null
  targets[0].eligibilityConfirmed = false
  t.is(t.throws(() => assertCampaignOpeningTargets(campaign, targets, bindings)).statusCode, 409)
})

test('sans mode renseigné, archivage et délégation restent contrôlés avant ouverture', t => {
  const {campaign, targets} = openingFixture()
  const target = targets[0]
  target.pointPrelevement.collectionMode = null
  target.pointPrelevement.deletedAt = new Date()
  t.is(t.throws(() => assertCampaignOpeningTargets(campaign, targets, [])).statusCode, 409)
  target.pointPrelevement.deletedAt = null
  target.exploitation.collecteurs = []
  t.is(t.throws(() => assertCampaignOpeningTargets(campaign, targets, [])).statusCode, 409)
  target.exploitation.collecteurs = [{collecteurUserId: campaign.ownerCollecteurUserId}]
  target.preleveur = {user: {deletedAt: new Date()}}
  t.is(t.throws(() => assertCampaignOpeningTargets(campaign, targets, [])).statusCode, 409)
})

test('ouverture : le mandat et les périodes d’exploitation sont revérifiés', t => {
  const {campaign, targets, bindings} = openingFixture()
  targets[0].exploitation.collecteurs = []
  t.is(t.throws(() => assertCampaignOpeningTargets(campaign, targets, bindings)).statusCode, 409)
  targets[0].exploitation.collecteurs = [{collecteurUserId: 'owner'}]
  targets[0].exploitation.endDate = '2026-06-01'
  t.is(t.throws(() => assertCampaignOpeningTargets(campaign, targets, bindings)).statusCode, 409)
})

test('ouverture : un compteur partagé entre deux points sur une même période est refusé', t => {
  const {campaign, targets, bindings} = openingFixture()
  bindings.push({...bindings[0], id: 'other-binding', pointPrelevementId: 'other-point'})
  t.is(t.throws(() => assertCampaignOpeningTargets(campaign, targets, bindings)).statusCode, 409)
  bindings[1].endDate = '2025-01-01'
  bindings[0].startDate = '2025-01-02'
  t.notThrows(() => assertCampaignOpeningTargets(campaign, targets, bindings))
})

test('ouverture : une affectation incomplète ne peut produire un faux index', t => {
  const {campaign, targets, bindings} = openingFixture()
  bindings[0].startDate = '2026-01-01'
  t.is(t.throws(() => assertCampaignOpeningTargets(campaign, targets, bindings)).statusCode, 409)
  bindings[0].startDate = '2027-01-01'
  t.is(t.throws(() => assertCampaignOpeningTargets(campaign, targets, bindings)).statusCode, 409)
})

test('la fusion d’un brouillon partiel conserve les données et le commentaire hors mandat', t => {
  const current = {comment: 'Commentaire du préleveur', needs: [{targetId: 'own', requestedVolume: '1'}, {targetId: 'other', requestedVolume: '2'}]}
  const input = {comment: 'Ne pas remplacer', needs: [{targetId: 'own', requestedVolume: '3'}]}
  t.deepEqual(mergeCampaignDraft(current, input, ['own'], false), {comment: current.comment, needs: [{targetId: 'other', requestedVolume: '2'}, {targetId: 'own', requestedVolume: '3'}]})
  t.deepEqual(current.needs[0], {targetId: 'own', requestedVolume: '1'})
  t.deepEqual(mergeCampaignDraft(current, input, ['own', 'other'], true), input)
})

test('après transmission, le prochain brouillon réutilise les lignes canoniques sans modifier le snapshot', t => {
  const reading = {targetId: 'target', compteurId: 'meter', readingDate: '2026-06-01', value: '250', correctionOfChunkValueId: 'previous-value', correctionReason: 'Coquille'}
  const snapshot = {comment: 'Correction', readings: [reading]}
  const publication = {readingReferences: [{targetId: 'target', compteurId: 'meter', readingDate: '2026-06-01', chunkValueId: 'canonical-value', sourceValueUpdatedAt: '2026-09-08T12:00:00.000Z'}]}
  const draft = normalizePublishedCampaignDraft(snapshot, publication)
  t.is(draft.readings[0].sourceChunkValueId, 'canonical-value')
  t.is(draft.readings[0].sourceValueUpdatedAt, '2026-09-08T12:00:00.000Z')
  t.false(Object.hasOwn(draft.readings[0], 'correctionOfChunkValueId'))
  t.false(Object.hasOwn(draft.readings[0], 'correctionReason'))
  t.is(snapshot.readings[0].correctionOfChunkValueId, 'previous-value')
})

test('la sérialisation publique n’expose pas les relations internes des exploitations', t => {
  const {campaign, targets} = openingFixture()
  const result = serializeCampaign({...campaign, managers: [{userId: 'secret-manager'}], createdByUserId: 'creator', periods: [], targets: targets.map(target => ({...target, preleveur: {userId: 'preleveur', socialReason: 'Ferme', user: {}}, meters: []}))})
  t.false(Object.hasOwn(result, 'managers'))
  t.false(Object.hasOwn(result, 'createdByUserId'))
  t.false(Object.hasOwn(result.targets[0], 'exploitation'))
})

test('les points de campagne conservent code et couleur du référentiel pour la palette existante', t => {
  const {campaign, targets} = openingFixture()
  targets[0].exploitation.usage = {id: 'usage', label: 'Irrigation', code: '2', color: '#00AA00'}
  const result = serializeCampaign({...campaign, periods: [], targets: targets.map(target => ({...target, preleveur: {userId: 'preleveur', socialReason: 'Ferme', user: {}}, meters: []}))})
  t.deepEqual(result.targets[0].usage, {id: 'usage', name: 'Irrigation', code: '2', color: '#00AA00'})
  t.false(Object.hasOwn(result.targets[0], 'exploitation'))
})

test('le signalement reçoit seulement le contact principal du collecteur, sans sa connexion ni ses contacts secondaires', t => {
  const campaign = {periods: [], targets: [], ownerCollecteur: {socialReason: 'OUGC', user: {email: 'login@example.test'}, contactEmails: [{email: 'secondaire@example.test', isPrimary: false}, {email: 'contact@example.test', isPrimary: true}]}}
  const result = serializeCampaign(campaign)
  t.deepEqual(result.ownerContact, {label: 'OUGC', email: 'contact@example.test'})
  t.false(Object.hasOwn(result, 'ownerCollecteur'))
  t.false(JSON.stringify(result).includes('login@example.test'))
  t.false(JSON.stringify(result).includes('secondaire@example.test'))
})

test('historique : périmètre courant appliqué à toutes les révisions et curseur borné', async t => {
  const campaign = {id: 'campaign', zoneId: 'zone', ownerCollecteurUserId: 'owner', status: 'CLOSED', managers: [], periods: [],
    targets: ['allowed', 'forbidden'].map((id, index) => ({id, preleveurUserId: 'farmer', exploitation: {collecteurs: [{collecteurUserId: index ? 'another' : 'reader'}]}, pointPrelevement: {collectionMode: 'MANUAL', zones: []}, meters: []}))}
  let query
  const client = {
    campaign: {async findUnique() {
      return campaign
    }},
    campaignResponse: {async findUnique() {
      return {id: 'response'}
    }},
    campaignSubmission: {async findFirst() {
      return null
    }, async findMany(input) {
      query = input
      return Array.from({length: 51}, (_, index) => ({id: `submission-${index}`, version: 51 - index, createdBy: {firstName: 'Prénom', lastName: 'Nom'}, snapshot: {comment: 'Global', needs: [{targetId: 'allowed'}, {targetId: 'forbidden'}]}, publication: {readingReferences: [{targetId: 'allowed'}, {targetId: 'forbidden'}], eventReadingReferences: [{targetId: 'forbidden'}], meterEventReferences: [{targetId: 'forbidden'}]}}))
    }}
  }
  const user = {id: 'reader', role: 'DECLARANT'}
  const result = await getCampaignResponseHistory(user, 'campaign', 'NEEDS', {preleveurUserId: 'farmer', client})
  t.is(result.items.length, 50)
  t.is(result.nextCursor, 'submission-49')
  t.deepEqual(query.where, {responseId: 'response'})
  t.is(query.take, 51)
  t.deepEqual(result.items[0].snapshot, {needs: [{targetId: 'allowed'}]})
  t.deepEqual(result.items[0].publication, {readingReferences: [{targetId: 'allowed'}], eventReadingReferences: [], meterEventReferences: []})
  const error = await t.throwsAsync(getCampaignResponseHistory(user, 'campaign', 'NEEDS', {preleveurUserId: 'farmer', cursor: 'outside', client}))
  t.is(error.statusCode, 400)
})
