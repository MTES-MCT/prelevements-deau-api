/* eslint-disable no-await-in-loop */
import * as Dossier from '../models/dossier.js'
import * as Preleveur from '../models/preleveur.js'

export async function consolidateDossiers() {
  const dossiers = await Dossier.getUnconsolidatedDossiers()

  for (const dossier of dossiers) {
    await consolidateDossier(dossier.demarcheNumber, dossier.number)
  }
}

async function findPreleveur(dossier) {
  return await Preleveur.getPreleveurByEmail(dossier.usager.email)
  || Preleveur.getPreleveurByEmail(dossier.declarant.email)
}

export async function consolidateDossier(demarcheNumber, dossierNumber) {
  console.log(`Consolidating dossier ${demarcheNumber}/${dossierNumber}`)
  const dossier = await Dossier.getDossierByNumero(demarcheNumber, dossierNumber)

  const result = {}

  const preleveur = await findPreleveur(dossier)

  if (preleveur) {
    result.preleveur = preleveur._id
  }

  if (preleveur && dossier.status === 'accepte') {
    const attachments = await Dossier.getAttachments(demarcheNumber, dossierNumber)

    for (const attachment of attachments) {
      if (!attachment.result?.data) {
        continue
      }

      const points = Array.isArray(attachment.result.data) ? attachment.result.data : [attachment.result.data]

      for (const p of points) {
        console.log(`${demarcheNumber}/${dossierNumber}/${p.pointPrelevement} : ${p.dailyValues.length} jours de données trouvées (${p.minDate} => ${p.maxDate})`)
      }
    }
  }

  await Dossier.updateDossier(
    demarcheNumber,
    dossierNumber,
    {result, consolidatedAt: new Date()}
  )
}
