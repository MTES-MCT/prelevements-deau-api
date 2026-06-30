import path from 'node:path'
import fs from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import test from 'ava'
import XLSX from 'xlsx'
import {extractGidaf} from '../index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const testFilesPath = path.join(__dirname, 'test-files')

function createWorkbookBuffer(rows) {
  const workbook = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  XLSX.utils.book_append_sheet(workbook, sheet, 'Feuil1')

  return XLSX.write(workbook, {bookType: 'xlsx', type: 'buffer'})
}

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
  t.true(parameters.has('volume prélevé'))
  t.true(parameters.has('volume rejeté'))

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

test('extractGidaf - prelevements without type_de_point use cadres type', async t => {
  const cadresBuffer = createWorkbookBuffer([
    ['Code Inspection', 'Point de surveillance', 'SIRET', 'Raison sociale', 'Type de point'],
    ['0001', 'Forage usine', '12345678901234', 'Usine A', 'Point d\'alimentation (amont)'],
    ['0001', 'Rejet station', '12345678901234', 'Usine A', 'Point de rejet en milieu naturel direct (aval)']
  ])

  const prelevementsBuffer = createWorkbookBuffer([
    ['Code Inspection', 'Point de surveillance', 'Date de mesure', 'Volume (m3)'],
    ['0001', 'Forage usine', '31/08/2025', 42],
    ['0001', 'Rejet station', '31/08/2025', 7]
  ])

  const {errors, data} = await extractGidaf(cadresBuffer, prelevementsBuffer)
  const criticalErrors = errors.filter(e => e.severity === 'error')
  t.is(criticalErrors.length, 0, `Erreurs critiques: ${JSON.stringify(criticalErrors)}`)

  const prelevementSeries = data.series.find(serie =>
    serie.pointPrelevement === 'Forage usine' && serie.parameter === 'volume prélevé'
  )
  const rejetSeries = data.series.find(serie =>
    serie.pointPrelevement === 'Rejet station' && serie.parameter === 'volume rejeté'
  )

  t.truthy(prelevementSeries)
  t.deepEqual(prelevementSeries.data, [{date: '2025-08-31', value: 42}])
  t.truthy(rejetSeries)
  t.deepEqual(rejetSeries.data, [{date: '2025-08-31', value: 7}])
})

test('extractGidaf - unknown point type defaults to prelevement', async t => {
  const cadresBuffer = createWorkbookBuffer([
    ['Code Inspection', 'Point de surveillance', 'SIRET', 'Raison sociale'],
    ['0001', 'Point sans type', '12345678901234', 'Usine A']
  ])

  const prelevementsBuffer = createWorkbookBuffer([
    ['Code Inspection', 'Point de surveillance', 'Date de mesure', 'Volume (m3)'],
    ['0001', 'Point sans type', '31/08/2025', 42]
  ])

  const {errors, data} = await extractGidaf(cadresBuffer, prelevementsBuffer)
  const criticalErrors = errors.filter(e => e.severity === 'error')
  t.is(criticalErrors.length, 0, `Erreurs critiques: ${JSON.stringify(criticalErrors)}`)
  t.true(errors.some(e => e.severity === 'warning' && e.message.includes('volume prélevé')))

  const prelevementSeries = data.series.find(serie =>
    serie.pointPrelevement === 'Point sans type' && serie.parameter === 'volume prélevé'
  )
  const rejetSeries = data.series.find(serie =>
    serie.pointPrelevement === 'Point sans type' && serie.parameter === 'volume rejeté'
  )

  t.truthy(prelevementSeries)
  t.deepEqual(prelevementSeries.data, [{date: '2025-08-31', value: 42}])
  t.falsy(rejetSeries)
})
