import test from 'ava'
import {readFileSync} from 'node:fs'
import path from 'node:path'
import XLSX from 'xlsx'

import runMultiParamTests from '../demarches-simplifies/suivi-multi-params.js'

const __dirname = path.dirname(new URL(import.meta.url).pathname)

// Fonction utilitaire pour charger un fichier Excel en tant que workbook
function loadWorkbook(filename) {
  const filePath = path.join(__dirname, 'test-files', 'suivi-multi-params', filename)
  const buffer = readFileSync(filePath)
  return XLSX.read(buffer, {type: 'buffer'})
}

test('runMultiParamsTest with a empty file', t => {
  const workbook = loadWorkbook('empty.xlsx')
  const formData = {}

  const errors = runMultiParamTests(workbook, formData)

  t.true(errors.length === 2)
  t.true(errors.some(error => error.message.includes('Le nom du point de prélèvement (cellule B3 de l\'onglet \'A LIRE\') est manquant')))
  t.true(errors.some(error => error.message.includes('Aucune donnée n\'a été trouvée dans les onglets \'Data | T=...\'. Veuillez vérifier que vos données sont correctement saisies.')))
})

test('runMultiParamsTest with a valid file', t => {
  const workbook = loadWorkbook('valid.xlsx')
  const formData = {}

  const errors = runMultiParamTests(workbook, formData)
  t.deepEqual(errors, [])
})
