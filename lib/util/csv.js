import fs from 'node:fs/promises'
import Papa from 'papaparse'

async function fileExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

export async function readDataFromCsvFile(filePath, tableDefinition, throwIfNotFound = true) {
  const file = await fileExists(filePath)

  if (!file) {
    console.log(
      '\n\u001B[30;43m%s\u001B[0m',
      `Le fichier ${filePath} est introuvable.`
    )

    if (throwIfNotFound) {
      throw new Error(`Le fichier ${filePath} est obligatoire.`)
    } else {
      return []
    }
  }

  const csvContent = await fs.readFile(filePath, 'utf8')
  const {data: inputRows} = Papa.parse(csvContent, {header: true, skipEmptyLines: true})

  if (!tableDefinition) {
    return inputRows
  }

  const outputRows = []

  for (const inputRow of inputRows) {
    const outputRow = {}

    for (const [key, value] of Object.entries(inputRow)) {
      const fieldDefinition = tableDefinition.schema[key]
      if (fieldDefinition) {
        if (fieldDefinition.drop) {
          continue
        }

        outputRow[key] = fieldDefinition.parse ? fieldDefinition.parse(value) : value
      }
    }

    if (!tableDefinition.requiredFields || tableDefinition.requiredFields.every(field => outputRow[field] !== undefined)) {
      outputRows.push(outputRow)
    } else {
      console.warn('Dropping row because of missing required fields', outputRow)
    }
  }

  return outputRows
}

export function parseDate(value) {
  const simpleDateRegex = /^\d{4}-\d{2}-\d{2}$/
  const customDateTimeRegex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}$/

  if (simpleDateRegex.test(value)) {
    return value
  }

  if (customDateTimeRegex.test(value)) {
    return (new Date(value)).toISOString()
  }

  if (value) {
    console.warn(`Unknown date format: ${value}`)
  }
}

export function parseNomenclature(value, nomenclature) {
  if (value && !nomenclature[value]) {
    console.warn(`Valeur inconnue dans la nomenclature: ${value || 'VIDE'}`)
  }

  return nomenclature[value]
}

export function parseString(value) {
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

export function parseNumber(value) {
  return value === '' ? undefined : Number(value)
}

export function parseBoolean(value) {
  switch (value.toLowerCase()) {
    case 't': {
      return true
    }

    case 'f': {
      return false
    }

    case '': {
      return undefined
    }

    default: {
      console.warn('Valeur booléenne inconnue', value)
    }
  }
}
