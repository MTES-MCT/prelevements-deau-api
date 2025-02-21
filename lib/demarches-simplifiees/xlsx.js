import XLSX from 'xlsx'
import {fileTypeFromBuffer} from 'file-type'

export async function readSheet(buffer) {
  const type = await fileTypeFromBuffer(buffer)
  const allowedExtensions = ['cfb', 'xlsx', 'ods']

  if (!type || !allowedExtensions.includes(type.ext)) {
    return {
      message: `Le fichier doit être au format xls, xlsx ou ods. Type trouvé : ${type ? type.ext : 'inconnu'}.`
    }
  }

  let workbook
  try {
    workbook = XLSX.read(buffer, {type: 'buffer', cellDates: true})
  } catch (error) {
    return {
      message: 'Impossible de lire le fichier. Vérifiez qu\'il n\'est pas corrompu.',
      severity: 'error',
      internalMessage: error.message
    }
  }

  return {
    workbook
  }
}

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
  const {startDate, endDate, errors} = context

  if (startDate && endDate && (dateValue < startDate || dateValue > endDate)) {
    errors.push({
      message: `Ligne ${rowIndex}: La date ${formatSimpleDate(dateValue)} n'est pas comprise entre le ${formatSimpleDate(startDate)} et le ${formatSimpleDate(endDate)} (période du formulaire).`
    })
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
        message: `Ligne ${rowIndex}, Colonne ${colIndex + 1}: La valeur '${value}' doit être un nombre positif.`
      })
    }
  }
}

// Fonction pour convertir une date Excel en objet Date JavaScript
export function parseExcelDate(value) {
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

/* Helpers */

function formatSimpleDate(date) {
  return date.toISOString().split('T')[0]
}
