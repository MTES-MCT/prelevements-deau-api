import {readFile} from 'node:fs/promises'
import {sha256} from './core.js'

const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const number = value => String(value?.$numberInt ?? value)
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN

export function assertLatestDepositReview(review) {
  if (review?.decisionField !== 'dateDepot' || !Array.isArray(review.pairs) || !review.pairs.length || review.pairs.length > 8) {
    throw new Error('Revue explicite de 1 à 8 paires selon la date de dépôt DN obligatoire')
  }
  const values = new Set()
  for (const pair of review.pairs) {
    if (!UUID.test(pair.pointId) || !/^\d+$/.test(pair.pointNumber ?? '')) throw new Error('PP Réunion explicite obligatoire')
    for (const side of [pair.winner, pair.loser]) {
      if (!side || !/^\d+$/.test(side.dossier ?? '') || !UUID.test(side.sourceId) || !UUID.test(side.chunkId)
        || !UUID.test(side.value?.id) || side.value.chunkId !== side.chunkId || values.has(side.value.id)
        || side.dateEvidence?.chosenDateField !== 'dateDepot' || side.dateEvidence.dossier !== side.dossier
        || side.dateEvidence.dateDepot !== side.dateDepot || !Number.isFinite(timestamp(side.dateDepot))) {
        throw new Error('Identité, preuve de dépôt ou valeur de paire invalide')
      }
      values.add(side.value.id)
    }
    if (pair.winner.dossier === pair.loser.dossier || timestamp(pair.winner.dateDepot) <= timestamp(pair.loser.dateDepot)) {
      throw new Error('Le gagnant doit avoir une date de dépôt strictement plus récente')
    }
  }
}

// Re-read the original evidence, never a PE createdAt/updatedAt or an unverified
// date copied into the review. Expired DN dossiers may use the captured Mongo.
export async function verifyLatestDepositEvidence(review) {
  assertLatestDepositReview(review)
  const files = new Map(), receipts = []
  const file = async proof => {
    if (!proof?.archivePath || !/^[a-f\d]{64}$/.test(proof.archiveSha256 ?? '')) throw new Error('Archive datée avec SHA-256 obligatoire')
    if (!files.has(proof.archivePath)) files.set(proof.archivePath, await readFile(proof.archivePath))
    const bytes = files.get(proof.archivePath)
    if (sha256(bytes) !== proof.archiveSha256) throw new Error('Empreinte d’archive différente de la revue')
    return bytes
  }
  for (const pair of review.pairs) for (const side of [pair.winner, pair.loser]) {
    const evidence = side.dateEvidence
    let raw, origin
    if (evidence.rawDN) {
      raw = JSON.parse(await file(evidence.rawDN))
      if (number(raw.number) !== side.dossier || raw.state !== 'accepte') throw new Error('Dossier DN accepté attendu dans l’archive')
      origin = 'DN_RAW_ARCHIVE'
    } else {
      const proof = evidence.legacyMongo, bytes = await file(proof)
      if (!Number.isInteger(proof.lineNumber) || proof.lineNumber < 1) throw new Error('Ligne Mongo source obligatoire')
      const line = bytes.toString('utf8').split('\n')[proof.lineNumber - 1]
      if (!line || sha256(line) !== proof.lineSha256) throw new Error('Empreinte de ligne Mongo différente')
      raw = JSON.parse(line)
      if (number(raw.ds?.dossierNumber) !== side.dossier || number(raw.ds?.demarcheNumber) !== '80149' || raw.status !== 'accepte') {
        throw new Error('Dossier historique DN accepté attendu dans l’archive Mongo')
      }
      origin = 'LEGACY_MONGO_DN_ARCHIVE'
    }
    if (raw.dateDepot !== side.dateDepot || evidence.provenance !== origin) throw new Error('Date de dépôt différente de la source originale')
    receipts.push({dossier: side.dossier, dateDepot: raw.dateDepot, provenance: origin,
      archiveSha256: (evidence.rawDN ?? evidence.legacyMongo).archiveSha256})
  }
  return receipts
}
