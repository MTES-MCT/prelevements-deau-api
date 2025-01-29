import 'dotenv/config'
import {createWriteStream} from 'node:fs'
import {mkdir} from 'node:fs/promises'
import process from 'node:process'
import {join, dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {pipeline} from 'node:stream/promises'

import got from 'got'

const {CSV_SOURCE} = process.env

const filenames = [
  'beneficiaire.csv',
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
  'resultat-suivi.csv'
]

const __dirname = dirname(fileURLToPath(import.meta.url))

await mkdir(join(__dirname, '../data'), {recursive: true})

const downloadFile = async (url, filename) => {
  const dataDir = join(__dirname, '../data')
  const filePath = join(dataDir, filename)

  const fileStream = createWriteStream(filePath)
  await pipeline(
    got.stream(url),
    fileStream
  )

  console.log(`Téléchargement terminé : ${filePath}`)

  return filePath
}

try {
  Promise.all(filenames.map(filename => downloadFile(`${CSV_SOURCE}/${filename}`, filename)))
} catch (error) {
  console.error('Échec du téléchargement :', error.message)
}
