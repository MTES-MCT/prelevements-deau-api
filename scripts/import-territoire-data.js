/* eslint-disable n/prefer-global/process */
/* eslint-disable unicorn/no-process-exit */
import 'dotenv/config'

import {argv} from 'node:process'

import {chain, keyBy} from 'lodash-es'

import got from 'got'
import mongo, {ObjectId} from '../lib/util/mongo.js'
import {readDataFromCsvFile} from '../lib/import/csv.js'
import {getCommune} from '../lib/util/cog.js'
import {parseNomenclature} from '../lib/import/generic.js'
import {
  REGLES_DEFINITION,
  DOCUMENTS_DEFINITION,
  POINTS_PRELEVEMENT_DEFINITION,
  EXPLOITATIONS_DEFINITION,
  PRELEVEURS_DEFINITION,
  EXPLOITATIONS_USAGES_DEFINITION,
  EXPLOITATIONS_REGLES_DEFINITION,
  EXPLOITATIONS_DOCUMENTS_DEFINITION
} from '../lib/import/mapping.js'
import {usages} from '../lib/nomenclature.js'
import {initSequence} from '../lib/util/sequences.js'

import {bulkInsertPointsPrelevement, bulkDeletePointsPrelevement} from '../lib/models/point-prelevement.js'
import {bulkDeletePreleveurs, bulkInsertPreleveurs} from '../lib/models/preleveur.js'
import {bulkInsertExploitations, bulkDeleteExploitations} from '../lib/models/exploitation.js'
import {createDocument, decorateDocument, getDocument} from '../lib/models/document.js'

const pointsIds = new Map()
const preleveursIds = new Map()
const exploitationsIds = new Map()
const documentsIds = new Map()

function getPointId(id_point) {
  return pointsIds.get(id_point)
}

function getPreleveurId(id_preleveur) {
  return preleveursIds.get(id_preleveur)
}

function getDocumentId(idDocument) {
  return documentsIds.get(idDocument)
}

