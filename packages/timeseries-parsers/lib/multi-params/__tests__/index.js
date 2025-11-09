import path from 'node:path'
import fs from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import test from 'ava'
import {extractMultiParamFile} from '../index.js'
import {expandToDaily, isCumulativeParameter} from '../frequency.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const testFilesPath = path.join(__dirname, 'test-files')

test('extractMultiParamFile - valid file', async t => {
  const filePath = path.join(testFilesPath, 'valid.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors, data} = await extractMultiParamFile(fileContent)
  t.deepEqual(errors, [])
  t.truthy(data)
  t.true(Array.isArray(data.series))
  t.true(data.series.length > 0)
  const volumeDaily = data.series.find(s => s.parameter === 'volume prélevé' && s.frequency === '1 day')
  t.truthy(volumeDaily)
  t.is(volumeDaily.valueType, 'cumulative')
})

test('extractMultiParamFile - structure des séries', async t => {
  const filePath = path.join(testFilesPath, 'valid.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors, data} = await extractMultiParamFile(fileContent)
  t.deepEqual(errors, [])
  const {series} = data
  // Chaque série doit avoir l'ensemble minimal de clés.
  for (const s of series) {
    t.true(['1 day', '15 minutes', '1 hour', '1 minute', '1 second'].includes(s.frequency))
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

test('extractMultiParamFile - incorrect file format', async t => {
  const filePath = path.join(testFilesPath, 'not-an-excel-file.txt')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await extractMultiParamFile(fileContent)
  t.is(errors.length, 1)
  t.is(errors[0].message, 'Format de fichier incorrect')
})

test('extractMultiParamFile - corrupted file', async t => {
  const filePath = path.join(testFilesPath, 'corrupted.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await extractMultiParamFile(fileContent)
  t.is(errors.length, 1)
  t.is(errors[0].message, 'Fichier illisible ou corrompu')
})

test('extractMultiParamFile - missing "A LIRE" tab', async t => {
  const filePath = path.join(testFilesPath, 'missing-a-lire-tab.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await extractMultiParamFile(fileContent)
  t.is(errors.length, 1)
  t.is(errors[0].message, 'L\'onglet \'A LIRE\' est manquant')
})

test('extractMultiParamFile - no "Data | T=..." tab found', async t => {
  const filePath = path.join(testFilesPath, 'no-data-tab.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await extractMultiParamFile(fileContent)
  t.is(errors.length, 1)
  t.is(errors[0].message, 'Aucun onglet \'Data | T=...\' n\'a été trouvé')
})

test('extractMultiParamFile - missing point name', async t => {
  const filePath = path.join(testFilesPath, 'missing-point-name.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await extractMultiParamFile(fileContent)
  t.is(errors.length, 1)
  t.is(errors[0].message, 'Le nom du point de prélèvement (cellule B3 de l\'onglet \'A LIRE\') est manquant')
})

test('extractMultiParamFile - modified header in data tab', async t => {
  const filePath = path.join(testFilesPath, 'modified-header.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await extractMultiParamFile(fileContent)
  t.true(errors.some(e => e.message.includes('a été modifié')))
})

test('extractMultiParamFile - missing frequency', async t => {
  const filePath = path.join(testFilesPath, 'missing-frequency.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await extractMultiParamFile(fileContent)
  t.true(errors.some(e => e.message.startsWith('Fréquence non renseignée pour le paramètre')))
})

test('extractMultiParamFile - modified frequency', async t => {
  const filePath = path.join(testFilesPath, 'modified-frequency.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await extractMultiParamFile(fileContent)
  t.true(
    errors.some(e => e.message.startsWith('Le champ \'frequence\' (cellule') && e.message.includes('a été modifié pour le paramètre'))
  )
})

test('extractMultiParamFile - incorrect value', async t => {
  const filePath = path.join(testFilesPath, 'incorrect-value.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await extractMultiParamFile(fileContent)
  t.true(errors.some(e => e.message.startsWith('Valeur incorrecte pour le paramètre')))
})

test('extractMultiParamFile - missing metadata field', async t => {
  const filePath = path.join(testFilesPath, 'missing-metadata-field.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await extractMultiParamFile(fileContent)
  t.true(errors.some(e => e.message.startsWith('Le champ') && e.message.includes('est manquant pour le paramètre')))
})

test('extractMultiParamFile - invalid metadata field value', async t => {
  const filePath = path.join(testFilesPath, 'invalid-metadata-value.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await extractMultiParamFile(fileContent)
  t.true(errors.some(e => e.message.includes('doit être l\'une des valeurs suivantes')))
})

test('extractMultiParamFile - invalid date_debut', async t => {
  const filePath = path.join(testFilesPath, 'invalid-date-debut.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await extractMultiParamFile(fileContent)
  t.true(
    errors.some(e => e.message.includes('n\'est pas valide pour le paramètre'))
  )
})

test('extractMultiParamFile - invalid date_fin', async t => {
  const filePath = path.join(testFilesPath, 'invalid-date-fin.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await extractMultiParamFile(fileContent)
  t.true(
    errors.some(e => e.message.includes('n\'est pas valide pour le paramètre'))
  )
})

test('extractMultiParamFile - inconsistent dates', async t => {
  const filePath = path.join(testFilesPath, 'inconsistent-dates.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await extractMultiParamFile(fileContent)
  t.true(
    errors.some(e => e.message.includes('ne peut pas être postérieure à la date de fin'))
  )
})

test('extractMultiParamFile - unable to determine time step', async t => {
  const filePath = path.join(testFilesPath, 'no-time-step.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await extractMultiParamFile(fileContent)
  t.true(errors.some(e => e.message.startsWith('Impossible de déterminer le pas de temps attendu pour le paramètre')))
})

test('extractMultiParamFile - incorrect time step', async t => {
  const filePath = path.join(testFilesPath, 'incorrect-time-step.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await extractMultiParamFile(fileContent)
  t.true(errors.some(e => e.message.startsWith('Le pas de temps est incorrect pour')))
})

test('extractMultiParamFile - invalid dates in data tab', async t => {
  const filePath = path.join(testFilesPath, 'invalid-dates-in-data.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await extractMultiParamFile(fileContent)
  t.true(errors.some(e => e.message.startsWith('Les dates pour la ligne 14 de l\'onglet') && e.message.endsWith('ne sont pas valides.')))
})

test('extractMultiParamFile - missing date in data tab', async t => {
  const filePath = path.join(testFilesPath, 'missing-date-in-data.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await extractMultiParamFile(fileContent)
  t.true(errors.some(e => e.message.startsWith('Le champ \'date\' est obligatoire pour la ligne')))
})

test('extractMultiParamFile - missing time in data tab', async t => {
  const filePath = path.join(testFilesPath, 'missing-time-in-data.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await extractMultiParamFile(fileContent)
  t.true(errors.some(e => e.message.startsWith('Le champ \'heure\' est obligatoire pour la ligne 13 de l\'onglet')))
})

test('extractMultiParamFile - dates out of range', async t => {
  const filePath = path.join(testFilesPath, 'dates-out-of-range.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await extractMultiParamFile(fileContent)
  t.true(errors.some(e => e.message.includes('doivent être comprises entre le')))
})

test('extractMultiParamFile - too many errors', async t => {
  const filePath = path.join(testFilesPath, 'too-many-errors.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await extractMultiParamFile(fileContent)
  t.true(errors.some(e => e.message === 'Les dates de 20 lignes de l\'onglet \'Data | T=1 jour\' ne sont pas valides.'))
})

test('extractMultiParamFile - no daily data', async t => {
  const filePath = path.join(testFilesPath, 'no-daily-data.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {data} = await extractMultiParamFile(fileContent)
  t.truthy(data)
  t.true(Array.isArray(data.series))
  // Vérifie qu'il n'y a pas de série avec une fréquence journalière
  const dailySeries = data.series.filter(s => s.frequency === '1 day')
  t.is(dailySeries.length, 0)
})

test('extractMultiParamFile - no volume data', async t => {
  const filePath = path.join(testFilesPath, 'no-volume-data.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {data} = await extractMultiParamFile(fileContent)
  t.truthy(data)
  t.true(Array.isArray(data.series))
  // Vérifie qu'il n'y a pas de série de volume prélevé
  const volumeSeries = data.series.filter(s => s.parameter === 'volume prélevé')
  t.is(volumeSeries.length, 0)
})

// Warning test
test('extractMultiParamFile - missing remark for empty value', async t => {
  const filePath = path.join(testFilesPath, 'missing-remark.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors} = await extractMultiParamFile(fileContent)
  const warning = errors.find(e => e.severity === 'warning')
  t.truthy(warning)
  t.true(warning.message.startsWith('Le champ \'Remarque\' doit être renseigné'))
})

test('extractMultiParamFile - rows with no date are ignored', async t => {
  const filePath = path.join(testFilesPath, 'no-date-rows.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {data, errors} = await extractMultiParamFile(fileContent)
  t.truthy(errors.some(e => e.message.includes('Le champ \'date\' est obligatoire')))
  const volumeSeries = data.series.find(s => s.parameter === 'volume prélevé' && s.frequency === '1 day')
  const total = volumeSeries.data.reduce((sum, d) => sum + (typeof d.value === 'number' ? d.value : 0), 0)
  t.is(total, 3)
})

// Super-daily frequency expansion tests
test('expandToDaily - monthly volume is expanded correctly', t => {
  const monthlyRow = {date: '2025-01-01', value: 3100, remark: 'Janvier'}
  const expanded = expandToDaily(monthlyRow, '1 month')

  t.is(expanded.length, 31)
  t.is(expanded[0].date, '2025-01-01')
  t.is(expanded[30].date, '2025-01-31')

  // Chaque jour devrait avoir value = 3100/31 = 100
  const dailyValue = 3100 / 31
  t.is(expanded[0].value, dailyValue)

  // Métadonnées préservées
  t.is(expanded[0].originalValue, 3100)
  t.is(expanded[0].originalDate, '2025-01-01')
  t.is(expanded[0].originalFrequency, '1 month')
  t.is(expanded[0].daysCovered, 31)
  t.is(expanded[0].remark, 'Janvier')
})

test('buildSeriesForParam - cumulative parameters are expanded for super-daily frequencies', t => {
  // Vérifier que les volumes sont bien identifiés comme cumulatifs
  t.true(isCumulativeParameter('volume prélevé'))
  t.true(isCumulativeParameter('volume restitué'))

  // Note: Les tests d'intégration avec fichiers Excel valideront le comportement complet
  // incluant la présence du champ originalFrequency
})

test('buildSeriesForParam - non-cumulative parameters keep original frequency', t => {
  // Vérifier que les autres paramètres ne sont PAS cumulatifs
  t.false(isCumulativeParameter('température'))
  t.false(isCumulativeParameter('pH'))
  t.false(isCumulativeParameter('débit prélevé'))

  // Note: Pour les paramètres non-cumulatifs avec fréquence > 1 jour,
  // la série garde sa fréquence d'origine (pas d'expansion, pas d'originalFrequency)
})

test('expandToDaily preserves originalFrequency in series metadata', t => {
  // Simuler une série avec expansion
  const monthlyRow = {date: '2025-01-01', value: 3100}
  const expanded = expandToDaily(monthlyRow, '1 month')

  // Vérifier que chaque ligne expansée contient bien originalFrequency
  t.is(expanded[0].originalFrequency, '1 month')
  t.is(expanded[15].originalFrequency, '1 month')
  t.is(expanded[30].originalFrequency, '1 month')
})

// Tests pour les nouveaux onglets T=1 heure et T=1 mois
test('extractMultiParamFile - template with hourly and monthly tabs', async t => {
  const filePath = path.join(testFilesPath, 'template-v2.10.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors, data} = await extractMultiParamFile(fileContent)

  // Pas d'erreurs critiques attendues (seulement warnings éventuels)
  const criticalErrors = errors.filter(e => e.severity === 'error' || !e.severity)
  t.is(criticalErrors.length, 0, 'Aucune erreur critique attendue')
  t.truthy(data)
  t.true(Array.isArray(data.series))

  // Vérifier qu'il y a des séries avec fréquence horaire
  const hourlySeries = data.series.filter(s => s.frequency === '1 hour')
  t.true(hourlySeries.length > 0, 'Au moins une série horaire doit être présente')

  // Vérifier qu'il y a des séries avec fréquence mensuelle OU avec originalFrequency mensuelle
  const monthlySeries = data.series.filter(s => s.frequency === '1 month' || s.originalFrequency === '1 month')
  t.true(monthlySeries.length > 0, 'Au moins une série mensuelle (ou expansée depuis mensuel) doit être présente')
})

test('extractMultiParamFile - hourly series have time field', async t => {
  const filePath = path.join(testFilesPath, 'template-v2.10.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {data} = await extractMultiParamFile(fileContent)

  // Le template contient des températures horaires pour les 1er et 2 novembre 2025 (48 valeurs)
  const hourlySeries = data.series.find(s => s.frequency === '1 hour' && s.parameter === 'température')

  t.truthy(hourlySeries, 'Une série de température horaire doit être présente')
  t.is(hourlySeries.frequency, '1 hour')
  t.is(hourlySeries.valueType, 'instantaneous')
  t.true(Array.isArray(hourlySeries.data))
  t.is(hourlySeries.data.length, 48, '1er et 2 novembre 2025 = 48 heures')
  t.is(hourlySeries.minDate, '2025-11-01')
  t.is(hourlySeries.maxDate, '2025-11-02')

  // Vérifier que les points de données ont un champ time
  for (const point of hourlySeries.data) {
    t.truthy(point.date, 'Chaque point doit avoir une date')
    t.truthy(point.time, 'Chaque point horaire doit avoir une heure')
    t.regex(point.time, /^\d{2}:\d{2}$/, 'Le format de l\'heure doit être HH:mm')
    t.true(typeof point.value === 'number', 'La valeur doit être un nombre')
  }
})

test('extractMultiParamFile - monthly volumes are expanded to daily', async t => {
  const filePath = path.join(testFilesPath, 'template-v2.10.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {data} = await extractMultiParamFile(fileContent)

  // Le template contient novembre et décembre 2025 (30 + 31 = 61 jours)
  const expandedVolumeSeries = data.series.find(
    s => s.parameter === 'volume prélevé' && s.originalFrequency === '1 month'
  )

  t.truthy(expandedVolumeSeries, 'Une série de volume prélevé mensuel expansée doit être présente')
  t.is(expandedVolumeSeries.frequency, '1 day', 'Fréquence journalière après expansion')
  t.is(expandedVolumeSeries.originalFrequency, '1 month', 'Fréquence d\'origine conservée')
  t.is(expandedVolumeSeries.valueType, 'cumulative')
  t.is(expandedVolumeSeries.minDate, '2025-11-01')
  t.is(expandedVolumeSeries.maxDate, '2025-12-31')

  // Novembre 2025 = 30 jours + Décembre 2025 = 31 jours
  t.is(expandedVolumeSeries.data.length, 61, 'Novembre (30j) + Décembre (31j) = 61 jours')

  // Vérifier les métadonnées d'expansion sur le premier point (novembre)
  const firstPoint = expandedVolumeSeries.data[0]
  t.is(firstPoint.date, '2025-11-01')
  t.is(firstPoint.time, undefined, 'Pas de champ time pour les données journalières')
  t.true(typeof firstPoint.value === 'number')
  t.truthy(firstPoint.originalValue, 'Valeur originale conservée')
  t.is(firstPoint.originalDate, '2025-11-01')
  t.is(firstPoint.originalFrequency, '1 month')
  t.is(firstPoint.daysCovered, 30, 'Novembre 2025 a 30 jours')

  // Vérifier le premier point de décembre
  const decemberFirstPoint = expandedVolumeSeries.data[30]
  t.is(decemberFirstPoint.date, '2025-12-01')
  t.is(decemberFirstPoint.originalDate, '2025-12-01')
  t.is(decemberFirstPoint.daysCovered, 31, 'Décembre 2025 a 31 jours')
})

test('extractMultiParamFile - quarterly data tab', async t => {
  const filePath = path.join(testFilesPath, 'quarterly-data.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {data, errors} = await extractMultiParamFile(fileContent)

  // Pas d'erreurs critiques attendues
  const criticalErrors = errors.filter(e => e.severity === 'error' || !e.severity)
  t.is(criticalErrors.length, 0, 'Aucune erreur critique attendue')
  t.truthy(data)
  t.true(Array.isArray(data.series))

  // Vérifier qu'il y a exactement 3 séries trimestrielles
  const quarterlySeries = data.series.filter(s => s.frequency === '1 quarter')
  t.is(quarterlySeries.length, 3, 'Trois séries trimestrielles doivent être présentes')

  // Vérifier la série de chlorures
  const chloruresSeries = data.series.find(s => s.parameter === 'chlorures')
  t.truthy(chloruresSeries, 'Une série de chlorures doit être présente')
  t.is(chloruresSeries.frequency, '1 quarter')
  t.is(chloruresSeries.unit, 'mg/L')
  t.is(chloruresSeries.valueType, 'instantaneous')
  t.is(chloruresSeries.pointPrelevement, 220)
  t.is(chloruresSeries.data.length, 1)
  t.is(chloruresSeries.data[0].date, '2025-02-26')
  t.is(chloruresSeries.data[0].value, 34)

  // Vérifier la série de sulfates
  const sulfatesSeries = data.series.find(s => s.parameter === 'sulfates')
  t.truthy(sulfatesSeries, 'Une série de sulfates doit être présente')
  t.is(sulfatesSeries.frequency, '1 quarter')
  t.is(sulfatesSeries.unit, 'mg/L')
  t.is(sulfatesSeries.data.length, 1)
  t.is(sulfatesSeries.data[0].value, 19)

  // Vérifier la série de nitrates
  const nitratesSeries = data.series.find(s => s.parameter === 'nitrates')
  t.truthy(nitratesSeries, 'Une série de nitrates doit être présente')
  t.is(nitratesSeries.frequency, '1 quarter')
  t.is(nitratesSeries.unit, 'mg/L')
  t.is(nitratesSeries.data.length, 1)
  t.is(nitratesSeries.data[0].value, 13)
})
