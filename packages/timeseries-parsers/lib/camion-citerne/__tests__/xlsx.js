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
  t.deepEqual(data, [
    {
      pointPrelevement: 412,
      pointPrelevementNom: 'Riv. St Denis La Colline',
      minDate: '2025-01-01',
      maxDate: '2025-01-01',
      dailyParameters: [
        {
          paramIndex: 0,
          nom_parametre: 'volume prélevé',
          type: 'valeur brute',
          unite: 'm3'
        }
      ],
      dailyValues: [
        {
          date: '2025-01-01',
          values: [
            42
          ]
        }
      ],
      volumePreleveTotal: 42
    }
  ])
})

test('validateCamionCiterneFile - multi points valid file', async t => {
  const filePath = path.join(testFilesPath, 'multi-points-valid.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors, data} = await validateCamionCiterneFile(fileContent)

  t.deepEqual(errors, [])
  t.deepEqual(data, [
    {
      pointPrelevement: 412,
      pointPrelevementNom: 'Riv. St Denis La Colline',
      minDate: '2025-01-01',
      maxDate: '2025-01-04',
      dailyParameters: [
        {
          paramIndex: 0,
          nom_parametre: 'volume prélevé',
          type: 'valeur brute',
          unite: 'm3'
        }
      ],
      dailyValues: [
        {
          date: '2025-01-01',
          values: [
            42
          ]
        },
        {
          date: '2025-01-02',
          values: [
            30
          ]
        },
        {
          date: '2025-01-03',
          values: [
            42
          ]
        },
        {
          date: '2025-01-04',
          values: [
            10
          ]
        }
      ],
      volumePreleveTotal: 124
    },
    {
      pointPrelevement: 413,
      pointPrelevementNom: 'Rav. à Jacques (La Montagne)',
      minDate: '2025-01-01',
      maxDate: '2025-01-06',
      dailyParameters: [
        {
          paramIndex: 0,
          nom_parametre: 'volume prélevé',
          type: 'valeur brute',
          unite: 'm3'
        }
      ],
      dailyValues: [
        {
          date: '2025-01-01',
          values: [
            1
          ]
        },
        {
          date: '2025-01-02',
          values: [
            2
          ]
        },
        {
          date: '2025-01-03',
          values: [
            3
          ]
        },
        {
          date: '2025-01-04',
          values: [
            4
          ]
        },
        {
          date: '2025-01-05',
          values: [
            5
          ]
        },
        {
          date: '2025-01-06',
          values: [
            5
          ]
        }
      ],
      volumePreleveTotal: 20
    }
  ])
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
