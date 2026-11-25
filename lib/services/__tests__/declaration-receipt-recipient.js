import test from 'ava'
import {resolveReceiptRecipient, getReceiptDeliveryAccess} from '../declaration-receipt-recipient.js'

const collector = {id: 'collector', email: 'camille@example.test', role: 'DECLARANT', firstName: 'Camille',
  declarant: {declarantRole: 'COLLECTEUR', email: 'structure@example.test'}}
const profile = {id: 'profile', email: null, role: 'DECLARANT', declarant: {declarantRole: 'PRELEVEUR', email: 'ferme@example.test'}}
const anchor = {...profile, id: 'anchor', email: 'autre@example.test', firstName: 'Claude'}
const admin = {id: 'admin', role: 'ADMIN', email: 'admin@example.test'}

function database(accounts, original, profileId) {
  return {
    user: {findUnique: async ({where}) => accounts.find(user => user.id === where.id)},
    declarationReceipt: {findFirst: async () => original},
    declaration: {findUnique: async () => ({createdByDeclarantUserId: profileId})}
  }
}

test('une correction par un tiers conserve le collecteur déposant et son adresse personnelle', async t => {
  const db = database([collector, profile, admin], {recipientUserId: collector.id, recipientEmail: collector.email}, collector.id)
  const declaration = {createdByDeclarantUserId: collector.id, declarantUserId: profile.id}
  const recipients = await Promise.all([0, 1].map(revision =>
    resolveReceiptRecipient(db, {user: revision ? admin : collector}, declaration, revision)))
  for (const recipient of recipients) {
    t.deepEqual(recipient, {recipientUserId: collector.id, recipientName: 'Camille', recipientEmail: collector.email})
  }
})

test('la connexion multiprofil retient l’adresse de connexion et contrôle que les deux profils y sont encore rattachés', async t => {
  const declaration = {createdByDeclarantUserId: profile.id}
  const db = database([profile, anchor], null, profile.id)
  const req = {user: profile, auth: {preleveurProfiles: {enabled: true}}, authActor: {id: anchor.id, email: 'Ferme@example.test'}}
  const receipt = {...await resolveReceiptRecipient(db, req, declaration, 0), kind: 'FILES_RECEIVED'}
  t.deepEqual(receipt, {recipientUserId: anchor.id, recipientEmail: 'ferme@example.test', recipientName: 'Claude', kind: 'FILES_RECEIVED'})
  t.deepEqual(await getReceiptDeliveryAccess(db, receipt), {deliver: true, canEdit: false})
  const detached = {...profile, declarant: {...profile.declarant, email: 'nouvelle@example.test'}}
  t.deepEqual(await getReceiptDeliveryAccess(database([anchor, detached], receipt, profile.id), receipt), {deliver: false, canEdit: false})
})

test('la prise de rôle adresse le mail au profil représenté', async t => {
  const req = {user: profile, auth: {impersonation: {actor: admin}}, authActor: admin}
  const recipient = await resolveReceiptRecipient(database([profile, admin]), req, {createdByDeclarantUserId: profile.id}, 0)
  t.is(recipient.recipientUserId, profile.id)
  t.is(recipient.recipientEmail, 'ferme@example.test')
})

test('les anciens dossiers sans auteur certain, avec une adresse technique ou plusieurs identités possibles ne contactent personne', async t => {
  const technical = {...profile, id: 'import', email: 'import@import.local', declarant: {declarantRole: 'PRELEVEUR'}}
  const db = database([collector, profile, anchor, technical])
  const recipients = await Promise.all([null, technical.id, anchor.id].map(id =>
    resolveReceiptRecipient(db, {user: admin}, {createdByDeclarantUserId: id, declarantUserId: profile.id}, 4)))
  t.deepEqual(recipients.map(recipient => recipient.recipientEmail), [null, null, null])
  t.is((await resolveReceiptRecipient(db, {user: admin}, {createdByDeclarantUserId: collector.id}, 4)).recipientEmail, collector.email)
})
