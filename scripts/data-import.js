/* eslint-disable n/prefer-global/process */
/* eslint-disable unicorn/no-process-exit */

import {argv} from 'node:process'
import mongo from '../lib/util/mongo.js'
import {readDataFromCsvFile, parseNomenclature} from '../lib/util/csv.js'
import {usages} from '../lib/nomenclature.js'
import {
  indexedLibellesCommunes,
  REGLES_DEFINITION,
  DOCUMENTS_DEFINITION,
  MODALITES_DEFINITION,
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
    const bss = await mongo.db.collection('bss').findOne({id_bss: point.id_bss})

    pointToInsert.bss = {
      id_bss: bss.id_bss,
      lien: bss.lien_infoterre
    }
  } else {
    pointToInsert.bss = null
  }

  delete pointToInsert.id_bss

  if (point.code_bnpe) {
    const bnpe = await mongo.db.collection('bnpe').findOne({code_point_prelevement: point.code_bnpe})

    pointToInsert.bnpe = {
      point: bnpe.code_point_prelevement,
      lien: bnpe.uri_ouvrage
    }
  } else {
    pointToInsert.bnpe = null
  }

  delete pointToInsert.code_bnpe

  if (point.meso) {
    const meso = await mongo.db.collection('meso').findOne({code: point.code_meso})

    pointToInsert.meso = {
      code: meso.code,
      nom: meso.nom_provis
    }
  } else {
    pointToInsert.meso = null
  }

  delete pointToInsert.code_meso

  if (point.me_continentales_bv) {
    const meContinentalesBv = await mongo.db.collection('me_continentales_bv').findOne({code_dce: point.code_me_continentales_bv})

    pointToInsert.meContinentalesBv = {
      code: meContinentalesBv.code_dce,
      nom: meContinentalesBv.nom
    }
  } else {
    pointToInsert.meContinentalesBv = null
  }

  delete pointToInsert.code_me_continentales_bv

  if (point.code_bv_bdcarthage) {
    const bvBdCarthage = await mongo.db.collection('bv_bdcarthage').findOne({code_cours: point.code_bv_bdcarthage})

    pointToInsert.bvBdCarthage = {
      code: bvBdCarthage.code_cours,
      nom: bvBdCarthage.toponyme_t
    }
  } else {
    pointToInsert.bvBdCarthage = null
  }

  delete pointToInsert.code_bv_bdcarthage

  if (point.insee_com) {
    pointToInsert.commune = {
      code: point.insee_com,
      nom: indexedLibellesCommunes[point.insee_com].nom
    }
  }

  delete pointToInsert.insee_com

  pointToInsert.territoire = codeTerritoire
  pointToInsert.createdAt = new Date()
  pointToInsert.updatedAt = new Date()

  return pointToInsert
}

async function prepareExploitation(exploitation, codeTerritoire, exploitationsUsages) {
  const exploitationToInsert = exploitation

  if (exploitation.id_beneficiaire) {
    exploitationToInsert.id_preleveur = exploitation.id_beneficiaire
    delete exploitationToInsert.id_beneficiaire
  }

  exploitationToInsert.regles = await getReglesFromExploitationId(exploitation.id_exploitation)
  exploitationToInsert.documents = await getDocumentFromExploitationId(exploitation.id_exploitation)
  exploitationToInsert.modalites = await getModalitesFromExploitationId(exploitation.id_exploitation)

  delete exploitationToInsert.usage

  exploitation.usages = exploitationsUsages
    .filter(u => u.id_exploitation === exploitation.id_exploitation)
    .map(u => parseNomenclature(u.id_usage, usages))

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
  console.log('\n\u001B[35;1;4m%s\u001B[0m', '=> Importation des données points_prelevement pour : ' + nomTerritoire)
  const points = await readDataFromCsvFile(
    folderPath + '/point-prelevement.csv',
    POINTS_PRELEVEMENT_DEFINITION
  )

  const pointsToInsert = await Promise.all(points.map(point => preparePoint(point, codeTerritoire)))
  const result = await mongo.db.collection('points_prelevement').insertMany(pointsToInsert)

  console.log(
    '\u001B[32;1m%s\u001B[0m',
    '\n=> ' + result.insertedCount + ' documents insérés dans la collection points_prelevement\n\n'
  )
}

