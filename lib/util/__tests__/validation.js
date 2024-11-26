import test from 'ava'
import fs from 'node:fs'
import path from 'node:path'
import {analyzeFile} from '../demarches-simplifies/validation.js'

const __dirname = path.dirname(new URL(import.meta.url).pathname)

test('analyzeFile avec un fichier Excel valide (xlsx) doit réussir', async t => {
  const filePath = path.join(__dirname, 'test-files', 'valid.xlsx')
  const buffer = fs.readFileSync(filePath)

  const result = await analyzeFile(buffer)

  t.falsy(result.message, 'La fonction doit réussir pour un fichier Excel valide')
  t.truthy(result.workbook, 'Le workbook doit être défini')
})

test('analyzeFile avec un fichier Excel valide (xls) doit réussir', async t => {
  const filePath = path.join(__dirname, 'test-files', 'valid.xls')
  const buffer = fs.readFileSync(filePath)

  const result = await analyzeFile(buffer)

  t.falsy(result.message, 'La fonction doit réussir pour un fichier Excel valide')
  t.truthy(result.workbook, 'Le workbook doit être défini')
})

test('analyzeFile avec un fichier ODS valide doit réussir', async t => {
  const filePath = path.join(__dirname, 'test-files', 'valid.ods')
  const buffer = fs.readFileSync(filePath)

  const result = await analyzeFile(buffer)

  t.falsy(result.message, 'La fonction doit réussir pour un fichier Excel valide')
  t.truthy(result.workbook, 'Le workbook doit être défini')
})

test('analyzeFile avec un fichier non autorisé doit échouer', async t => {
  const filePath = path.join(__dirname, 'test-files', 'invalid.txt')
  const buffer = fs.readFileSync(filePath)

  const result = await analyzeFile(buffer)

  t.falsy(result.workbook, 'La fonction doit échouer pour un fichier non autorisé')
  t.truthy(result.message, 'Une erreur doit être retournée')
  t.is(result.destinataire, 'déclarant', 'Le destinataire doit être "déclarant"')
  t.regex(result.message, /doit être au format xls, xlsx ou ods/, 'Le message doit indiquer que le format est incorrect')
})

test('analyzeFile avec un buffer vide doit échouer', async t => {
  const buffer = Buffer.alloc(0)

  const result = await analyzeFile(buffer)

  t.falsy(result.workbook, 'La fonction doit échouer pour un buffer vide')
  t.truthy(result.message, 'Une erreur doit être retournée')
  t.is(result.destinataire, 'déclarant', 'Le destinataire doit être "déclarant" ou "administrateur" en fonction de votre gestion')
  t.regex(result.message, /doit être au format xls, xlsx ou ods/, 'Le message doit indiquer que le format est incorrect')
})
