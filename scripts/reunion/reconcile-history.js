#!/usr/bin/env node
import process from 'node:process'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {readFile, writeFile, mkdir, link} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {BSON} from 'mongodb'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')

export function applyReviewedIdentity(record, review, {reviewHash, owners}) {
  if (review.status !== 'IDENTITY_PROVEN' || record.payload.declarantSourceId
    || record.externalId !== `80149:${review.dossier}` || !owners.has(review.proposedSourceId)) {
    throw new Error('Identité de reprise non corroborée ou dossier déjà associé')
  }
  const resolution = {method: 'REVIEWED_SOURCE_EVIDENCE', sourceId: review.proposedSourceId,
    sourceReference: owners.get(review.proposedSourceId), reviewSha256: reviewHash, proofTypes: review.proofTypes}
  const payload = {...record.payload, declarantSourceId: review.proposedSourceId, declarantResolution: resolution}
  delete payload.declarantProposal
  return {...record, payload, sourceHash: digest(JSON.stringify({payload, files: record.files}))}
}

export async function reconcileHistory({archive, prepared, identityReview, output}) {
  process.umask(0o077)
  const root = path.resolve(archive), source = path.resolve(prepared), destination = path.resolve(output)
  if (![source, destination, path.resolve(identityReview)].every(item => item.startsWith(`${root}/`))) throw new Error('Archives privées obligatoires')
  const manifestBytes = await readFile(path.join(source, 'manifest.json'))
  if (digest(manifestBytes) !== (await readFile(path.join(source, 'manifest.json.sha256'), 'utf8')).trim()) throw new Error('Manifeste de préparation modifié')
  const manifest = JSON.parse(manifestBytes), reviewBytes = await readFile(identityReview), review = JSON.parse(reviewBytes)
  if (review.preparedManifestSha256 !== digest(manifestBytes)) throw new Error('Revue réalisée sur une autre préparation')
  const archiveBytes = await readFile(path.join(root, 'manifest.json'))
  if (digest(archiveBytes) !== (await readFile(path.join(root, 'manifest.json.sha256'), 'utf8')).trim()) throw new Error('Archive modifiée')
  const ownersFile = JSON.parse(archiveBytes).mongo.find(item => item.collection === 'preleveurs')
  const ownersBytes = await readFile(path.join(root, ownersFile.relativePath))
  if (digest(ownersBytes) !== ownersFile.sha256) throw new Error('Référentiel source modifié')
  const owners = new Map(ownersBytes.toString('utf8').trim().split('\n').map(line => BSON.EJSON.parse(line))
    .map(owner => [`reunion:DEP-974:declarant:${owner.id_preleveur}`, String(owner._id)]))
  const selected = new Map(review.rows.filter(row => row.status === 'IDENTITY_PROVEN').map(row => [row.dossier, row]))
  if (selected.size !== review.rows.filter(row => row.status === 'IDENTITY_PROVEN').length) throw new Error('Revue avec dossiers dupliqués')
  await mkdir(destination, {mode: 0o700}); await mkdir(path.join(destination, 'parts'), {mode: 0o700})
  const rows = [], changed = []
  for (const row of manifest.dossiers) {
    let bytes = await readFile(path.join(source, row.relativePath))
    if (digest(bytes) !== row.sha256) throw new Error('Dossier préparé modifié')
    let result = {...row}
    if (selected.has(row.number)) {
      const evidence = selected.get(row.number)
      if (evidence.preparedFileSha256 !== row.sha256) throw new Error('Revue du dossier périmée')
      const record = applyReviewedIdentity(JSON.parse(bytes), evidence, {reviewHash: digest(reviewBytes), owners})
      bytes = `${JSON.stringify(record)}\n`
      result = {...result, sha256: digest(bytes), declarantSourceId: record.payload.declarantSourceId, declarantResolution: record.payload.declarantResolution}
      delete result.declarantProposal
      changed.push({externalId: record.externalId, sourceId: record.payload.declarantSourceId, warnings: evidence.warnings})
    }
    await writeFile(path.join(destination, row.relativePath), bytes, {flag: 'wx', mode: 0o600})
    for (const part of row.parsedLedger) {
      const partBytes = await readFile(path.join(source, part.relativePath))
      if (digest(partBytes) !== part.checksum) throw new Error('Partition préparée modifiée')
      try { await link(path.join(source, part.relativePath), path.join(destination, part.relativePath)) } catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    rows.push(result)
  }
  if (changed.length !== selected.size) throw new Error('Revue de dossier absent du manifeste')
  const updated = {...manifest, createdAt: new Date().toISOString(), parentPreparationSha256: digest(manifestBytes), identityReviewSha256: digest(reviewBytes),
    identityChanges: changed, dossiers: rows, totals: {...manifest.totals,
      resolvedDeclarants: manifest.totals.resolvedDeclarants + changed.length,
      unresolvedDeclarants: manifest.totals.unresolvedDeclarants - changed.length}}
  const bytes = `${JSON.stringify(updated, null, 2)}\n`
  await writeFile(path.join(destination, 'manifest.json'), bytes, {flag: 'wx', mode: 0o600})
  await writeFile(path.join(destination, 'manifest.json.sha256'), `${digest(bytes)}\n`, {flag: 'wx', mode: 0o600})
  console.log(JSON.stringify({stage: 'identities-reconciled', dossiers: rows.length, resolved: changed.length}))
  return updated
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const {values} = parseArgs({options: {archive: {type: 'string'}, prepared: {type: 'string'}, 'identity-review': {type: 'string'}, output: {type: 'string'}}})
  reconcileHistory({archive: values.archive, prepared: values.prepared, identityReview: values['identity-review'], output: values.output})
    .catch(error => { console.error(JSON.stringify({stage: 'identity-reconciliation-failed', error: error.name, code: error.code ?? null, message: error.message})); process.exitCode = 1 })
}
