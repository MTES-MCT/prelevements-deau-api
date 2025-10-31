/* eslint-disable n/prefer-global/process */
/* eslint-disable unicorn/no-process-exit */
import 'dotenv/config'
import {argv} from 'node:process'
import {keyBy} from 'lodash-es'
import mongo from '../lib/util/mongo.js'
import {
  BSS_DEFINITION,
  BNPE_DEFINITION,
  LIBELLES_DEFINITION,
  ME_CONTINENTALES_BV_DEFINITION,
  BV_BDCARTHAGE_DEFINITION,
  MESO_DEFINITION,
  OUVRAGE_BNPE_DEFINITION
} from '../lib/import/mapping.js'
import {readDataFromCsvFile} from '../lib/import/csv.js'

async function importBss(filePath) {
  const bss = await readDataFromCsvFile(
    `${filePath}/bss.csv`,
    BSS_DEFINITION,
    false
  )

  console.log('=> Nettoyage de la collection bss...')
  await mongo.db.collection('bss').deleteMany()
  console.log('...Ok !')

  if (bss.length > 0) {
    const result = await mongo.db.collection('bss').insertMany(bss)

    console.log(
      '\u001B[32;1m%s\u001B[0m',
      '\n=> ' + result.insertedCount + ' documents insérés dans la collection bss\n\n'
    )
  }
}

async function importBnpe(filePath) {
  const ouvrageBnpe = await readDataFromCsvFile(
    `${filePath}/ouvrage-bnpe.csv`,
    OUVRAGE_BNPE_DEFINITION,
    false
  )

  const ouvragesByKey = keyBy(ouvrageBnpe, 'code_point_referent')

  const bnpe = await readDataFromCsvFile(
    `${filePath}/bnpe.csv`,
    BNPE_DEFINITION,
    false
  )

  console.log('=> Nettoyage de la collection bnpe...')
  await mongo.db.collection('bnpe').deleteMany()
  console.log('...Ok !')

  if (bnpe.length > 0) {
    for (const b of bnpe) {
      b.nom_ouvrage = ouvragesByKey[b.code_point_prelevement]?.nom_ouvrage || 'Pas de nom renseigné'
    }

    const result = await mongo.db.collection('bnpe').insertMany(bnpe)

    console.log(
      '\u001B[32;1m%s\u001B[0m',
      '\n=> ' + result.insertedCount + ' documents insérés dans la collection bnpe\n\n'
    )
  }
}

async function importLibellesCommunes(filePath) {
  const communes = await readDataFromCsvFile(
    `${filePath}/commune.csv`,
    LIBELLES_DEFINITION,
    false
  )

  console.log('=> Nettoyage de la collection communes...')
  await mongo.db.collection('communes').deleteMany()
  console.log('...Ok !')

  if (communes.length > 0) {
    const result = await mongo.db.collection('communes').insertMany(communes)

    console.log(
      '\u001B[32;1m%s\u001B[0m',
      '\n=> ' + result.insertedCount + ' documents insérés dans la collection communes\n\n'
    )
  }
}

async function importMeContinentalesBV(filePath) {
  const meContinentalesBv = await readDataFromCsvFile(
    `${filePath}/me-continentales-bv.csv`,
    ME_CONTINENTALES_BV_DEFINITION,
    false
  )

  console.log('=> Nettoyage de la collection me_continentales_bv...')
  await mongo.db.collection('me_continentales_bv').deleteMany()
  console.log('...Ok !')

  if (meContinentalesBv.length > 0) {
    const result = await mongo.db.collection('me_continentales_bv').insertMany(meContinentalesBv)

    console.log(
      '\u001B[32;1m%s\u001B[0m',
      '\n=> ' + result.insertedCount + ' documents insérés dans la collection me_continentales_bv\n\n'
    )
  }
}

async function importBvBdCarthage(filePath) {
  const bvBdCarthage = await readDataFromCsvFile(
    `${filePath}/bv-bdcarthage.csv`,
    BV_BDCARTHAGE_DEFINITION,
    false
  )

  console.log('=> Nettoyage de la collection bv_bdcarthage...')
  await mongo.db.collection('bv_bdcarthage').deleteMany()
  console.log('...Ok !')

  if (bvBdCarthage.length > 0) {
    const result = await mongo.db.collection('bv_bdcarthage').insertMany(bvBdCarthage)

    console.log(
      '\u001B[32;1m%s\u001B[0m',
      '\n=> ' + result.insertedCount + ' documents insérés dans la collection bv_bdcarthage\n\n'
    )
  }
}

async function importMeso(filePath) {
  const meso = await readDataFromCsvFile(
    `${filePath}/meso.csv`,
    MESO_DEFINITION,
    false
  )

  console.log('=> Nettoyage de la collection meso...')
  await mongo.db.collection('meso').deleteMany()
  console.log('...Ok !')

  if (meso.length > 0) {
    const result = await mongo.db.collection('meso').insertMany(meso)

    console.log(
      '\u001B[32;1m%s\u001B[0m',
      '\n=> ' + result.insertedCount + ' documents insérés dans la collection meso\n\n'
    )
  }
}

async function importReferentiel(folderPath) {
  if (!folderPath) {
    console.error(
      '\u001B[41m\u001B[30m%s\u001B[0m',
      'Vous devez renseigner le chemin du fichier à importer \nExemple : npm run import-reference-data /data/reunion'
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
