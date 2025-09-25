import path from 'node:path'
import fs from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import test from 'ava'
import {validateMultiParamFile} from '../index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const testFilesPath = path.join(__dirname, 'test-files')

test('validateMultiParamFile - valid file', async t => {
  const filePath = path.join(testFilesPath, 'valid.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors, data} = await validateMultiParamFile(fileContent)
  t.deepEqual(errors, [])
  t.truthy(data)
  t.true(Array.isArray(data.series))
  t.true(data.series.length > 0)
  const volumeDaily = data.series.find(s => s.parameter === 'volume prélevé' && s.frequency === '1 day')
  t.truthy(volumeDaily)
  t.is(volumeDaily.valueType, 'cumulative')
})

test('validateMultiParamFile - structure des séries', async t => {
  const filePath = path.join(testFilesPath, 'valid.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors, data} = await validateMultiParamFile(fileContent)
  t.deepEqual(errors, [])
  const {series} = data
  // Chaque série doit avoir l'ensemble minimal de clés.
  for (const s of series) {
    t.true(['1 day', '15 minutes'].includes(s.frequency))
    t.truthy(s.parameter)
    t.truthy(s.unit)
    t.truthy(s.minDate)
    t.truthy(s.maxDate)
    t.true(Array.isArray(s.data))
    t.true(['instantaneous', 'average', 'minimum', 'maximum', 'median', 'delta-index', 'cumulative', 'raw'].includes(s.valueType))

    for (const point of s.data) {
      t.truthy(point.date)
      if (s.frequency === '15 minutes') {
        t.regex(point.time, /^\d{2}:\d{2}$/)
      } else {
        t.is(point.time, undefined)
      }

      t.true(typeof point.value === 'number')
      if (point.remark !== undefined) {
        t.true(typeof point.remark === 'string')
      }
    }
  }
  // Vérifie qu'au moins une série 15 minutes contient un champ time.

  const any15 = series.find(s => s.frequency === '15 minutes')
  if (any15) {
    t.truthy(any15.data[0].time)
  }
})

test('validateMultiParamFile - incorrect file format', async t => {
  const filePath = path.join(testFilesPath, 'not-an-excel-file.txt')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateMultiParamFile(fileContent)
  t.is(errors.length, 1)
  t.is(errors[0].message, 'Format de fichier incorrect')
})

test('validateMultiParamFile - corrupted file', async t => {
  const filePath = path.join(testFilesPath, 'corrupted.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateMultiParamFile(fileContent)
  t.is(errors.length, 1)
  t.is(errors[0].message, 'Fichier illisible ou corrompu')
})

test('validateMultiParamFile - missing "A LIRE" tab', async t => {
  const filePath = path.join(testFilesPath, 'missing-a-lire-tab.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateMultiParamFile(fileContent)
  t.is(errors.length, 1)
  t.is(errors[0].message, 'L\'onglet \'A LIRE\' est manquant')
})

test('validateMultiParamFile - no "Data | T=..." tab found', async t => {
  const filePath = path.join(testFilesPath, 'no-data-tab.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateMultiParamFile(fileContent)
  t.is(errors.length, 1)
  t.is(errors[0].message, 'Aucun onglet \'Data | T=...\' n\'a été trouvé')
})

test('validateMultiParamFile - missing point name', async t => {
  const filePath = path.join(testFilesPath, 'missing-point-name.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateMultiParamFile(fileContent)
  t.is(errors.length, 1)
  t.is(errors[0].message, 'Le nom du point de prélèvement (cellule B3 de l\'onglet \'A LIRE\') est manquant')
})

test('validateMultiParamFile - modified header in data tab', async t => {
  const filePath = path.join(testFilesPath, 'modified-header.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateMultiParamFile(fileContent)
  t.true(errors.some(e => e.message.includes('a été modifié')))
})

test('validateMultiParamFile - missing frequency', async t => {
  const filePath = path.join(testFilesPath, 'missing-frequency.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateMultiParamFile(fileContent)
  t.true(errors.some(e => e.message.startsWith('Fréquence non renseignée pour le paramètre')))
})

test('validateMultiParamFile - modified frequency', async t => {
  const filePath = path.join(testFilesPath, 'modified-frequency.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateMultiParamFile(fileContent)
  t.true(
    errors.some(e => e.message.startsWith('Le champ \'frequence\' (cellule') && e.message.includes('a été modifié pour le paramètre'))
  )
})

test('validateMultiParamFile - incorrect value', async t => {
  const filePath = path.join(testFilesPath, 'incorrect-value.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateMultiParamFile(fileContent)
  t.true(errors.some(e => e.message.startsWith('Valeur incorrecte pour le paramètre')))
})

test('validateMultiParamFile - missing metadata field', async t => {
  const filePath = path.join(testFilesPath, 'missing-metadata-field.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateMultiParamFile(fileContent)
  t.true(errors.some(e => e.message.startsWith('Le champ') && e.message.includes('est manquant pour le paramètre')))
})

test('validateMultiParamFile - invalid metadata field value', async t => {
  const filePath = path.join(testFilesPath, 'invalid-metadata-value.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateMultiParamFile(fileContent)
  t.true(errors.some(e => e.message.includes('doit être l\'une des valeurs suivantes')))
})

test('validateMultiParamFile - invalid date_debut', async t => {
  const filePath = path.join(testFilesPath, 'invalid-date-debut.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateMultiParamFile(fileContent)
  t.true(
    errors.some(e => e.message.includes('n\'est pas valide pour le paramètre'))
  )
})

test('validateMultiParamFile - invalid date_fin', async t => {
  const filePath = path.join(testFilesPath, 'invalid-date-fin.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateMultiParamFile(fileContent)
  t.true(
    errors.some(e => e.message.includes('n\'est pas valide pour le paramètre'))
  )
})

test('validateMultiParamFile - inconsistent dates', async t => {
  const filePath = path.join(testFilesPath, 'inconsistent-dates.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateMultiParamFile(fileContent)
  t.true(
    errors.some(e => e.message.includes('ne peut pas être postérieure à la date de fin'))
  )
})

test('validateMultiParamFile - unable to determine time step', async t => {
  const filePath = path.join(testFilesPath, 'no-time-step.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateMultiParamFile(fileContent)
  t.true(errors.some(e => e.message.startsWith('Impossible de déterminer le pas de temps attendu pour le paramètre')))
})

test('validateMultiParamFile - incorrect time step', async t => {
  const filePath = path.join(testFilesPath, 'incorrect-time-step.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateMultiParamFile(fileContent)
  t.true(errors.some(e => e.message.startsWith('Le pas de temps est incorrect pour')))
})

test('validateMultiParamFile - invalid dates in data tab', async t => {
  const filePath = path.join(testFilesPath, 'invalid-dates-in-data.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateMultiParamFile(fileContent)
  t.true(errors.some(e => e.message.startsWith('Les dates pour la ligne 14 de l\'onglet') && e.message.endsWith('ne sont pas valides.')))
})

test('validateMultiParamFile - missing date in data tab', async t => {
  const filePath = path.join(testFilesPath, 'missing-date-in-data.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateMultiParamFile(fileContent)
  t.true(errors.some(e => e.message.startsWith('Le champ \'date\' est obligatoire pour la ligne')))
})

test('validateMultiParamFile - missing time in data tab', async t => {
  const filePath = path.join(testFilesPath, 'missing-time-in-data.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateMultiParamFile(fileContent)
  t.true(errors.some(e => e.message.startsWith('Le champ \'heure\' est obligatoire pour la ligne 13 de l\'onglet')))
})

test('validateMultiParamFile - dates out of range', async t => {
  const filePath = path.join(testFilesPath, 'dates-out-of-range.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateMultiParamFile(fileContent)
  t.true(errors.some(e => e.message.includes('doivent être comprises entre le')))
})

test('validateMultiParamFile - too many errors', async t => {
  const filePath = path.join(testFilesPath, 'too-many-errors.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateMultiParamFile(fileContent)
  t.true(errors.some(e => e.message === 'Les dates de 20 lignes de l\'onglet \'Data | T=1 jour\' ne sont pas valides.'))
})

test('validateMultiParamFile - no daily data', async t => {
  const filePath = path.join(testFilesPath, 'no-daily-data.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateMultiParamFile(fileContent)
  t.is(errors[0].message, 'Le fichier ne contient pas de données à la maille journalière')
})

test('validateMultiParamFile - no volume data', async t => {
  const filePath = path.join(testFilesPath, 'no-volume-data.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateMultiParamFile(fileContent)
  t.is(errors[0].message, 'Le fichier ne contient pas de données de volume prélevé')
})

// Warning test
test('validateMultiParamFile - missing remark for empty value', async t => {
  const filePath = path.join(testFilesPath, 'missing-remark.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await validateMultiParamFile(fileContent)
  const warning = errors.find(e => e.severity === 'warning')
  t.truthy(warning)
  t.true(warning.message.startsWith('Le champ \'Remarque\' doit être renseigné'))
})

test('validateMultiParamFile - rows with no date are ignored', async t => {
  const filePath = path.join(testFilesPath, 'no-date-rows.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {data, errors} = await validateMultiParamFile(fileContent)
  t.truthy(errors.some(e => e.message.includes('Le champ \'date\' est obligatoire')))
  const volumeSeries = data.series.find(s => s.parameter === 'volume prélevé' && s.frequency === '1 day')
  const total = volumeSeries.data.reduce((sum, d) => sum + (typeof d.value === 'number' ? d.value : 0), 0)
  t.is(total, 3)
})
