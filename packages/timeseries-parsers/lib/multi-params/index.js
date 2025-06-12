import {pick} from 'lodash-es'

import {readSheet} from '../xlsx.js'

import {validateAndExtract as validateAndExtractMetadata} from './tabs/metadata.js'
import {validateAndExtract as validateAndExtractData} from './tabs/data.js'

export async function validateMultiParamFile(buffer) {
  let workbook

  try {
    workbook = await readSheet(buffer)

    // On valide la structure du tableur
    validateStructure(workbook)
  } catch (error) {
    return {errors: [formatError(error)]}
  }

  const data = {dataTabs: []}
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
    const dataSheetResult = validateAndExtractData(dataSheet)

    errors.push(...dataSheetResult.errors)
    data.dataTabs.push({...dataSheetResult.data, originalSheetName: dataSheet.name})
  }

  return {
    data,
    errors: errors.map(e => formatError(e))
  }
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

function formatError(error) {
  return pick(error, [
    'message',
    'explanation',
    'internalMessage',
    'severity',
    'scope'
  ])
}
