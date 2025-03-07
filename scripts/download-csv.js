#!/usr/bin/env node

import 'dotenv/config'

import path from 'node:path'
import {createWriteStream} from 'node:fs'
import {mkdir} from 'node:fs/promises'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {pipeline} from 'node:stream/promises'

import got from 'got'

const {CSV_SOURCE_URL} = process.env

const filenames = [
  'beneficiaire-email.csv',
  'document.csv',
  'exploitation-regle.csv',
  'exploitation.csv',
  'point-prelevement.csv',
  'regle.csv',
  'exploitation-usage.csv',
  'modalite-suivi.csv',
  'exploitation-modalite-suivi.csv',
  'exploitation-serie.csv',
  'serie-donnees.csv',
  'resultat-suivi.csv',
  'bnpe.csv',
  'bss.csv',
  'commune.csv',
  'exploitation-document.csv',
  'me-continentales-bv.csv',
  'bv-bdcarthage.csv',
  'meso.csv'
]

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(__dirname, '..', 'data')

await mkdir(dataDir, {recursive: true})

async function downloadFile(url, filename) {
  const filePath = path.join(dataDir, filename)
  const fileStream = createWriteStream(filePath)

  await pipeline(
    got.stream(url),
    fileStream
  )

  console.log(`Téléchargement terminé : ${filePath}`)
}

try {
  Promise.all(
    filenames.map(filename => downloadFile(`${CSV_SOURCE_URL}/${filename}`, filename))
  )
} catch (error) {
  console.error('Échec du téléchargement :', error.message)
  process.exit(1)
}
