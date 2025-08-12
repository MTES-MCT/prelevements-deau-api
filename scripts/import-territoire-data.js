/* eslint-disable n/prefer-global/process */
/* eslint-disable unicorn/no-process-exit */
import 'dotenv/config'
import {argv} from 'node:process'
import mongo, {ObjectId} from '../lib/util/mongo.js'
import {readDataFromCsvFile} from '../lib/import/csv.js'
import {getCommune} from '../lib/util/cog.js'
import {parseNomenclature} from '../lib/import/generic.js'
import {
  REGLES_DEFINITION,
  DOCUMENTS_DEFINITION,
  MODALITES_DEFINITION,
  POINTS_PRELEVEMENT_DEFINITION,
  EXPLOITATIONS_DEFINITION,
  PRELEVEURS_DEFINITION
} from '../lib/import/mapping.js'
import {usages} from '../lib/nomenclature.js'
import {maxBy} from 'lodash-es'

const pointsIds = new Map()
const preleveursIds = new Map()
const exploitationsIds = new Map()

function getPointId(id_point) {
  return pointsIds.get(Number(id_point))
}

function getPreleveurId(id_preleveur) {
  return preleveursIds.get(Number(id_preleveur))
}

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
      nom: getCommune(point.insee_com).nom
    }
  }

  delete pointToInsert.insee_com

  pointToInsert.territoire = codeTerritoire
  pointToInsert.createdAt = new Date()
  pointToInsert.updatedAt = new Date()
  pointToInsert._id = new ObjectId()
  pointToInsert.id_point = Number(pointToInsert.id_point)

  pointsIds.set(Number(pointToInsert.id_point), pointToInsert._id)

  return pointToInsert
}

async function prepareExploitation(exploitation, codeTerritoire, exploitationsUsages) {
  const exploitationToInsert = exploitation

  if (exploitation.id_point) {
    exploitationToInsert.point = getPointId(exploitation.id_point)
    delete exploitationToInsert.id_point
  }

  if (exploitation.id_beneficiaire) {
    exploitationToInsert.preleveur = getPreleveurId(exploitation.id_beneficiaire)
    delete exploitationToInsert.id_beneficiaire
  }

  delete exploitationToInsert.usage

  exploitation.usages = exploitationsUsages
    .filter(u => u.id_exploitation === exploitation.id_exploitation)
    .map(u => parseNomenclature(u.id_usage, usages))

  exploitationToInsert.modalites = []
  exploitationToInsert.documents = []
  exploitationToInsert.regles = []
  exploitationToInsert.territoire = codeTerritoire
  exploitationToInsert.createdAt = new Date()
  exploitationToInsert.updatedAt = new Date()
  exploitationToInsert._id = new ObjectId()
  exploitationToInsert.id_exploitation = Number(exploitationToInsert.id_exploitation)

  exploitationsIds.set(Number(exploitationToInsert.id_exploitation, exploitationToInsert._id))

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
  preleveurToInsert._id = new ObjectId()
  preleveurToInsert.id_preleveur = Number(preleveurToInsert.id_preleveur)

  preleveursIds.set(Number(preleveurToInsert.id_preleveur), preleveurToInsert._id)

  return preleveurToInsert
}

async function importPoints(folderPath, codeTerritoire, nomTerritoire) {
  console.log('\n\u001B[35;1;4m%s\u001B[0m', '=> Importation des données points_prelevement pour : ' + nomTerritoire)
  const points = await readDataFromCsvFile(
    folderPath + '/point-prelevement.csv',
    POINTS_PRELEVEMENT_DEFINITION
  )

  console.log('\n=> Nettoyage de la collection points_prelevement...')
  await mongo.db.collection('points_prelevement').deleteMany({territoire: codeTerritoire})
  console.log('...Ok !')

  const pointsToInsert = await Promise.all(points.map(point => preparePoint(point, codeTerritoire)))
  const result = await mongo.db.collection('points_prelevement').insertMany(pointsToInsert)

  console.log(
    '\u001B[32;1m%s\u001B[0m',
    '\n=> ' + result.insertedCount + ' documents insérés dans la collection points_prelevement\n\n'
  )
}