function parseAutresNoms(autresNoms) {
  if (!autresNoms) {
    return null
  }

  const cleanedStr = autresNoms.replaceAll(/[{}"]/g, '')
  const result = [...new Set(cleanedStr.split(','))].join(', ')

  return result
}

async function preparePoint(point) {
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

  pointToInsert._id = new ObjectId()

  pointsIds.set(pointToInsert.id_point, pointToInsert._id)

  return pointToInsert
}

async function prepareExploitation(exploitation, exploitationsUsages, {regles}) {
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

  exploitationToInsert.documents = []
  exploitationToInsert.regles = regles[exploitation.id_exploitation] || []
  exploitationToInsert._id = new ObjectId()

  exploitationsIds.set(exploitationToInsert.id_exploitation, exploitationToInsert._id)

  return exploitationToInsert
}

function preparePreleveur(preleveur) {
  const preleveurToInsert = preleveur

  if (preleveur.id_beneficiaire) {
    preleveurToInsert.id_preleveur = preleveur.id_beneficiaire
    delete preleveurToInsert.id_beneficiaire
  }

  preleveurToInsert._id = new ObjectId()

  preleveursIds.set(preleveurToInsert.id_preleveur, preleveurToInsert._id)

  return preleveurToInsert
}

async function importPoints(folderPath, codeTerritoire, nomTerritoire) {
  console.log('\n\u001B[35;1;4m%s\u001B[0m', '=> Importation des données points_prelevement pour : ' + nomTerritoire)
  const points = await readDataFromCsvFile(
    folderPath + '/point-prelevement.csv',
    POINTS_PRELEVEMENT_DEFINITION
  )

  console.log('\n=> Nettoyage de la collection points_prelevement...')
  await bulkDeletePointsPrelevement(codeTerritoire)
  console.log('...Ok !')

  const pointsToInsert = await Promise.all(points.map(point => preparePoint(point)))
  const {insertedCount} = await bulkInsertPointsPrelevement(
    codeTerritoire,
    pointsToInsert
  )
  console.log(
    '\u001B[32;1m%s\u001B[0m',
    '\n=> ' + insertedCount + ' documents insérés dans la collection points_prelevement\n\n'
  )
}

async function extractRegles(filePath) {
  console.log('\n\u001B[35;1;4m%s\u001B[0m', '=> Extraction des règles')

  const regles = await readDataFromCsvFile(
    `${filePath}/regle.csv`,
    REGLES_DEFINITION,
    false
  )

  const exploitationsRegles = await readDataFromCsvFile(
    `${filePath}/exploitation-regle.csv`,
    EXPLOITATIONS_REGLES_DEFINITION,
    false
  )

  const reglesIndex = keyBy(regles, 'id_regle')

  return chain(exploitationsRegles)
    .groupBy('id_exploitation')
    .mapValues(items => items.map(item => {
      const {id_regle, ...regle} = reglesIndex[item.id_regle]
      return regle
    }))
    .value()
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

  const exploitations = await readDataFromCsvFile(
    `${filePath}/exploitation.csv`,
    EXPLOITATIONS_DEFINITION,
    false
  )

  const exploitationsDocuments = await readDataFromCsvFile(
    `${filePath}/exploitation-document.csv`,
    EXPLOITATIONS_DOCUMENTS_DEFINITION,
    false
  )

  if (documents.length > 0) {
    const updatePromises = exploitationsDocuments.map(async ed => {
      const {id_exploitation, id_document} = ed
      const idDocument = getDocumentId(id_document)
      const document = await getDocument(idDocument)
      const exploitation = exploitations.find(e => e.id_exploitation === id_exploitation)

      if (document && exploitation) {
        const documentWithPreleveur = {
          ...document,
          id_preleveur: exploitation.id_beneficiaire
        }

        const decoratedDocumentWithPreleveur = await decorateDocument(documentWithPreleveur)

        await mongo.db.collection('exploitations').updateOne(
          {id_exploitation},
          {$push: {documents: decoratedDocumentWithPreleveur}}
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

async function importExploitations(folderPath, codeTerritoire, nomTerritoire) {
  console.log('\n\u001B[35;1;4m%s\u001B[0m', '=> Importation des données exploitations pour : ' + nomTerritoire)
  const exploitationsUsages = await readDataFromCsvFile(
    folderPath + '/exploitation-usage.csv',
    EXPLOITATIONS_USAGES_DEFINITION,
    false
  )
  const exploitations = await readDataFromCsvFile(
    folderPath + '/exploitation.csv',
    EXPLOITATIONS_DEFINITION,
    false
  )

  const regles = await extractRegles(folderPath)

  const exploitationsToInsert = await Promise.all(
    exploitations.map(
      exploitation => prepareExploitation(exploitation, exploitationsUsages, {regles})
    )
  )

  if (exploitationsToInsert) {
    console.log('\n=> Nettoyage de la collection exploitations...')
    await bulkDeleteExploitations(codeTerritoire)
    console.log('...Ok !')

    const {insertedCount} = await bulkInsertExploitations(codeTerritoire, exploitationsToInsert)
    console.log(
      '\u001B[32;1m%s\u001B[0m',
      '\n=> ' + insertedCount + ' documents insérés dans la collection exploitations\n\n'
    )
  }

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
    await bulkDeletePreleveurs(codeTerritoire)
    console.log('...Ok !')

    const {insertedCount} = await bulkInsertPreleveurs(
      codeTerritoire,
      preleveurs.map(preleveur => preparePreleveur(preleveur))
    )
    console.log(
      '\u001B[32;1m%s\u001B[0m',
      '\n=> ' + insertedCount + ' documents insérés dans la collection preleveurs\n\n'
    )
  }
}

async function importDocuments(filePath, codeTerritoire) {
  console.log(
    '\n\u001B[35;1;4m%s\u001B[0m',
    '=> Import des documents dans la collection documents'
  )

  const fichiersIntrouvables = []

  const documents = await readDataFromCsvFile(
    `${filePath}/document.csv`,
    DOCUMENTS_DEFINITION,
    false
  )

  const exploitations = await readDataFromCsvFile(
    `${filePath}/exploitation.csv`,
    EXPLOITATIONS_DEFINITION,
    false
  )

  const exploitationsDocuments = await readDataFromCsvFile(
    `${filePath}/exploitation-document.csv`,
    EXPLOITATIONS_DOCUMENTS_DEFINITION,
    false
  )

  if (documents.length > 0) {
    console.log('\n=> Nettoyage de la collection documents...')
    await mongo.db.collection('documents').deleteMany({territoire: codeTerritoire})
    console.log('...Ok !')

    const documentsWithBeneficiaire = documents.map(document => {
      const relatedExploitationIds = new Set(exploitationsDocuments
        .filter(ed => ed.id_document === document.id_document)
        .map(ed => ed.id_exploitation))

      const beneficiaireIds = [...new Set(exploitations
        .filter(exploitation => relatedExploitationIds.has(exploitation.id_exploitation))
        .map(exploitation => exploitation.id_beneficiaire))]

      return {
        ...document,
        territoire: codeTerritoire,
        id_preleveurs: beneficiaireIds
      }
    })

    for (const document of documentsWithBeneficiaire) {
      const {nom_fichier, id_preleveurs} = document

      if (!nom_fichier) {
        continue
      }

      const url = `${process.env.S3_PUBLIC_URL}/document/${nom_fichier}`

      let buffer
      try {
        // eslint-disable-next-line no-await-in-loop
        buffer = await got(url).buffer()
      } catch (error) {
        console.error(`Erreur avec le document ${nom_fichier} : ${error.message}`)
        fichiersIntrouvables.push(nom_fichier)
        continue
      }

      const filename = nom_fichier

      for (const currentPreleveurId of id_preleveurs) {
        // eslint-disable-next-line no-await-in-loop
        const preleveur = await mongo.db.collection('preleveurs').findOne({id_preleveur: currentPreleveurId})

        const documentData = {
          ...document,
          nom_fichier: filename
        }

        const originalDocumentId = documentData.id_document

        delete documentData.id_document
        delete documentData.territoire
        delete documentData.id_preleveurs

        const file = {
          buffer,
          originalname: filename,
          size: buffer.length
        }

        if (id_preleveurs.length > 1) {
          console.log(`Création du document ${filename} pour le préleveur ${currentPreleveurId} (${id_preleveurs.indexOf(currentPreleveurId) + 1}/${id_preleveurs.length})`)
        } else {
          console.log(`Création du document ${filename}`)
        }

        // eslint-disable-next-line no-await-in-loop
        const insertedDocument = await createDocument(documentData, file, preleveur?._id || currentPreleveurId, codeTerritoire)

        documentsIds.set(originalDocumentId, insertedDocument._id)
      }
    }

    // eslint-disable-next-line unicorn/no-console-spaces
    console.log('Fichiers introuvables : ', fichiersIntrouvables)

    console.log(
      '\u001B[34;1m%s\u001B[0m',
      '\n=> Les documents ont été importés dans la collection documents\n\n'
    )
  }
}

async function importData(folderPath, codeTerritoire) {
  if (!codeTerritoire) {
    console.error(
      '\u001B[41m\u001B[30m%s\u001B[0m',
      'Vous devez renseigner l’id du territoire à importer. \nExemple : npm run import-territoire-data DEP-974 /data/reunion'
    )

    process.exit(1)
  }

  if (!folderPath) {
    console.error(
      '\u001B[41m\u001B[30m%s\u001B[0m',
      'Vous devez renseigner le chemin du fichier à importer \nExemple : npm run import-territoire-data DEP-974 /data/reunion'
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

  await importPreleveurs(folderPath, codeTerritoire, validTerritoire.nom)
  await importDocuments(folderPath, codeTerritoire)
  await importPoints(folderPath, codeTerritoire, validTerritoire.nom)
  await importExploitations(folderPath, codeTerritoire, validTerritoire.nom)

  if (pointsIds.size > 0) {
    const latestPointId = Math.max(...pointsIds.keys())
    await initSequence(`territoire-${codeTerritoire}-points`, latestPointId)
  }

  if (preleveursIds.size > 0) {
    const latestPreleveurId = Math.max(...preleveursIds.keys())
    await initSequence(`territoire-${codeTerritoire}-preleveurs`, latestPreleveurId)
  }

  if (exploitationsIds.size > 0) {
    const latestExploitationId = Math.max(...exploitationsIds.keys())
    await initSequence(`territoire-${codeTerritoire}-exploitations`, latestExploitationId)
  }

  await mongo.disconnect()
}

const codeTerritoire = argv[2]
const folderPath = argv[3]

await importData(folderPath, codeTerritoire)