async function importExploitations(folderPath, codeTerritoire, nomTerritoire) {
  console.log('\n\u001B[35;1;4m%s\u001B[0m', '=> Importation des données exploitations pour : ' + nomTerritoire)
  const exploitationsUsages = await readDataFromCsvFile(
    folderPath + '/exploitation-usage.csv',
    null,
    false
  )
  const exploitations = await readDataFromCsvFile(
    folderPath + '/exploitation.csv',
    EXPLOITATIONS_DEFINITION,
    false
  )

  const exploitationsToInsert = await Promise.all(exploitations.map(exploitation => prepareExploitation(exploitation, codeTerritoire, exploitationsUsages)))

  if (exploitationsToInsert) {
    const result = await mongo.db.collection('exploitations').insertMany(exploitationsToInsert)
    console.log(
      '\u001B[32;1m%s\u001B[0m',
      '\n=> ' + result.insertedCount + ' documents insérés dans la collection exploitations\n\n'
    )
  }
}

async function importPreleveurs(folderPath, codeTerritoire, nomTerritoire) {
  console.log('\n\u001B[35;1;4m%s\u001B[0m', '=> Importation des données preleveurs pour : ' + nomTerritoire)
  const preleveurs = await readDataFromCsvFile(
    folderPath + '/beneficiaire.csv',
    PRELEVEURS_DEFINITION,
    false
  )

  if (preleveurs.length > 0) {
    const preleveursToInsert = await Promise.all(preleveurs.map(preleveur => preparePreleveur(preleveur, codeTerritoire)))
    const result = await mongo.db.collection('preleveurs').insertMany(preleveursToInsert)
    console.log(
      '\u001B[32;1m%s\u001B[0m',
      '\n=> ' + result.insertedCount + ' documents insérés dans la collection preleveurs\n\n'
    )
  }
}

async function importRegles(filePath, nomTerritoire) {
  console.log('\n\u001B[35;1;4m%s\u001B[0m', '=> Importation des règles pour : ' + nomTerritoire)

  const regles = await readDataFromCsvFile(
    `${filePath}/regle.csv`,
    REGLES_DEFINITION,
    false
  )

  if (regles.length > 0) {
    const result = await mongo.db.collection('regles').insertMany(regles)

    console.log(
      '\u001B[32;1m%s\u001B[0m',
      '\n=> ' + result.insertedCount + ' documents insérés dans la collection regles\n\n'
    )
  }
}

async function importDocuments(filePath, nomTerritoire) {
  console.log('\n\u001B[35;1;4m%s\u001B[0m', '=> Importation des documents pour : ' + nomTerritoire)

  const documents = await readDataFromCsvFile(
    `${filePath}/document.csv`,
    DOCUMENTS_DEFINITION,
    false
  )

  if (documents.length > 0) {
    const result = await mongo.db.collection('documents').insertMany(documents)

    console.log(
      '\u001B[32;1m%s\u001B[0m',
      '\n=> ' + result.insertedCount + ' documents insérés dans la collection documents\n\n'
    )
  }
}

async function importModalites(filePath, nomTerritoire) {
  console.log('\n\u001B[35;1;4m%s\u001B[0m', '=> Importation des modalités de suivi pour : ' + nomTerritoire)

  const modalites = await readDataFromCsvFile(
    `${filePath}/modalite-suivi.csv`,
    MODALITES_DEFINITION,
    false
  )

  if (modalites.length > 0) {
    const result = await mongo.db.collection('modalites').insertMany(modalites)

    console.log(
      '\u001B[32;1m%s\u001B[0m',
      '\n=> ' + result.insertedCount + ' documents insérés dans la collection modalites\n\n'
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

  await importRegles(folderPath, validTerritoire.nom)
  await importDocuments(folderPath, validTerritoire.nom)
  await importModalites(folderPath, validTerritoire.nom)
  await importPoints(folderPath, codeTerritoire, validTerritoire.nom)
  await importExploitations(folderPath, codeTerritoire, validTerritoire.nom)
  await importPreleveurs(folderPath, codeTerritoire, validTerritoire.nom)

  await mongo.disconnect()
}

const codeTerritoire = argv[2]
const folderPath = argv[3]

await importData(folderPath, codeTerritoire)
