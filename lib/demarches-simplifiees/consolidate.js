import * as Dossier from '../models/dossier.js'
import * as Preleveur from '../models/preleveur.js'

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
    {result, contentUpdated: false, attachmentsUpdated: false, consolidatedAt: new Date()}
  )
}
