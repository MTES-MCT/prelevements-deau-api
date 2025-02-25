import test from 'ava'
import fs from 'node:fs/promises'
import path from 'node:path'
import runCamionCiterneTests from '../suivi-camion-citerne.js'

test('runCamionCiterneTests avec un fichier Excel valide', async t => {
  // Chemin vers le fichier Excel de test
  const __dirname = path.dirname(new URL(import.meta.url).pathname)
  const fileName = 'valid.xlsx'
  const filePath = path.join(__dirname, 'test-files', 'suivi-camion-citerne', fileName)

  // Lecture du fichier Excel en tant que buffer
  const buffer = await fs.readFile(filePath)

  // Exécution de la fonction à tester
  const errors = await runCamionCiterneTests(buffer, fileName)

  // Vérification que des erreurs sont retournées
  t.true(errors.length === 0, 'Aucune erreur doit être retournée pour le fichier de test')
})

test('runCamionCiterneTests avec un fichier Excel sans donnée doit renvoyé une erreur', async t => {
  // Chemin vers le fichier Excel de test
  const __dirname = path.dirname(new URL(import.meta.url).pathname)
  const fileName = 'empty.xlsx'
  const filePath = path.join(__dirname, 'test-files', 'suivi-camion-citerne', fileName)

  // Lecture du fichier Excel en tant que buffer
  const buffer = await fs.readFile(filePath)

  // Exécution de la fonction à tester
  const errors = await runCamionCiterneTests(buffer, {})

  // Vérification que des erreurs sont retournées
  t.true(errors.length > 0, 'Des erreurs doivent être retournées pour le fichier de test')

  // Vérification que l'erreur spécifique est présente
  const expectedErrorMessage = 'Le fichier ne contient pas de données.'
  const errorMessages = errors.map(error => error.message)

  t.true(
    errorMessages.includes(expectedErrorMessage),
    `L'erreur attendue doit être présente : "${expectedErrorMessage}"`
  )
})

test('runCamionCiterneTests avec un fichier Excel avec une date invalide doit renvoyer une erreur', async t => {
  // Chemin vers le fichier Excel de test
  const __dirname = path.dirname(new URL(import.meta.url).pathname)
  const fileName = 'invalid-date.xlsx'
  const filePath = path.join(__dirname, 'test-files', 'suivi-camion-citerne', fileName)

  // Lecture du fichier Excel en tant que buffer
  const buffer = await fs.readFile(filePath)

  // Exécution de la fonction à tester
  const errors = await runCamionCiterneTests(buffer, {})

  // Vérification que des erreurs sont retournées
  t.true(errors.length > 0, 'Des erreurs doivent être retournées pour le fichier de test')

  // Vérification que l'erreur spécifique est présente
  const expectedErrorMessage = 'Ligne 4: Format de date invalide: 15 juillet 2000'
  const errorMessages = errors.map(error => error.message)

  t.true(
    errorMessages.includes(expectedErrorMessage),
    `L'erreur attendue doit être présente : "${expectedErrorMessage}"`
  )
})

test('runCamionCiterneTests avec un fichier Excel avec des valeurs invalide doit renvoyer une erreur', async t => {
  // Chemin vers le fichier Excel de test
  const __dirname = path.dirname(new URL(import.meta.url).pathname)
  const fileName = 'invalid-value.xlsx'
  const filePath = path.join(__dirname, 'test-files', 'suivi-camion-citerne', fileName)

  // Lecture du fichier Excel en tant que buffer
  const buffer = await fs.readFile(filePath)

  // Exécution de la fonction à tester
  const errors = await runCamionCiterneTests(buffer, {})

  // Vérification que des erreurs sont retournées
  t.true(errors.length > 0, 'Des erreurs doivent être retournées pour le fichier de test')

  // Vérification que l'erreur spécifique est présente
  const expectedErrorMessage = 'Ligne 4, Colonne 4: La valeur \'Invalid value\' doit être un nombre positif.'
  const errorMessages = errors.map(error => error.message)

  t.true(
    errorMessages.includes(expectedErrorMessage),
    `L'erreur attendue doit être présente : "${expectedErrorMessage}"`
  )
})

test('runCamionCiterneTests avec un fichier Excel valide, mais dont la période ne correspond pas à celle indiqué dans le formulaire doit renvoyer une erreur', async t => {
  // Chemin vers le fichier Excel de test
  const __dirname = path.dirname(new URL(import.meta.url).pathname)
  const fileName = 'valid.xlsx'
  const filePath = path.join(__dirname, 'test-files', 'suivi-camion-citerne', fileName)

  // Lecture du fichier Excel en tant que buffer
  const buffer = await fs.readFile(filePath)

  // Données du formulaire
  const formData = {
    date_debut: '2021-01-01',
    date_fin: '2021-12-31'
  }

  // Exécution de la fonction à tester
  const errors = await runCamionCiterneTests(buffer, formData)

  // Vérification que des erreurs sont retournées
  t.true(errors.length > 0, 'Des erreurs doivent être retournées pour le fichier de test')

  // Vérification que l'erreur spécifique est présente
  const expectedErrorMessage = 'Ligne 4: La date 1969-12-31 n\'est pas comprise entre le 2021-01-01 et le 2021-12-31 (période du formulaire).'
  const errorMessages = errors.map(error => error.message)

  t.deepEqual(
    errorMessages,
    [expectedErrorMessage]
  )
})

