import {trim} from 'lodash-es'
import XLSX from 'xlsx'
import {fileTypeFromBuffer} from 'file-type'

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

export function readAsDateString(sheet, rowIndex, colIndex) {
  const cell = sheet[XLSX.utils.encode_cell({c: colIndex, r: rowIndex})]

  if (!cell || !cell.v) {
    return
  }

  if (cell.t === 'n') {
    const date = convertExcelDateToJSDate(cell.v)
    return date.toISOString().slice(0, 10)
  }

  if (cell.t === 's') {
    const value = trim(cell.v.replaceAll('/', '-'), CHAR_TO_TRIM)

    const matchISO = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
    if (matchISO) {
      return `${matchISO[1]}-${matchISO[2].padStart(2, '0')}-${matchISO[3].padStart(2, '0')}`
    }

    const matchFR = value.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/)
    if (matchFR) {
      return `${matchFR[3]}-${matchFR[2].padStart(2, '0')}-${matchFR[1].padStart(2, '0')}`
    }

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
    const value = trim(cell.v.trim(), CHAR_TO_TRIM)

    const match = value.match(/^(\d{2}):(\d{2})(:(\d{2}))?$/)
    if (match) {
      return `${match[1]}:${match[2]}:${match[4] || '00'}`
    }

    throw new Error(`Format de date invalide: ${value}`)
  }
}

function convertExcelDateToJSDate(excelDate) {
  // Excel dates are based on 1900-01-01 being day 1 and 1900 being a leap year.
  const startDate = new Date(Date.UTC(1900, 0, 1))
  return new Date(startDate.getTime() + ((excelDate - 2) * 24 * 60 * 60 * 1000))
}
