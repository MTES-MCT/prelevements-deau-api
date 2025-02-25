import {readSheet} from '../xlsx.js'

import {validateAndExtract as validateAndExtractMetadata} from './tabs/metadata.js'
import {validateAndExtract as validateAndExtractData} from './tabs/data.js'

export async function validateMultiParamFile(buffer, {startDate, endDate} = {}) {
  let workbook

  try {
    workbook = await readSheet(buffer)

    // On valide la structure du tableur
    validateStructure(workbook)
  } catch (error) {
    return [error]
  }

  const data = {}
  const errors = []

  /* On traite l'onglet A LIRE */

  const metadataSheet = workbook.Sheets['A LIRE']
  const metadataResult = validateAndExtractMetadata(metadataSheet)

  errors.push(...metadataResult.errors)
  data.metadata = metadataResult.data

  /* On traite les onglets de données */

  const dataSheetNames = extractDataSheetNames(workbook)
  const dataSheets = dataSheetNames.map(name => ({name, sheet: workbook.Sheets[name]}))

  for (const dataSheet of dataSheets) {
    const dataSheetResult = validateAndExtractData(dataSheet, {startDate, endDate})

    errors.push(...dataSheetResult.errors)
    data[dataSheet.name] = dataSheetResult.data
  }

  return {data, errors}
}

/* Helpers */

function extractDataSheetNames(workbook) {
  return workbook.SheetNames
    .filter(name => name.toLowerCase().startsWith('data | t='))
}

function validateStructure(workbook) {
  if (!workbook.Sheets['A LIRE']) {
    throw new Error('L\'onglet \'A LIRE\' est manquant')
  }

  if (extractDataSheetNames(workbook).length === 0) {
    throw new Error('Aucun onglet \'Data | T=...\' n\'a été trouvé')
  }
}
