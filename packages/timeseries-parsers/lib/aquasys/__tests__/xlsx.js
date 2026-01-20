import path from 'node:path'
import fs from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import test from 'ava'

import {extractAquasys} from '../index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const testFilesPath = path.join(__dirname, 'test-files')

test('extractAquasys - valid file', async t => {
  const buffer = await fs.readFile(path.join(testFilesPath, 'valid.xlsx'))
  const {errors, data, rawData} = await extractAquasys(buffer)

  const criticalErrors = errors.filter(e => e.severity === 'error')
  t.is(criticalErrors.length, 0, `Erreurs critiques: ${JSON.stringify(criticalErrors)}`)

  t.truthy(data)
  t.truthy(data.series)
  t.true(data.series.length > 0, 'Aucune série extraite')

  const serie = data.series[0]
  t.is(serie.pointPrelevement, 'P1')
  t.is(serie.parameter, 'Volume prélevé')
  t.is(serie.unit, 'm³')
  t.truthy(serie.data)
  t.true(Array.isArray(serie.data))

  const valuesByDate = new Map(serie.data.map(entry => [entry.date, entry.value]))
  t.is(valuesByDate.get('2024-02-01'), 100, 'Index 100->150 avec coef 2')
  t.is(valuesByDate.get('2024-03-01'), 20, 'Remise à zéro: 10 * coef 2')
  t.is(valuesByDate.get('2024-04-30'), 20, 'Volume direct')

  t.truthy(rawData)
  t.truthy(rawData.metadata)
  t.true(Array.isArray(rawData.metadata.pointsPrelevement))
  t.true(Array.isArray(rawData.metadata.preleveurs))
  t.true(rawData.metadata.preleveurs.length > 0, 'Aucun préleveur extrait')

  const point = rawData.metadata.pointsPrelevement[0]
  t.is(point.id_point_de_prelevement_ou_rejet, 'P1')
  t.is(point.id_compteur, 'C1')
  t.is(point.coefficient_de_lecture, 2)
  t.is(point.code_INSEE, '01001')

  const preleveur = rawData.metadata.preleveurs[0]
  t.is(preleveur.siret, '12345678901234')
})

test('extractAquasys - missing required columns', async t => {
  const buffer = await fs.readFile(path.join(testFilesPath, 'missing-columns.xlsx'))
  const {errors, data} = await extractAquasys(buffer)

  t.true(errors.length > 0)
  const errorMessages = errors.map(e => e.message).join(' ')
  t.true(
    errorMessages.includes('Colonnes requises') || errorMessages.includes('en-tête'),
    `Erreur attendue sur colonnes manquantes, reçu: ${errorMessages}`
  )
  t.truthy(data)
  t.deepEqual(data.series, [])
})

test('extractAquasys - empty file', async t => {
  const buffer = await fs.readFile(path.join(testFilesPath, 'empty.xlsx'))
  const {errors, data} = await extractAquasys(buffer)

  t.true(errors.length > 0)
  const criticalErrors = errors.filter(e => e.severity === 'error')
  t.true(criticalErrors.length > 0, 'Aucune erreur critique pour un fichier vide')
  t.truthy(data)
  t.deepEqual(data.series, [])
})

