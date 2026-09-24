import test from 'ava'
import {randomUUID} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {validateCampaignSeedConfig, COLLECTEUR_SOURCE_ID} from '../seed-campaign.js'

const fixture = () => ({createdByUserId: randomUUID(), collecteur: {
  socialReason: 'Collecteur de test', firstName: 'Contact', lastName: 'Test',
  email: 'synthetic-collector@example.test', phoneNumber: '0000000000'
}})

test('configuration privée : normalisation, administrateur explicite et identité stable', t => {
  const input = fixture()
  input.collecteur.email = ' SYNTHETIC-COLLECTOR@example.test '
  const result = validateCampaignSeedConfig(input)
  t.is(result.createdByUserId, input.createdByUserId)
  t.is(result.collecteur.email, 'synthetic-collector@example.test')
  t.is(result.collecteur.sourceId, COLLECTEUR_SOURCE_ID)
  t.is(result.name, 'Collecte des index et des besoins 2025–2027')
  const {createdByUserId, ...withoutActor} = fixture()
  t.is(validateCampaignSeedConfig(withoutActor, {actorUserId: createdByUserId}).createdByUserId, createdByUserId)
})

test('configuration : aucun administrateur inventé, paramètre ignoré ou contact incomplet', t => {
  const cases = [null, {}, {...fixture(), createdByUserId: undefined}, {...fixture(), createdByUserId: 'admin'},
    {...fixture(), extra: true}, {...fixture(), opensOn: '2026-01-01'}, {...fixture(), name: ''}]
  for (const field of ['socialReason', 'firstName', 'lastName', 'email', 'phoneNumber']) {
    const input = fixture()
    delete input.collecteur[field]
    cases.push(input)
  }
  for (const input of cases) t.throws(() => validateCampaignSeedConfig(input))
  t.throws(() => validateCampaignSeedConfig(fixture(), {actorUserId: randomUUID()}))
  for (const email of ['broken', 'example@import.local', 'example@email.fr']) {
    const input = fixture()
    input.collecteur.email = email
    t.throws(() => validateCampaignSeedConfig(input))
  }
  const otherIdentity = fixture()
  otherIdentity.collecteur.sourceId = 'a-different-collector'
  t.throws(() => validateCampaignSeedConfig(otherIdentity))
})

test('CLI : seed exige sa configuration et ne prête pas ses options aux autres opérations', t => {
  const cli = fileURLToPath(new URL('../../import-epidropt.js', import.meta.url))
  for (const args of [
    ['seed-campaign', '--target', 'testing', '--target-env', '/nonexistent-campaign-test.env'],
    ['apply', '--campaign-config', 'data/example.json'],
    ['enable-logins', '--login-scope', 'all', '--actor-user-id', randomUUID()]
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], {encoding: 'utf8'})
    t.is(result.status, 1)
    t.regex(result.stderr, /campaign-config|actor-user-id/)
    t.notRegex(result.stderr, /ENOENT|Connexion/)
    t.is(result.stdout, '')
  }
})
