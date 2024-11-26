import * as XLSX from 'xlsx'

// Fonction pour récupérer la valeur d'une cellule
export function getCellValue(sheet, rowIndex, colIndex) {
  const cellAddress = {c: colIndex, r: rowIndex}
  const cellRef = XLSX.utils.encode_cell(cellAddress)
  const cell = sheet[cellRef]

  if (cell) {
    // Si la cellule a une formule, nous utilisons la valeur calculée 'v'
    return cell.v
  }

  return null
}

// Fonction pour vérifier si une valeur est une date valide
export function isValidDate(dateValue) {
  return !Number.isNaN(Date.parse(dateValue))
}

// Fonction pour valider si une date est dans la période du formulaire
export function validateDateInPeriod(dateValue, rowIndex, context) {
  const {formData, errors} = context

  if (formData && formData.date_debut && formData.date_fin) {
    const dateDebutForm = new Date(formData.date_debut)
    const dateFinForm = new Date(formData.date_fin)

    if (dateValue < dateDebutForm || dateValue > dateFinForm) {
      errors.push({
        message: `Ligne ${rowIndex}: La date ${dateValue.toLocaleDateString()} n'est pas comprise entre le ${dateDebutForm.toLocaleDateString()} et le ${dateFinForm.toLocaleDateString()} (période du formulaire).`,
        destinataire: 'déclarant'
      })
    }
  }
}

// Fonction pour valider qu'une valeur est numérique et positive
export function validateNumericValue(value, rowIndex, colIndex, context) {
  if (value !== null && value !== '') {
    // Remplacer les virgules par des points pour gérer les séparateurs décimaux
    const sanitizedValue = value.toString().replace(',', '.')
    const numericValue = Number.parseFloat(sanitizedValue)
    if (Number.isNaN(numericValue) || numericValue < 0) {
      context.errors.push({
        message: `Ligne ${rowIndex}, Colonne ${colIndex + 1}: La valeur '${value}' doit être un nombre positif.`,
        destinataire: 'déclarant'
      })
    }
  }
}

// Fonction pour convertir une date Excel en objet Date JavaScript
export function parseExcelDate(value) {
  if (typeof value === 'number') {
    // Conversion du numéro de série Excel en Date JavaScript
    const epoch = new Date(1899, 11, 30) // Référence pour Excel
    const date = new Date(epoch.getTime() + (value * 86_400_000)) // Chaque jour correspond à 86400000 ms
    // Ajustement pour des cas spécifiques liés à Excel
    if (value < 60) {
      date.setDate(date.getDate() - 1)
    }

    return date
  }

  if (value instanceof Date) {
    return value
  }

  if (typeof value === 'string') {
    // Tenter de parser la date à partir de la chaîne
    const date = new Date(value)
    if (!Number.isNaN(Date.parse(value))) {
      return date
    }
  }

  return null
}
