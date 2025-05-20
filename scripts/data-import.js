/* eslint-disable n/prefer-global/process */
/* eslint-disable unicorn/no-process-exit */

import {argv} from 'node:process'
import mongo from '../lib/util/mongo.js'
import {readDataFromCsvFile} from '../lib/util/csv.js'
import {
  POINTS_PRELEVEMENT_DEFINITION,
  EXPLOITATIONS_DEFINITION,
  PRELEVEURS_DEFINITION
} from '../lib/models/internal/in-memory.js'
import {
  getDocumentFromExploitationId,
  getModalitesFromExploitationId,
  getReglesFromExploitationId
} from '../lib/models/exploitation.js'

function parseAutresNoms(autresNoms) {
  if (!autresNoms) {
    return null
  }

  const cleanedStr = autresNoms.replaceAll(/[{}"]/g, '')
  const result = [...new Set(cleanedStr.split(','))].join(', ')

  return result
}

async function preparePoint(point, codeTerritoire) {
  const pointToInsert = point

  pointToInsert.autresNoms = parseAutresNoms(point.autres_noms)
  delete pointToInsert.autres_noms

  if (point.id_bss) {
    pointToInsert.bss = await mongo.db.collection('bss').findOne({id_bss: point.id_bss})
    delete pointToInsert.id_bss
  }

  if (point.code_bnpe) {
    pointToInsert.bnpe = await mongo.db.collection('bnpe').findOne({code_point_prelevement: point.code_bnpe})
    delete pointToInsert.code_bnpe
  }

  if (point.code_meso) {
    pointToInsert.meso = await mongo.db.collection('meso').findOne({code: point.code_meso})
    delete pointToInsert.code_meso
  }

  if (point.meContinentalesBv) {
    pointToInsert.meContinentalesBv = await mongo.db.collection('meContinentalesBv').findOne({code_dce: point.code_dce})
  }

  if (point.bvBdCarthage) {
    pointToInsert.bvBdCarthage = await mongo.db.collection('bvBdCarthage').findOne({code_cours: point.code_cours})
  }

  if (point.insee_com) {
    pointToInsert.commune = point.insee_com
    delete pointToInsert.insee_com
  }

  pointToInsert.territoire = codeTerritoire
  pointToInsert.createdAt = new Date()
  pointToInsert.updatedAt = new Date()

  return pointToInsert
}

async function prepareExploitation(exploitation, codeTerritoire) {
  const exploitationToInsert = exploitation

  if (exploitation.id_beneficiaire) {
    exploitationToInsert.id_preleveur = exploitation.id_beneficiaire
    delete exploitationToInsert.id_beneficiaire
  }

  exploitationToInsert.regles = await getReglesFromExploitationId(exploitation.id_exploitation)
  exploitationToInsert.documents = await getDocumentFromExploitationId(exploitation.id_exploitation)
  exploitationToInsert.modalites = await getModalitesFromExploitationId(exploitation.id_exploitation)

  delete exploitationToInsert.usage

  exploitationToInsert.territoire = codeTerritoire
  exploitationToInsert.createdAt = new Date()
  exploitationToInsert.updatedAt = new Date()

  return exploitationToInsert
}

async function preparePreleveur(preleveur, codeTerritoire) {
  const preleveurToInsert = preleveur

  if (preleveur.id_beneficiaire) {
    preleveurToInsert.id_preleveur = preleveur.id_beneficiaire
    delete preleveurToInsert.id_beneficiaire
  }

  preleveurToInsert.territoire = codeTerritoire
  preleveurToInsert.createdAt = new Date()
  preleveurToInsert.updatedAt = new Date()

  return preleveurToInsert
}

async function importPoints(folderPath, codeTerritoire, nomTerritoire) {
  try {
    const points = await readDataFromCsvFile(folderPath + '/points-prelevement.csv', POINTS_PRELEVEMENT_DEFINITION)
    console.log('\n\u001B[35;1;4m%s\u001B[0m', '=> Importation des données points_prelevement pour : ' + nomTerritoire)

    const pointsToInsert = await Promise.all(points.map(point => preparePoint(point, codeTerritoire)))
    const result = await mongo.db.collection('points_prelevement').insertMany(pointsToInsert)

    console.log('\u001B[32;1m%s\u001B[0m', '\n=> ' + result.insertedCount + ' documents insérés dans la collection points_prelevement\n\n')
  } catch (error) {
    console.error(
      '\u001B[41m\u001B[30m%s\u001B[0m',
      'Erreur : ' + error.message
    )
  }
}

async function importExploitations(folderPath, codeTerritoire, nomTerritoire) {
  try {
    const exploitations = await readDataFromCsvFile(folderPath + '/exploitations.csv', EXPLOITATIONS_DEFINITION)
    console.log('\n\u001B[35;1;4m%s\u001B[0m', '=> Importation des données exploitations pour : ' + nomTerritoire)

    const exploitationsToInsert = await Promise.all(exploitations.map(exploitation => prepareExploitation(exploitation, codeTerritoire)))
    const result = await mongo.db.collection('exploitations').insertMany(exploitationsToInsert)
    console.log('\u001B[32;1m%s\u001B[0m', '\n=> ' + result.insertedCount + ' documents insérés dans la collection exploitations\n\n')
  } catch (error) {
    console.error(
      '\u001B[41m\u001B[30m%s\u001B[0m',
      'Erreur : ' + error.message
    )
  }
}

async function importPreleveurs(folderPath, codeTerritoire, nomTerritoire) {
  try {
    const preleveurs = await readDataFromCsvFile(folderPath + '/preleveurs.csv', PRELEVEURS_DEFINITION)
    console.log('\n\u001B[35;1;4m%s\u001B[0m', '=> Importation des données preleveurs pour : ' + nomTerritoire)

    const preleveursToInsert = await Promise.all(preleveurs.map(preleveur => preparePreleveur(preleveur, codeTerritoire)))
    const result = await mongo.db.collection('preleveurs').insertMany(preleveursToInsert)
    console.log('\u001B[32;1m%s\u001B[0m', '\n=> ' + result.insertedCount + ' documents insérés dans la collection preleveurs\n\n')
  } catch (error) {
    console.error(
      '\u001B[41m\u001B[30m%s\u001B[0m',
      'Erreur : ' + error.message
    )
  }
}

async function importData(folderPath, codeTerritoire) {
  if (!codeTerritoire) {
    console.error(
      '\u001B[41m\u001B[30m%s\u001B[0m',
      'Vous devez renseigner l’id du territoire à importer. \nExemple : yarn data-import DEP-974 /data/reunion'
    )

    process.exit(1)
  }

  if (!folderPath) {
    console.error(
      '\u001B[41m\u001B[30m%s\u001B[0m',
      'Vous devez renseigner le chemin du fichier à importer \nExemple : yarn data-import DEP-974 /data/reunion'
    )

    process.exit(1)
  }

  await mongo.connect()

  const validTerritoire = await mongo.db.collection('territoires').findOne({code: codeTerritoire})

  if (!validTerritoire) {
    console.error(
      '\u001B[41m\u001B[30m%s\u001B[0m',
      'Ce territoire est inconnu.'
    )

    await mongo.disconnect()

    process.exit(1)
  }

  await importPoints(folderPath, codeTerritoire, validTerritoire.nom)
  await importExploitations(folderPath, codeTerritoire, validTerritoire.nom)
  await importPreleveurs(folderPath, codeTerritoire, validTerritoire.nom)

  await mongo.disconnect()
}

const codeTerritoire = argv[2]
const folderPath = argv[3]

await importData(folderPath, codeTerritoire)
