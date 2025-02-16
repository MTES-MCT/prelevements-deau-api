import test from 'ava'
import {readFile} from 'node:fs/promises'
import path from 'node:path'

import runMultiParamTests from '../suivi-multi-params.js'

const __dirname = path.dirname(new URL(import.meta.url).pathname)

// Fonction utilitaire pour charger un fichier Excel en tant que workbook
function readTestFile(filename) {
  const filePath = path.join(__dirname, 'test-files', 'suivi-multi-params', filename)
  return readFile(filePath)
}

test('runMultiParamsTest with a empty file', async t => {
  const buffer = await readTestFile('empty.xlsx')
  const formData = {}

  const errors = await runMultiParamTests(buffer, formData)

  t.true(errors.length === 2)
  t.true(errors.some(error => error.message.includes('Le nom du point de prélèvement (cellule B3 de l\'onglet \'A LIRE\') est manquant')))
  t.true(errors.some(error => error.message.includes('Aucune donnée n\'a été trouvée dans les onglets \'Data | T=...\'. Veuillez vérifier que vos données sont correctement saisies.')))
})

test('runMultiParamsTest with a valid file', async t => {
  const buffer = await readTestFile('valid.xlsx')
  const formData = {}

  const errors = await runMultiParamTests(buffer, formData)
  t.deepEqual(errors, [])
})
