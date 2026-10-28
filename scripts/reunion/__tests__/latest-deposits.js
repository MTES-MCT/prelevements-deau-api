import {randomUUID} from 'node:crypto'
import {mkdtemp, writeFile, rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'ava'
import {assertLatestDepositReview, verifyLatestDepositEvidence} from '../lib/latest-deposit-evidence.js'
import {sha256} from '../lib/core.js'
import {historyPlanHash} from '../lib/history-target.js'
import {assertLatestDepositBackup, LATEST_DEPOSIT_OPERATION} from '../resolve-latest-deposits.js'

const side = (dossier, dateDepot) => {
  const chunkId = randomUUID()
  return {dossier, dateDepot, sourceId: randomUUID(), chunkId, value: {id: randomUUID(), chunkId},
    dateEvidence: {chosenDateField: 'dateDepot', dossier, dateDepot, provenance: 'DN_RAW_ARCHIVE'}}
}
const review = () => ({decisionField: 'dateDepot', pairs: [{pointId: randomUUID(), pointNumber: '123',
  winner: side('2', '2026-01-02T01:00:00+01:00'), loser: side('1', '2026-01-01T23:30:00Z')}]})

test('date DN : compare les instants de dépôt, jamais leur ordre lexical ni les dates PE', t => {
  const input = review()
  t.notThrows(() => assertLatestDepositReview(input))
  input.pairs[0].winner.dateDepot = '2026-01-02T00:00:00+01:00'
  input.pairs[0].winner.dateEvidence.dateDepot = input.pairs[0].winner.dateDepot
  t.throws(() => assertLatestDepositReview(input), {message: /strictement plus récente/})
  input.decisionField = 'updatedAt'
  t.throws(() => assertLatestDepositReview(input), {message: /date de dépôt DN/})
})

test('date DN : refuse égalités, preuves absentes et une valeur utilisée dans plusieurs arbitrages', t => {
  const input = review()
  input.pairs.push(structuredClone(input.pairs[0]))
  t.throws(() => assertLatestDepositReview(input), {message: /paire invalide/})
  input.pairs.pop()
  input.pairs[0].winner.dateDepot = input.pairs[0].loser.dateDepot
  input.pairs[0].winner.dateEvidence.dateDepot = input.pairs[0].winner.dateDepot
  t.throws(() => assertLatestDepositReview(input), {message: /strictement plus récente/})
})

test('date DN : relit l’archive originale et vérifie son empreinte et sa date', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'reunion-deposit-evidence-'))
  t.teardown(() => rm(directory, {recursive: true, force: true}))
  const input = review()
  for (const item of [input.pairs[0].winner, input.pairs[0].loser]) {
    const bytes = JSON.stringify({number: item.dossier, state: 'accepte', dateDepot: item.dateDepot,
      dateDerniereModification: '2030-01-01T00:00:00Z'})
    const archivePath = path.join(directory, `${item.dossier}.json`)
    await writeFile(archivePath, bytes)
    item.dateEvidence.rawDN = {archivePath, archiveSha256: sha256(bytes)}
  }
  t.is((await verifyLatestDepositEvidence(input)).length, 2)
  await writeFile(input.pairs[0].winner.dateEvidence.rawDN.archivePath, '{}')
  await t.throwsAsync(() => verifyLatestDepositEvidence(input), {message: /Empreinte/})
})

test('date DN : accepte le Mongo capturé pour un dossier expiré, contrôle ligne et démarche', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'reunion-deposit-mongo-'))
  t.teardown(() => rm(directory, {recursive: true, force: true}))
  const input = review(), archivePath = path.join(directory, 'dossiers.ejsonl')
  const sides = [input.pairs[0].winner, input.pairs[0].loser]
  const lines = sides.map(item => JSON.stringify({ds: {demarcheNumber: {$numberInt: '80149'}, dossierNumber: {$numberInt: item.dossier}}, status: 'accepte', dateDepot: item.dateDepot}))
  const bytes = `${lines.join('\n')}\n`
  await writeFile(archivePath, bytes)
  for (const [index, item] of sides.entries()) Object.assign(item.dateEvidence, {provenance: 'LEGACY_MONGO_DN_ARCHIVE',
    legacyMongo: {archivePath, archiveSha256: sha256(bytes), lineNumber: index + 1, lineSha256: sha256(lines[index])}})
  t.is((await verifyLatestDepositEvidence(input)).length, 2)
  sides[0].dateEvidence.legacyMongo.lineNumber = 2
  await t.throwsAsync(() => verifyLatestDepositEvidence(input), {message: /ligne Mongo différente/})
})

test('arbitrage DN : la sauvegarde doit correspondre exactement à la source, au plan et aux lignes', t => {
  const snapshot = {version: 1, values: [{id: randomUUID(), value: '12.345'}]}
  const context = {sourceHash: 'source', planHash: 'plan', snapshotSha256: 'file'}
  const evidence = {operation: LATEST_DEPOSIT_OPERATION, ...context, backup: {sha256: 'file'}, rowsSha256: historyPlanHash(snapshot)}
  t.notThrows(() => assertLatestDepositBackup(evidence, snapshot, context))
  for (const property of ['operation', 'sourceHash', 'planHash', 'rowsSha256']) {
    t.throws(() => assertLatestDepositBackup({...evidence, [property]: 'other'}, snapshot, context), {message: /même revue/})
  }
  t.throws(() => assertLatestDepositBackup({...evidence, backup: {sha256: 'other'}}, snapshot, context), {message: /même revue/})
})
