/* eslint-disable no-await-in-loop */
import {readDatabase, readDossier} from './database.js'

export async function iterate(demarcheNumber, {s3, onDossier} = {}) {
  const {dossiers} = await readDatabase(s3, demarcheNumber)

  for (const dossierSummary of dossiers) {
    const {number, hash, state, attachments} = dossierSummary
    const dossier = await readDossier(s3, demarcheNumber, number)
    await onDossier({
      number,
      hash,
      state,
      attachments,
      dossier
    })
  }
}
