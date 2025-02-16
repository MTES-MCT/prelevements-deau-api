import runCamionCiterneTests from './suivi-camion-citerne.js'
import runMultiParamTests from './suivi-multi-params.js'

export async function runTests(buffer, fileType, formData) {
  if (fileType === 'Données standardisées') {
    return runMultiParamTests(buffer, formData)
  }

  if (fileType === 'Tableau de suivi') {
    return runCamionCiterneTests(buffer, formData)
  }

  // TODO : Registre au format tableur
  // TODO : 'Extrait de registre

  throw new Error(`Type de fichier non pris en charge : ${fileType}`)
}

export async function validateFile(fileType, buffer, champs = {}) {
  const errors = []

  try {
    const fileErrors = await runTests(buffer, fileType, champs)
    errors.push(...fileErrors)
  } catch (error) {
    errors.push({
      message: `Erreur lors de la validation du fichier : ${error.message}`,
      destinataire: 'administrateur'
    })
  }

  return errors
}
