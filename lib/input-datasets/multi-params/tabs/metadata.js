import {getCellValue} from '../../xlsx.js'

export function validatePointDePrelevement(metadataSheet) {
  const pointPrelevement = getCellValue(metadataSheet, 2, 1) // Cellule B3

  if (pointPrelevement) {
    return pointPrelevement
  }

  throw new Error('Le nom du point de prélèvement (cellule B3 de l\'onglet \'A LIRE\') est manquant')
}

export function validateAndExtract(metadataSheet) {
  const data = {}
  const errors = []

  try {
    data.pointPrelevement = validatePointDePrelevement(metadataSheet)
  } catch (error) {
    errors.push(error)
  }

  return {data, errors}
}
