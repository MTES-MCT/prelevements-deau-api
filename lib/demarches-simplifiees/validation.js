import XLSX from 'xlsx'
import {fileTypeFromBuffer} from 'file-type'

import runCamionCiterneTests from './suivi-camion-citerne.js'
import runMultiParamTests from './suivi-multi-params.js'

export async function analyzeFile(buffer) {
  try {
    const type = await fileTypeFromBuffer(buffer)
    const allowedExtensions = ['xls', 'xlsx', 'ods']

    if (!type || !allowedExtensions.includes(type.ext)) {
      return {
        message: `Le fichier doit être au format xls, xlsx ou ods. Type trouvé : ${type ? type.ext : 'inconnu'}.`,
        destinataire: 'déclarant'
      }
    }

    let workbook
    try {
      workbook = XLSX.read(buffer, {type: 'buffer'})
    } catch (error) {
      return {
        message: `Erreur lors de la lecture du fichier : ${error.message}`,
        destinataire: 'administrateur'
      }
    }

    return {
      workbook
    }
  } catch (error) {
    // Erreur inattendue
    return {
      message: `Erreur inattendue lors de l'analyse du fichier : ${error.message}`,
      destinataire: 'administrateur'
    }
  }
}

export function runFormDataTests(_formData) {
  const errors = []

  // TODO

  return errors
}

export async function runTests(buffer, fileType, formData) {
  const result = await analyzeFile(buffer)

  if (!result.workbook) {
    return [result]
  }

  const {workbook} = result
  let errors = []

  if (fileType === 'Données standardisées') {
    errors = [...runMultiParamTests(workbook, formData)]
  } else if (fileType === 'Tableau de suivi') {
    errors = [...errors, ...runCamionCiterneTests(workbook, formData)]
  }

  // TODO : Registre au format tableur
  // TODO : 'Extrait de registre

  // Libérer explicitement le workbook après utilisation
  for (const sheetName of Object.keys(workbook.Sheets)) {
    workbook.Sheets[sheetName] = null
  }

  return errors
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
