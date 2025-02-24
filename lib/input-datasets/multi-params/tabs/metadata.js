import {getCellValue} from '../../xlsx.js'

export function validatePointDePrelevement(metadataSheet, errors) {
  const pointPrelevement = getCellValue(metadataSheet, 2, 1) // Cellule B3

  if (pointPrelevement) {
    return pointPrelevement
  }

  errors.push({
    message: 'Le nom du point de prélèvement (cellule B3 de l\'onglet \'A LIRE\') est manquant',
    severity: 'warning',
    scope: 'metadata'
  })
}

export function validateAndExtract(metadataSheet) {
  const result = {}
  const errors = []

  result.pointPrelevement = validatePointDePrelevement(metadataSheet, errors)

  return {result, errors}
}
