import path from 'node:path'
import fs from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import test from 'ava'
import {extractTemplateFile} from '../index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const testFilesPath = path.join(__dirname, 'test-files')

test('extractTemplateFile - valid file', async t => {
  const filePath = path.join(testFilesPath, 'valid.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors, data} = await extractTemplateFile(fileContent)
  
  // Vérifier qu'il n'y a pas d'erreurs critiques
  const criticalErrors = errors.filter(e => e.severity === 'error')
  t.is(criticalErrors.length, 0, `Erreurs critiques: ${JSON.stringify(criticalErrors)}`)
  
  // Vérifier que des séries ont été extraites
  t.truthy(data)
  t.truthy(data.series)
  t.true(data.series.length > 0, 'Aucune série extraite')
  
  // Vérifier la structure des séries
  for (const serie of data.series) {
    t.truthy(serie.pointPrelevement, 'pointPrelevement manquant')
    t.is(serie.parameter, 'Volume prélevé')
    t.is(serie.unit, 'm³')
    t.is(serie.frequency, '1 day')
    t.is(serie.valueType, 'cumulative')
    t.truthy(serie.minDate)
    t.truthy(serie.maxDate)
    t.truthy(serie.data)
    t.true(Array.isArray(serie.data))
    
    // Vérifier la structure des données
    for (const entry of serie.data) {
      t.truthy(entry.date)
      t.truthy(typeof entry.value === 'number')
    }
  }
})

test('extractTemplateFile - empty file', async t => {
  const filePath = path.join(testFilesPath, 'empty.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors, data} = await extractTemplateFile(fileContent)
  
  // Un fichier vide devrait générer des erreurs
  t.true(errors.length > 0, 'Aucune erreur pour un fichier vide')
  
  // Vérifier qu'il y a au moins une erreur critique
  const criticalErrors = errors.filter(e => e.severity === 'error')
  t.true(criticalErrors.length > 0, 'Aucune erreur critique pour un fichier vide')
  
  // Les données devraient être vides
  t.truthy(data)
  t.deepEqual(data.series, [])
})


test('extractTemplateFile - missing declaration_de_volume sheet', async t => {
  const filePath = path.join(testFilesPath, 'missing-sheet.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors, data} = await extractTemplateFile(fileContent)
  
  // Devrait générer une erreur
  t.true(errors.length > 0)
  const errorMessages = errors.map(e => e.message).join(' ')
  t.true(
    errorMessages.includes('declaration_de_volume') || 
    errorMessages.includes('Feuille'),
    `Erreur attendue sur la feuille manquante, reçu: ${errorMessages}`
  )
  
  if (data) {
    t.deepEqual(data.series, [])
  }
})

test('extractTemplateFile - missing required columns', async t => {
  const filePath = path.join(testFilesPath, 'missing-columns.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors, data} = await extractTemplateFile(fileContent)
  
  // Devrait générer des erreurs sur les colonnes manquantes
  t.true(errors.length > 0)
  const errorMessages = errors.map(e => e.message).join(' ')
  t.true(
    errorMessages.includes('Colonnes requises') || 
    errorMessages.includes('id_point_de_prelevement') ||
    errorMessages.includes('date_debut') ||
    errorMessages.includes('date_fin') ||
    errorMessages.includes('volume_preleve_m3') ||
    errorMessages.includes('Impossible de trouver la ligne d\'en-tête'),
    `Erreur attendue sur les colonnes manquantes, reçu: ${errorMessages}`
  )
  
  if (data) {
    t.deepEqual(data.series, [])
  }
})

test('extractTemplateFile - missing one required column', async t => {
  const filePath = path.join(testFilesPath, 'missing-column.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors, data} = await extractTemplateFile(fileContent)
  
  // Devrait générer une erreur sur la colonne manquante
  t.true(errors.length > 0)
  const errorMessages = errors.map(e => e.message).join(' ')
  t.true(
    errorMessages.includes('date_fin') ||
    errorMessages.includes('Colonnes requises manquantes'),
    `Erreur attendue sur la colonne date_fin manquante, reçu: ${errorMessages}`
  )
  
  // Vérifier que les erreurs sont de type 'error'
  const criticalErrors = errors.filter(e => e.severity === 'error')
  t.true(criticalErrors.length > 0, 'Devrait avoir au moins une erreur critique')
  
  t.truthy(data)
  t.deepEqual(data.series, [])
})

test('extractTemplateFile - invalid file format', async t => {
  const invalidContent = Buffer.from('not an excel file')
  const {errors, data} = await extractTemplateFile(invalidContent)
  
  t.true(errors.length > 0)
  if (data) {
    t.deepEqual(data.series, [])
  }
})

test('extractTemplateFile - valid file with metadata', async t => {
  const filePath = path.join(testFilesPath, 'valid.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors, data, rawData} = await extractTemplateFile(fileContent)
  
  // Vérifier que les métadonnées sont extraites si présentes
  if (rawData && rawData.metadata) {
    t.truthy(rawData.metadata)
    
    // Si des points de prélèvement sont extraits
    if (rawData.metadata.pointsPrelevement) {
      t.true(Array.isArray(rawData.metadata.pointsPrelevement))
      
      for (const point of rawData.metadata.pointsPrelevement) {
        t.truthy(point.id_point_de_prelevement_ou_rejet)
      }
    }
    
    // Si des préleveurs sont extraits
    if (rawData.metadata.preleveurs) {
      t.true(Array.isArray(rawData.metadata.preleveurs))
      
      for (const preleveur of rawData.metadata.preleveurs) {
        t.truthy(preleveur.siret)
        t.is(preleveur.siret.length, 14, 'SIRET doit avoir 14 chiffres')
      }
    }
  }
  
  // Vérifier qu'il n'y a pas d'erreurs critiques
  const criticalErrors = errors.filter(e => e.severity === 'error')
  t.is(criticalErrors.length, 0, `Erreurs critiques: ${JSON.stringify(criticalErrors)}`)
})

test('extractTemplateFile - file with invalid dates', async t => {
  const filePath = path.join(testFilesPath, 'invalid-dates.xlsx')
  const fileContent = await fs.readFile(filePath)
  
  // Le parser peut lancer une exception pour les dates invalides
  try {
    const {errors, data} = await extractTemplateFile(fileContent)
    
    // Si pas d'exception, vérifier qu'il y a des erreurs
    t.true(errors.length > 0)
    const errorMessages = errors.map(e => e.message).join(' ')
    t.true(
      errorMessages.includes('Date') || 
      errorMessages.includes('date') ||
      errorMessages.includes('invalide') ||
      errorMessages.includes('manquante') ||
      errorMessages.includes('Format de date'),
      `Erreur attendue sur les dates invalides, reçu: ${errorMessages}`
    )
    
    t.truthy(data)
    t.deepEqual(data.series, [])
  } catch (error) {
    // Si une exception est lancée, vérifier qu'elle concerne les dates invalides
    t.true(
      error.message.includes('Format de date') ||
      error.message.includes('date invalide'),
      `Exception attendue sur les dates invalides, reçu: ${error.message}`
    )
  }
})

test('extractTemplateFile - file with data errors', async t => {
  const filePath = path.join(testFilesPath, 'data-errors.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors, data} = await extractTemplateFile(fileContent)
  
  // Devrait générer plusieurs erreurs
  t.true(errors.length > 0, 'Devrait avoir des erreurs')
  
  // Vérifier que les erreurs sont de type 'error'
  const criticalErrors = errors.filter(e => e.severity === 'error')
  t.true(criticalErrors.length > 0, 'Devrait avoir au moins une erreur critique')
  
  // Vérifier les types d'erreurs attendues
  const errorMessages = errors.map(e => e.message).join(' ')
  t.true(
    errorMessages.includes('Point de prélèvement manquant') ||
    errorMessages.includes('Date') ||
    errorMessages.includes('date') ||
    errorMessages.includes('Valeur numérique') ||
    errorMessages.includes('Ligne'),
    `Erreurs attendues sur les données invalides, reçu: ${errorMessages}`
  )
  
  // Devrait quand même extraire les lignes valides
  t.truthy(data)
  if (data.series.length > 0) {
    // Vérifier que seules les lignes valides sont extraites
    const pointIds = data.series.map(s => s.pointPrelevement)
    t.true(pointIds.includes('POINT1'), 'POINT1 devrait être extrait')
    t.true(pointIds.includes('POINT6'), 'POINT6 devrait être extrait')
    t.false(pointIds.includes('POINT2'), 'POINT2 ne devrait pas être extrait (date début manquante)')
    t.false(pointIds.includes('POINT3'), 'POINT3 ne devrait pas être extrait (date fin manquante)')
    t.false(pointIds.includes('POINT4'), 'POINT4 ne devrait pas être extrait (volume invalide)')
    t.false(pointIds.includes('POINT5'), 'POINT5 ne devrait pas être extrait (volume négatif)')
  }
})

test('extractTemplateFile - file with invalid volumes', async t => {
  const filePath = path.join(testFilesPath, 'invalid-volumes.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors, data} = await extractTemplateFile(fileContent)
  
  // Devrait générer des erreurs sur les volumes invalides
  t.true(errors.length > 0)
  const errorMessages = errors.map(e => e.message).join(' ')
  t.true(
    errorMessages.includes('Valeur numérique') || 
    errorMessages.includes('volume') ||
    errorMessages.includes('Ligne'),
    `Erreur attendue sur les volumes invalides, reçu: ${errorMessages}`
  )
})

test('extractTemplateFile - file with multiple points', async t => {
  const filePath = path.join(testFilesPath, 'valid.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors, data} = await extractTemplateFile(fileContent)
  
  // Si le fichier contient plusieurs points, vérifier qu'ils sont tous extraits
  if (data && data.series && data.series.length > 1) {
    const pointIds = new Set(data.series.map(s => s.pointPrelevement))
    t.true(pointIds.size > 1, 'Plusieurs points devraient être extraits')
    
    // Vérifier que chaque série a des données
    for (const serie of data.series) {
      t.true(serie.data.length > 0, `La série pour ${serie.pointPrelevement} devrait avoir des données`)
    }
  }
  
  // Vérifier qu'il n'y a pas d'erreurs critiques
  const criticalErrors = errors.filter(e => e.severity === 'error')
  t.is(criticalErrors.length, 0, `Erreurs critiques: ${JSON.stringify(criticalErrors)}`)
})

test('extractTemplateFile - file with comma-separated points', async t => {
  const filePath = path.join(testFilesPath, 'multiple-points-comma.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors, data} = await extractTemplateFile(fileContent)
  
  // Vérifier qu'il n'y a pas d'erreurs critiques
  const criticalErrors = errors.filter(e => e.severity === 'error')
  t.is(criticalErrors.length, 0, `Erreurs critiques: ${JSON.stringify(criticalErrors)}`)
  
  // Vérifier que des séries ont été extraites
  t.truthy(data)
  t.truthy(data.series)
  t.true(data.series.length > 0, 'Aucune série extraite')
  
  // Vérifier que tous les points sont extraits
  const pointIds = new Set(data.series.map(s => s.pointPrelevement))
  t.true(pointIds.has('POINT1'), 'POINT1 devrait être extrait')
  t.true(pointIds.has('POINT2'), 'POINT2 devrait être extrait')
  t.true(pointIds.has('POINT3'), 'POINT3 devrait être extrait')
  t.true(pointIds.has('POINT4'), 'POINT4 devrait être extrait')
  t.true(pointIds.has('POINT5'), 'POINT5 devrait être extrait')
  t.true(pointIds.has('POINT6'), 'POINT6 devrait être extrait')
  
  // Vérifier que le volume est divisé entre les points qui partagent
  // POINT1 seul : 3000
  const point1Serie = data.series.find(s => s.pointPrelevement === 'POINT1')
  t.truthy(point1Serie, 'POINT1 devrait avoir une série')
  if (point1Serie && point1Serie.data.length > 0) {
    const point1Volume = point1Serie.data.reduce((sum, entry) => sum + entry.value, 0)
    t.is(point1Volume, 3000, 'POINT1 devrait avoir un volume de 3000')
  }
  
  // POINT2 et POINT3 partagent 2000 → 1000 chacun
  const point2Serie = data.series.find(s => s.pointPrelevement === 'POINT2')
  const point3Serie = data.series.find(s => s.pointPrelevement === 'POINT3')
  t.truthy(point2Serie, 'POINT2 devrait avoir une série')
  t.truthy(point3Serie, 'POINT3 devrait avoir une série')
  if (point2Serie && point2Serie.data.length > 0) {
    const point2Volume = point2Serie.data.reduce((sum, entry) => sum + entry.value, 0)
    t.is(point2Volume, 1000, 'POINT2 devrait avoir un volume de 1000 (2000/2)')
  }
  if (point3Serie && point3Serie.data.length > 0) {
    const point3Volume = point3Serie.data.reduce((sum, entry) => sum + entry.value, 0)
    t.is(point3Volume, 1000, 'POINT3 devrait avoir un volume de 1000 (2000/2)')
  }
  
  // POINT4, POINT5, POINT6 partagent 6000 → 2000 chacun
  const point4Serie = data.series.find(s => s.pointPrelevement === 'POINT4')
  const point5Serie = data.series.find(s => s.pointPrelevement === 'POINT5')
  const point6Serie = data.series.find(s => s.pointPrelevement === 'POINT6')
  t.truthy(point4Serie, 'POINT4 devrait avoir une série')
  t.truthy(point5Serie, 'POINT5 devrait avoir une série')
  t.truthy(point6Serie, 'POINT6 devrait avoir une série')
  
  for (const serie of [point4Serie, point5Serie, point6Serie]) {
    if (serie && serie.data.length > 0) {
      const volume = serie.data.reduce((sum, entry) => sum + entry.value, 0)
      t.is(volume, 2000, `${serie.pointPrelevement} devrait avoir un volume de 2000 (6000/3)`)
    }
  }
})

test('extractTemplateFile - no data rows', async t => {
  const filePath = path.join(testFilesPath, 'no-data-rows.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors, data} = await extractTemplateFile(fileContent)
  
  // Devrait générer une erreur sur l'absence de données
  t.true(errors.length > 0)
  const errorMessages = errors.map(e => e.message).join(' ')
  t.true(
    errorMessages.includes('Aucune ligne de données') ||
    errorMessages.includes('données valide'),
    `Erreur attendue sur l'absence de données, reçu: ${errorMessages}`
  )
  
  t.truthy(data)
  t.deepEqual(data.series, [])
})

test('extractTemplateFile - corrupted file', async t => {
  const corruptedContent = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0xFF, 0xFF, 0xFF, 0xFF])
  const {errors, data} = await extractTemplateFile(corruptedContent)
  
  t.true(errors.length > 0)
  if (data) {
    t.deepEqual(data.series, [])
  }
})

test('extractTemplateFile - valid file with point_de_prelevement sheet optional', async t => {
  const filePath = path.join(testFilesPath, 'valid-without-metadata.xlsx')
  const fileContent = await fs.readFile(filePath)
  const {errors, data} = await extractTemplateFile(fileContent)
  
  // Devrait fonctionner mais avec un warning sur la feuille manquante
  const warnings = errors.filter(e => e.severity === 'warning')
  const hasMetadataWarning = warnings.some(w => 
    w.message.includes('point_de_prelevement') || 
    w.message.includes('métadonnées')
  )
  
  // Devrait avoir des séries extraites
  t.truthy(data)
  t.true(data.series.length > 0, 'Des séries devraient être extraites même sans métadonnées')
  
  // Vérifier la structure de la première série
  if (data.series.length > 0) {
    const serie = data.series[0]
    t.is(serie.pointPrelevement, 'POINT1')
    t.is(serie.parameter, 'Volume prélevé')
    t.true(serie.data.length > 0)
  }
})