async function importReglesInExploitations(filePath) {
  console.log('\n\u001B[35;1;4m%s\u001B[0m', '=> Insertion des règles dans les exploitations')

  const regles = await readDataFromCsvFile(
    `${filePath}/regle.csv`,
    REGLES_DEFINITION,
    false
  )

  const exploitationsRegles = await readDataFromCsvFile(
    `${filePath}/exploitation-regle.csv`,
    null,
    false
  )

  if (regles.length > 0) {
    const updatePromises = exploitationsRegles.map(async er => {
      const {id_exploitation, id_regle} = er
      const regle = regles.find(r => r.id_regle === id_regle)

      if (regle) {
        await mongo.db.collection('exploitations').updateOne(
          {id_exploitation: Number(id_exploitation)},
          {$push: {regles: regle}}
        )
      }
    })

    await Promise.all(updatePromises)

    console.log(
      '\u001B[34;1m%s\u001B[0m',
      '\n=> Les règles ont été ajoutées aux exploitations\n\n'
    )
  }
}

async function importDocumentsInExploitations(filePath) {
  console.log(
    '\n\u001B[35;1;4m%s\u001B[0m',
    '=> Insertion des documents dans les exploitations'
  )

  const documents = await readDataFromCsvFile(
    `${filePath}/document.csv`,
    DOCUMENTS_DEFINITION,
    false
  )

  const exploitationsDocuments = await readDataFromCsvFile(
    `${filePath}/exploitation-document.csv`,
    null,
    false
  )

  if (documents.length > 0) {
    const updatePromises = exploitationsDocuments.map(async ed => {
      const {id_exploitation, id_document} = ed
      const document = documents.find(d => d.id_document === id_document)

      if (document) {
        await mongo.db.collection('exploitations').updateOne(
          {id_exploitation: Number(id_exploitation)},
          {$push: {documents: document}}
        )
      }
    })

    await Promise.all(updatePromises)

    console.log(
      '\u001B[34;1m%s\u001B[0m',
      '\n=> Les documents ont été ajoutés aux exploitations\n\n'
    )
  }
}

async function importModalitesInExploitations(filePath) {
  console.log(
    '\n\u001B[35;1;4m%s\u001B[0m',
    '=> Insertion des modalités de suivi dans les exploitations')

  const modalites = await readDataFromCsvFile(
    `${filePath}/modalite-suivi.csv`,
    MODALITES_DEFINITION,
    false
  )

  const exploitationsModalites = await readDataFromCsvFile(
    `${filePath}/exploitation-modalite-suivi.csv`,
    null,
    false
  )

  if (modalites.length > 0) {
    const updatePromises = exploitationsModalites.map(async em => {
      const {id_exploitation, id_modalite} = em
      const modalite = modalites.find(r => r.id_modalite === id_modalite)

      if (modalite) {
        await mongo.db.collection('exploitations').updateOne(
          {id_exploitation: Number(id_exploitation)},
          {$push: {modalites: modalite}}
        )
      }
    })

    await Promise.all(updatePromises)

    console.log(
      '\u001B[34;1m%s\u001B[0m',
      '\n=> Les modalités de suivi ont été ajoutées aux exploitations\n\n'
    )
  }
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
    console.log('\n=> Nettoyage de la collection exploitations...')
    await mongo.db.collection('exploitations').deleteMany({territoire: codeTerritoire})
    console.log('...Ok !')

    const result = await mongo.db.collection('exploitations').insertMany(exploitationsToInsert)
    console.log(
      '\u001B[32;1m%s\u001B[0m',
      '\n=> ' + result.insertedCount + ' documents insérés dans la collection exploitations\n\n'
    )
  }

  await importReglesInExploitations(folderPath)
  await importModalitesInExploitations(folderPath)
  await importDocumentsInExploitations(folderPath)
}

