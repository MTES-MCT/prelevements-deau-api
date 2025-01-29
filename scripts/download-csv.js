import {createWriteStream, existsSync, mkdirSync} from 'node:fs'
import process from 'node:process'
import {join, dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {finished} from 'node:stream/promises'

import got from 'got'

import 'dotenv/config'

const {SCALINGO_CSV_URL, SCALINGO_CSV_TOKEN} = process.env

const urls = [
  `${SCALINGO_CSV_URL}${SCALINGO_CSV_TOKEN}/beneficiaire.csv`,
  `${SCALINGO_CSV_URL}${SCALINGO_CSV_TOKEN}/document.csv`,
  `${SCALINGO_CSV_URL}${SCALINGO_CSV_TOKEN}/exploitation-regle.csv`,
  `${SCALINGO_CSV_URL}${SCALINGO_CSV_TOKEN}/exploitation.csv`,
  `${SCALINGO_CSV_URL}${SCALINGO_CSV_TOKEN}/point-prelevement.csv`,
  `${SCALINGO_CSV_URL}${SCALINGO_CSV_TOKEN}/regle.csv`,
  `${SCALINGO_CSV_URL}${SCALINGO_CSV_TOKEN}/exploitation-usage.csv`,
  `${SCALINGO_CSV_URL}${SCALINGO_CSV_TOKEN}/modalite-suivi.csv`,
  `${SCALINGO_CSV_URL}${SCALINGO_CSV_TOKEN}/exploitation-modalite-suivi.csv`,
  `${SCALINGO_CSV_URL}${SCALINGO_CSV_TOKEN}/exploitation-serie.csv`,
  `${SCALINGO_CSV_URL}${SCALINGO_CSV_TOKEN}/serie-donnees.csv`,
  `${SCALINGO_CSV_URL}${SCALINGO_CSV_TOKEN}/resultat-suivi.csv`
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

    console.log(`Téléchargement terminé: ${filePath}`)

    return filePath
  } catch (error) {
    console.error(`Échec du téléchargement de ${filename}:`, error.message)
    throw error
  }
}

try {
  Promise.all(urls.map(url => downloadFile(url, url.split('/').pop())))
} catch (error) {
  console.error('Échec du téléchargement:', error.message)
}
