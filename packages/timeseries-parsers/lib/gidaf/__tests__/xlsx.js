import path from 'node:path'
import fs from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import test from 'ava'
import {extractGidaf} from '../index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const testFilesPath = path.join(__dirname, 'test-files')

test('extractGidaf - valid files', async t => {
  const cadresBuffer = await fs.readFile(path.join(testFilesPath, 'cadres-valid.xlsx'))
  const prelevementsBuffer = await fs.readFile(path.join(testFilesPath, 'prelevements-valid.xlsx'))

  const {errors, data} = await extractGidaf(cadresBuffer, prelevementsBuffer)

  const criticalErrors = errors.filter(e => e.severity === 'error')
  t.is(criticalErrors.length, 0, `Erreurs critiques: ${JSON.stringify(criticalErrors)}`)

  t.truthy(data)
  t.truthy(data.series)
  t.true(data.series.length > 0, 'Aucune série extraite')
  t.truthy(data.metadata)
  t.true(Array.isArray(data.metadata.pointsPrelevement))
  t.true(Array.isArray(data.metadata.preleveurs))
  t.true(data.metadata.preleveurs.length > 0, 'Aucun préleveur extrait')

  const parameters = new Set(data.series.map(serie => serie.parameter))
  t.true(parameters.has('Volume prélevé'))
  t.true(parameters.has('Volume rejeté'))

  const preleveur = data.metadata.preleveurs[0]
  t.truthy(preleveur.siret)
  t.is(preleveur.siret.length, 14, 'SIRET doit avoir 14 chiffres')

  const point = data.metadata.pointsPrelevement[0]
  t.truthy(point.id_point_de_prelevement_ou_rejet)
})

test('extractGidaf - missing prelevements file', async t => {
  const cadresBuffer = await fs.readFile(path.join(testFilesPath, 'cadres-valid.xlsx'))
  const {errors, data} = await extractGidaf(cadresBuffer, null)

  t.true(errors.length > 0)
  t.truthy(data)
  t.truthy(data.metadata)
  t.deepEqual(data.series, [])
})

test('extractGidaf - empty prelevements file', async t => {
  const cadresBuffer = await fs.readFile(path.join(testFilesPath, 'cadres-valid.xlsx'))
  const prelevementsBuffer = await fs.readFile(path.join(testFilesPath, 'prelevements-empty.xlsx'))
  const {errors, data} = await extractGidaf(cadresBuffer, prelevementsBuffer)

  t.true(errors.length > 0)
  t.truthy(data)
  t.deepEqual(data.series, [])
})

test('extractGidaf - missing point_de_surveillance column', async t => {
  const cadresBuffer = await fs.readFile(path.join(testFilesPath, 'cadres-valid.xlsx'))
  const prelevementsBuffer = await fs.readFile(path.join(testFilesPath, 'prelevements-missing-column.xlsx'))
  const {errors, data} = await extractGidaf(cadresBuffer, prelevementsBuffer)

  t.true(errors.length > 0)
  const errorMessages = errors.map(e => e.message).join(' ')
  t.true(
    errorMessages.includes('point de surveillance') || errorMessages.includes('en-tête'),
    `Erreur attendue sur colonne manquante, reçu: ${errorMessages}`
  )
  t.truthy(data)
  t.deepEqual(data.series, [])
})

