/* eslint-disable no-await-in-loop */
import * as Dossier from '../models/dossier.js'
import * as Preleveur from '../models/preleveur.js'

export async function consolidateDossiers() {
  const dossiers = await Dossier.getUnconsolidatedDossiers()

  for (const dossier of dossiers) {
    await consolidateDossier(dossier.demarcheNumber, dossier.number)
  }
}

export async function consolidateDossier(demarcheNumber, dossierNumber) {
  console.log(`Consolidating dossier ${demarcheNumber}/${dossierNumber}`)
  const dossier = await Dossier.getDossierByNumero(demarcheNumber, dossierNumber)

  const result = {}

  const preleveur = await Preleveur.getPreleveurByEmail(dossier.declarant.email || dossier.usager.email)

  if (preleveur) {
    result.preleveur = preleveur._id
  }

  await Dossier.updateDossier(
    demarcheNumber,
    dossierNumber,
    {result, consolidatedAt: new Date()}
  )
}
