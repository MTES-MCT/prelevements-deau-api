import {trim} from 'lodash-es'
import XLSX from 'xlsx'
import {fileTypeFromBuffer} from 'file-type'
import {parse, isValid} from 'date-fns'
import {fr} from 'date-fns/locale'

export async function readSheet(buffer) {
  const type = await fileTypeFromBuffer(buffer)
  const allowedExtensions = ['cfb', 'xlsx', 'ods']

  if (!type || !allowedExtensions.includes(type.ext)) {
    const error = new Error('Format de fichier incorrect')
    error.explanation = `Le fichier doit être au format xls, xlsx ou ods. Format détecté : ${type ? type.ext : 'inconnu'}.`
    throw error
  }

  try {
    return XLSX.read(buffer, {type: 'buffer'})
  } catch (readError) {
    const error = new Error('Fichier illisible ou corrompu')
    error.internalMessage = readError.message
    throw error
  }
}

// Fonction pour récupérer la valeur d'une cellule
export function getCellValue(sheet, rowIndex, colIndex) {
  const cellAddress = {c: colIndex, r: rowIndex}
  const cellRef = XLSX.utils.encode_cell(cellAddress)
  const cell = sheet[cellRef]

  if (cell) {
    return cell.v
  }
}

const CHAR_TO_TRIM = ' -\'"'

// ---------------------------------------------------------------------------
// Helpers for tolerant French/ISO date & time parsing
// ---------------------------------------------------------------------------
function sanitizeRaw(str) {
  return String(str)
    .trim() // Espaces extrêmes
    .replace(/['’]+$/, '') // Apostrophes finales
    .replaceAll(/\s{2,}/g, ' ') // Multiples espaces
    .replaceAll('\u00A0', ' ') // Espaces insécables
    .toLowerCase()
}

const DATE_CANDIDATES = [
  'd/M/yyyy', // 30/1/2025
  'dd/MM/yyyy', // 26/02/2025
  'd MMMM yyyy', // 1 février 2025
  'EEEE d MMMM yyyy', // Samedi 1 février 2025
  'd/M/yyyy HH:mm:ss' // 26/02/2025 00:00:00
]

const TIME_CANDIDATES = [
  'H:m:s', // 0:6:29
  'H:m', // 0:6
  'HH\'h\'mm', // 12h34
  'HH:mm:ss' // 08:05:00
]

function parseDate(value) {
  const raw = sanitizeRaw(value)
  for (const pattern of DATE_CANDIDATES) {
    const parsed = parse(raw, pattern, new Date(), {locale: fr})
    if (isValid(parsed)) {
      const y = parsed.getFullYear()
      const m = String(parsed.getMonth() + 1).padStart(2, '0')
      const d = String(parsed.getDate()).padStart(2, '0')
      return `${y}-${m}-${d}` // Yyyy-MM-dd
    }
  }
}

function parseTime(value) {
  const raw = sanitizeRaw(value)
  for (const pattern of TIME_CANDIDATES) {
    const parsed = parse(raw, pattern, new Date(), {locale: fr})
    if (isValid(parsed)) {
      const hh = String(parsed.getHours()).padStart(2, '0')
      const mm = String(parsed.getMinutes()).padStart(2, '0')
      const ss = String(parsed.getSeconds()).padStart(2, '0')
      return `${hh}:${mm}:${ss}` // HH:mm:ss
    }
  }
}
// ---------------------------------------------------------------------------

export function readAsString(sheet, rowIndex, colIndex) {
  const cell = sheet[XLSX.utils.encode_cell({c: colIndex, r: rowIndex})]

  if (!cell || cell.v === undefined || cell.v === null || cell.v === '') {
    return
  }

  return trim(cell.v.toString(), CHAR_TO_TRIM)
}

export function readAsGivenType(sheet, rowIndex, colIndex, type) {
  switch (type) {
    case 'string': {
      return readAsString(sheet, rowIndex, colIndex)
    }

    case 'number': {
      return readAsNumber(sheet, rowIndex, colIndex)
    }

    case 'date': {
      return readAsDateString(sheet, rowIndex, colIndex)
    }

    default: {
      throw new Error(`Type ${type} not supported`)
    }
  }
}

export function readAsNumber(sheet, rowIndex, colIndex) {
  const cell = sheet[XLSX.utils.encode_cell({c: colIndex, r: rowIndex})]
  if (!cell || cell.v === undefined || cell.v === null || cell.v === '') {
    return
  }

  if (cell.t === 'n') {
    return cell.v
  }

  if (cell.t === 's') {
    const value = trim(cell.v, CHAR_TO_TRIM)
    const number = Number(value.replace(',', '.'))

    if (!Number.isNaN(number)) {
      return number
    }
  }
}

export function readAsDateString(sheet, rowIndex, colIndex) {
  const cell = sheet[XLSX.utils.encode_cell({c: colIndex, r: rowIndex})]

  if (!cell || cell.v === undefined || cell.v === null || cell.v === '') {
    return
  }

  if (cell.t === 'n') {
    const date = convertExcelDateToJSDate(cell.v)
    return date.toISOString().slice(0, 10)
  }

  if (cell.t === 's') {
    const parsed = parseDate(cell.v)
    if (parsed) {
      return parsed
    }

    // Valeur texte mais format inconnu
    const value = trim(cell.v.toString(), CHAR_TO_TRIM)
    throw new Error(`Format de date invalide: ${value}`)
  }
}

export function readAsTimeString(sheet, rowIndex, colIndex) {
  const cell = sheet[XLSX.utils.encode_cell({c: colIndex, r: rowIndex})]

  if (!cell) {
    return
  }

  if (cell.t === 'n') {
    const date = convertExcelDateToJSDate(cell.v)
    return date.toISOString().slice(11, 19)
  }

  if (cell.t === 's') {
    const parsed = parseTime(cell.v)
    if (parsed) {
      return parsed
    }

    // Valeur texte mais format inconnu
    const value = trim(cell.v.toString(), CHAR_TO_TRIM)
    throw new Error(`Format horaire invalide: ${value}`)
  }
}

function convertExcelDateToJSDate(excelDate) {
  // Excel dates are based on 1900-01-01 being day 1 and 1900 being a leap year.
  const startDate = new Date(Date.UTC(1900, 0, 1))
  return new Date(startDate.getTime() + ((excelDate - 2) * 24 * 60 * 60 * 1000))
}
