/* eslint-disable n/prefer-global/process */
/* eslint-disable unicorn/no-process-exit */

import {argv} from 'node:process'
import mongo from '../lib/util/mongo.js'
import {
  BSS_DEFINITION,
  BNPE_DEFINITION,
  LIBELLES_DEFINITION,
  ME_CONTINENTALES_BV_DEFINITION,
  BV_BDCARTHAGE_DEFINITION,
  MESO_DEFINITION
} from '../lib/models/internal/in-memory.js'
import {readDataFromCsvFile} from '../lib/util/csv.js'

async function importBss(filePath) {
  const bss = await readDataFromCsvFile(
    `${filePath}/bss.csv`,
    BSS_DEFINITION
  )

  const result = await mongo.db.collection('bss').insertMany(bss)

  console.log('\u001B[32;1m%s\u001B[0m', '\n=> ' + result.insertedCount + ' documents insérés dans la collection bss\n\n')
}

async function importBnpe(filePath) {
  const bnpe = await readDataFromCsvFile(
    `${filePath}/bnpe.csv`,
    BNPE_DEFINITION
  )

  const result = await mongo.db.collection('bnpe').insertMany(bnpe)

  console.log('\u001B[32;1m%s\u001B[0m', '\n=> ' + result.insertedCount + ' documents insérés dans la collection bnpe\n\n')
}

async function importLibellesCommunes(filePath) {
  const communes = await readDataFromCsvFile(
    `${filePath}/commune.csv`,
    LIBELLES_DEFINITION
  )

  const result = await mongo.db.collection('communes').insertMany(communes)

  console.log('\u001B[32;1m%s\u001B[0m', '\n=> ' + result.insertedCount + ' documents insérés dans la collection communes\n\n')
}

async function importMeContinentalesBV(filePath) {
  const meContinentalesBv = await readDataFromCsvFile(
    `${filePath}/me-continentales-bv.csv`,
    ME_CONTINENTALES_BV_DEFINITION
  )

  const result = await mongo.db.collection('me_continentales_bv').insertMany(meContinentalesBv)

  console.log('\u001B[32;1m%s\u001B[0m', '\n=> ' + result.insertedCount + ' documents insérés dans la collection me_continentales_bv\n\n')
}

async function importBvBdCarthage(filePath) {
  const bvBdCarthage = await readDataFromCsvFile(
    `${filePath}/bv-bdcarthage.csv`,
    BV_BDCARTHAGE_DEFINITION
  )

  const result = await mongo.db.collection('bv_bdcarthage').insertMany(bvBdCarthage)

  console.log('\u001B[32;1m%s\u001B[0m', '\n=> ' + result.insertedCount + ' documents insérés dans la collection bv_bdcarthage\n\n')
}

async function importMeso(filePath) {
  const meso = await readDataFromCsvFile(
    `${filePath}/meso.csv`,
    MESO_DEFINITION
  )

  const result = await mongo.db.collection('meso').insertMany(meso)

  console.log('\u001B[32;1m%s\u001B[0m', '\n=> ' + result.insertedCount + ' documents insérés dans la collection meso\n\n')
}

async function importReferentiel(folderPath) {
  if (!folderPath) {
    console.error(
      '\u001B[41m\u001B[30m%s\u001B[0m',
      'Vous devez renseigner le chemin du fichier à importer \nExemple : yarn referentiel-import /data/reunion'
    )

    process.exit(1)
  }

  console.log('\n\u001B[35;1;4m%s\u001B[0m', '=> Importation des données référentielles')

  await mongo.connect()

  await importBss(folderPath)
  await importBnpe(folderPath)
  await importLibellesCommunes(folderPath)
  await importMeContinentalesBV(folderPath)
  await importBvBdCarthage(folderPath)
  await importMeso(folderPath)

  await mongo.disconnect()
}

const folderPath = argv[2]

await importReferentiel(folderPath)
