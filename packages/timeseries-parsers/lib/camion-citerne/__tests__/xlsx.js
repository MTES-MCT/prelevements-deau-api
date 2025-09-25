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
  t.deepEqual(data, {
    series: [
      {
        pointPrelevement: 412,
        parameter: 'volume prélevé',
        unit: 'm3',
        frequency: '1 day',
        valueType: 'cumulative',
        minDate: '2025-01-01',
        maxDate: '2025-01-01',
        data: [
          {date: '2025-01-01', value: 42}
        ]
      }
    ]
  })
})

test('validateCamionCiterneFile - multi points valid file', async t => {
  const filePath = path.join(testFilesPath, 'multi-points-valid.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors, data} = await validateCamionCiterneFile(fileContent)

  t.deepEqual(errors, [])
  t.deepEqual(data, {
    series: [
      {
        pointPrelevement: 412,
        parameter: 'volume prélevé',
        unit: 'm3',
        frequency: '1 day',
        valueType: 'cumulative',
        minDate: '2025-01-01',
        maxDate: '2025-01-04',
        data: [
          {date: '2025-01-01', value: 42},
          {date: '2025-01-02', value: 30},
          {date: '2025-01-03', value: 42},
          {date: '2025-01-04', value: 10}
        ]
      },
      {
        pointPrelevement: 413,
        parameter: 'volume prélevé',
        unit: 'm3',
        frequency: '1 day',
        valueType: 'cumulative',
        minDate: '2025-01-01',
        maxDate: '2025-01-06',
        data: [
          {date: '2025-01-01', value: 1},
          {date: '2025-01-02', value: 2},
          {date: '2025-01-03', value: 3},
          {date: '2025-01-04', value: 4},
          {date: '2025-01-05', value: 5},
          {date: '2025-01-06', value: 5}
        ]
      }
    ]
  })
})

test('validateCamionCiterneFile - incorrect file format', async t => {
  const filePath = path.join(testFilesPath, 'not-an-excel-file.txt')
  const fileContent = await fs.readFile(filePath)
  const {errors, data} = await validateCamionCiterneFile(fileContent)
  t.is(errors.length, 1)
  t.is(errors[0].message, 'Format de fichier incorrect')
  t.is(data, undefined)
})

test('validateCamionCiterneFile - corrupted file', async t => {
  const filePath = path.join(testFilesPath, 'corrupted.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors, data} = await validateCamionCiterneFile(fileContent)
  t.is(errors.length, 1)
  t.is(errors[0].message, 'Fichier illisible ou corrompu')
  t.is(data, undefined)
})

test('validateCamionCiterneFile - empty file', async t => {
  const filePath = path.join(testFilesPath, 'empty.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors, data} = await validateCamionCiterneFile(fileContent)
  t.is(errors.length, 1)
  t.is(errors[0].message, 'La feuille de calcul est vide.')
  t.is(data, undefined)
})

test('validateCamionCiterneFile - incorrect headers', async t => {
  const filePath = path.join(testFilesPath, 'incorrect-headers.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors, data} = await validateCamionCiterneFile(fileContent)
  t.is(errors.length, 2)
  t.is(errors[0].message, 'L\'intitulé de la première colonne doit être \'Date\'. Trouvé : \'incorrect\'.')
  t.truthy(errors[1].message.includes('L\'en-tête de la colonne 2 ne correspond à aucun point de prélèvement connu.'))
  t.is(data, undefined)
})

test('validateCamionCiterneFile - no data', async t => {
  const filePath = path.join(testFilesPath, 'no-data.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors, data} = await validateCamionCiterneFile(fileContent)
  t.is(errors.length, 1)
  t.is(errors[0].message, 'Le fichier ne contient pas de données.')
  t.is(data, undefined)
})

test('validateCamionCiterneFile - duplicate dates', async t => {
  const filePath = path.join(testFilesPath, 'duplicate-dates.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors, data} = await validateCamionCiterneFile(fileContent)
  t.is(errors.length, 1)
  t.is(errors[0].message, 'Ligne 5: La date 2025-01-01 est déjà présente dans le fichier.')
  t.is(data, undefined)
})

test('validateCamionCiterneFile - only necessary points', async t => {
  const filePath = path.join(testFilesPath, 'only-necessary-points.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateCamionCiterneFile(fileContent)
  t.is(errors.length, 0)
})

test('validateCamionCiterneFile - duplicates points', async t => {
  const filePath = path.join(testFilesPath, 'duplicates-points.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors, data} = await validateCamionCiterneFile(fileContent)
  t.is(errors.length, 1)
  t.is(errors[0].message, 'Le point de prélèvement 414 - Rav. Charpentier est un doublon.')
  t.is(errors[0].severity, 'error')
  t.is(data, undefined)
})
