import path from 'node:path'
import fs from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import test from 'ava'
import {validateCamionCiterneFile} from '../index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const testFilesPath = path.join(__dirname, 'test-files')

test('validateCamionCiterneFile - valid file', async t => {
  const filePath = path.join(testFilesPath, 'valid.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors, data} = await validateCamionCiterneFile(fileContent)
  t.deepEqual(errors, [])
  t.is(data[0].volumePreleveTotal, 42)
})

test('validateCamionCiterneFile - multi points valid file', async t => {
  const filePath = path.join(testFilesPath, 'multi-points-valid.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors, data} = await validateCamionCiterneFile(fileContent)
  t.deepEqual(errors, [])
  t.is(data[0].volumePreleveTotal, 124)
  t.is(data[1].volumePreleveTotal, 20)
})

test('validateCamionCiterneFile - incorrect file format', async t => {
  const filePath = path.join(testFilesPath, 'not-an-excel-file.txt')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateCamionCiterneFile(fileContent)
  t.is(errors.length, 1)
  t.is(errors[0].message, 'Format de fichier incorrect')
})

test('validateCamionCiterneFile - corrupted file', async t => {
  const filePath = path.join(testFilesPath, 'corrupted.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateCamionCiterneFile(fileContent)
  t.is(errors.length, 1)
  t.is(errors[0].message, 'Fichier illisible ou corrompu')
})

test('validateCamionCiterneFile - empty file', async t => {
  const filePath = path.join(testFilesPath, 'empty.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateCamionCiterneFile(fileContent)
  t.is(errors.length, 1)
  t.is(errors[0].message, 'La feuille de calcul est vide.')
})

test('validateCamionCiterneFile - incorrect headers', async t => {
  const filePath = path.join(testFilesPath, 'incorrect-headers.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateCamionCiterneFile(fileContent)
  t.is(errors.length, 2)
  t.is(errors[0].message, 'L\'intitulé de la première colonne doit être \'Date\'. Trouvé : \'incorrect\'.')
  t.truthy(errors[1].message.includes('L\'en-tête de la colonne 2 ne correspond pas'))
})

test('validateCamionCiterneFile - no data', async t => {
  const filePath = path.join(testFilesPath, 'no-data.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateCamionCiterneFile(fileContent)
  t.is(errors.length, 1)
  t.is(errors[0].message, 'Le fichier ne contient pas de données.')
})

test('validateCamionCiterneFile - duplicate dates', async t => {
  const filePath = path.join(testFilesPath, 'duplicate-dates.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateCamionCiterneFile(fileContent)
  t.is(errors.length, 1)
  t.is(errors[0].message, 'Ligne 5: La date 2025-01-01 est déjà présente dans le fichier.')
})

test('validateCamionCiterneFile - outdated template', async t => {
  const filePath = path.join(testFilesPath, 'outdated-template.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateCamionCiterneFile(fileContent)
  t.is(errors.length, 1)
  t.is(errors[0].message, 'L\'en-tête de la colonne 12 est manquant.')
  t.is(errors[0].explanation, 'Le template utilisé n\'est peut-être pas à jour.')
  t.is(errors[0].severity, 'warning')
})