async function importPreleveurs(folderPath, codeTerritoire, nomTerritoire) {
  console.log('\n\u001B[35;1;4m%s\u001B[0m', '=> Importation des données preleveurs pour : ' + nomTerritoire)
  const preleveurs = await readDataFromCsvFile(
    folderPath + '/beneficiaire-email.csv',
    PRELEVEURS_DEFINITION,
    false
  )

  // Temporary fix for multiple emails in the same field
  for (const preleveur of preleveurs) {
    if (preleveur.email) {
      const emails = preleveur.email.split('|').map(email => email.trim().toLowerCase())
      preleveur.email = emails[0] // Keep only the first email
      preleveur.autresEmails = emails.slice(1) // Store the rest in a separate field
    }
  }

  if (preleveurs.length > 0) {
    console.log('\n=> Nettoyage de la collection preleveurs...')
    await mongo.db.collection('preleveurs').deleteMany({territoire: codeTerritoire})
    console.log('...Ok !')

    const preleveursToInsert = await Promise.all(preleveurs.map(preleveur => preparePreleveur(preleveur, codeTerritoire)))
    const result = await mongo.db.collection('preleveurs').insertMany(preleveursToInsert)
    console.log(
      '\u001B[32;1m%s\u001B[0m',
      '\n=> ' + result.insertedCount + ' documents insérés dans la collection preleveurs\n\n'
    )
  }
}

async function importDocuments(filePath, codeTerritoire, nomTerritoire) {
  console.log('\n\u001B[35;1;4m%s\u001B[0m', '=> Importation des documents pour : ' + nomTerritoire)

  const documents = await readDataFromCsvFile(
    `${filePath}/document.csv`,
    DOCUMENTS_DEFINITION,
    false
  )

  if (documents.length > 0) {
    console.log('\n=> Nettoyage de la collection documents...')
    await mongo.db.collection('documents').deleteMany({territoire: codeTerritoire})
    console.log('...Ok !')

    for (const document of documents) {
      document.territoire = codeTerritoire
    }

    const result = await mongo.db.collection('documents').insertMany(documents)

    console.log(
      '\u001B[32;1m%s\u001B[0m',
      '\n=> ' + result.insertedCount + ' documents insérés dans la collection documents\n\n'
    )
  }
}

async function importData(folderPath, codeTerritoire) {
  if (!codeTerritoire) {
    console.error(
      '\u001B[41m\u001B[30m%s\u001B[0m',
      'Vous devez renseigner l’id du territoire à importer. \nExemple : yarn import-territoire-data DEP-974 /data/reunion'
    )

    process.exit(1)
  }

  if (!folderPath) {
    console.error(
      '\u001B[41m\u001B[30m%s\u001B[0m',
      'Vous devez renseigner le chemin du fichier à importer \nExemple : yarn import-territoire-data DEP-974 /data/reunion'
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

  await importDocuments(folderPath, codeTerritoire, validTerritoire.nom)
  await importPoints(folderPath, codeTerritoire, validTerritoire.nom)
  await importPreleveurs(folderPath, codeTerritoire, validTerritoire.nom)
  await importExploitations(folderPath, codeTerritoire, validTerritoire.nom)

  const latestPointId = maxBy([...pointsIds.keys()])

  await mongo.db.collection('sequences').findOneAndUpdate(
    {name: `territoire-${codeTerritoire}-points`},
    {$set: {nextId: latestPointId}},
    {upsert: true}
  )

  const latestPreleveurId = maxBy([...preleveursIds.keys()])

  await mongo.db.collection('sequences').findOneAndUpdate(
    {name: `territoire-${codeTerritoire}-preleveurs`},
    {$set: {nextId: latestPreleveurId}},
    {upsert: true}
  )

  const latestExploitationId = maxBy([...exploitationsIds.keys()])

  await mongo.db.collection('sequences').findOneAndUpdate(
    {name: `territoire-${codeTerritoire}-exploitations`},
    {$set: {nextId: latestExploitationId}},
    {upsert: true}
  )

  await mongo.disconnect()
}

const codeTerritoire = argv[2]
const folderPath = argv[3]

await importData(folderPath, codeTerritoire)
