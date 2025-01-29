import 'dotenv/config'
import {createWriteStream, existsSync, mkdirSync} from 'node:fs'
import process from 'node:process'
import {join, dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {finished} from 'node:stream/promises'

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

const downloadFile = async (url, filename) => {
  const dataDir = join(__dirname, '../data')

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir)
  }

  const filePath = join(dataDir, filename)

  try {
    const fileStream = createWriteStream(filePath)
    await got.stream(url).pipe(fileStream)

    await finished(fileStream)

    console.log(`Téléchargement terminé : ${filePath}`)

    return filePath
  } catch (error) {
    console.error(`Échec du téléchargement de ${filename} :`, error.message)
    throw error
  }
}

try {
  Promise.all(filenames.map(filename => downloadFile(`${CSV_SOURCE}/${filename}`, filename)))
} catch (error) {
  console.error('Échec du téléchargement :', error.message)
}
