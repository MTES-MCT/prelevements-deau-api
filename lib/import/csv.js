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

    // Parser les colonnes présentes dans le CSV
    for (const [key, value] of Object.entries(inputRow)) {
      const fieldDefinition = tableDefinition.schema[key]
      if (fieldDefinition) {
        if (fieldDefinition.drop) {
          continue
        }

        outputRow[key] = fieldDefinition.parse ? fieldDefinition.parse(value, inputRow) : value
      }
    }

    // Parser aussi les colonnes définies dans le schéma mais absentes du CSV
    for (const [key, fieldDefinition] of Object.entries(tableDefinition.schema)) {
      if (!(key in inputRow) && !fieldDefinition.drop && fieldDefinition.parse) {
        outputRow[key] = fieldDefinition.parse(undefined, inputRow)
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

