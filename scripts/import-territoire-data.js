/* eslint-disable n/prefer-global/process */
/* eslint-disable unicorn/no-process-exit */
import 'dotenv/config'

import {argv} from 'node:process'

import {chain, keyBy} from 'lodash-es'
import {ObjectId} from 'mongodb'

import got from 'got'
import mongo from '../lib/util/mongo.js'
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
import {bulkInsertRegles, bulkDeleteRegles} from '../lib/models/regle.js'
import {bulkInsertDocuments, bulkDeleteDocuments} from '../lib/models/document.js'
import {uploadDocumentToS3} from '../lib/services/document.js'

const pointsIds = new Map()
const preleveursIds = new Map()
const exploitationsIds = new Map()
const documentsIds = new Map()

function getPointId(idPoint) {
  return pointsIds.get(idPoint)
}

function getPreleveurId(idPreleveur) {
  return preleveursIds.get(idPreleveur)
}

function getExploitationId(idExploitation) {
  return exploitationsIds.get(idExploitation)
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

async function prepareExploitation(exploitation, exploitationsUsages, exploitationDocumentsMap) {
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

  // Peupler le tableau documents avec les ObjectId
  const documentIds = exploitationDocumentsMap[exploitation.id_exploitation] || []
  exploitationToInsert.documents = documentIds
    .map(idDocument => getDocumentId(idDocument))
    .filter(Boolean) // Filtrer les documents non trouvés

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

async function importPreleveurs(preleveurs, codeTerritoire, nomTerritoire) {
  console.log('\n\u001B[35;1;4m%s\u001B[0m', '=> Importation des données preleveurs pour : ' + nomTerritoire)

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

async function importDocuments(csvData, folderPath, codeTerritoire) {
  console.log(
    '\n\u001B[35;1;4m%s\u001B[0m',
    '=> Import des documents dans la collection documents'
  )

  const {documents, exploitations, exploitationsDocuments} = csvData
  const fichiersIntrouvables = []
  const fichiersSkippes = []

  if (documents.length === 0) {
    console.log('Aucun document à importer')
    return
  }

  console.log('\n=> Nettoyage de la collection documents...')
  await bulkDeleteDocuments(codeTerritoire)
  console.log('...Ok !')

  // Préparer les documents avec leurs préleveurs
  const documentsToInsert = []

  for (const document of documents) {
    const {nom_fichier, id_document} = document

    if (!nom_fichier) {
      continue
    }

    // Trouver les préleveurs associés à ce document
    const relatedExploitationIds = new Set(exploitationsDocuments
      .filter(ed => ed.id_document === id_document)
      .map(ed => ed.id_exploitation))

    const beneficiaireIds = [...new Set(exploitations
      .filter(exploitation => relatedExploitationIds.has(exploitation.id_exploitation))
      .map(exploitation => exploitation.id_beneficiaire))]

    if (beneficiaireIds.length === 0) {
      console.warn(`Document ${nom_fichier} (id: ${id_document}) n'a pas de préleveur associé`)
      continue
    }

    // Télécharger le fichier
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

    // Créer un document par préleveur (duplication)
    for (const currentPreleveurId of beneficiaireIds) {
      // eslint-disable-next-line no-await-in-loop
      const preleveur = await mongo.db.collection('preleveurs').findOne({id_preleveur: currentPreleveurId})

      if (!preleveur) {
        console.warn(`Préleveur ${currentPreleveurId} introuvable pour le document ${nom_fichier}`)
        continue
      }

      const preleveurObjectId = preleveur._id

      // Upload vers S3 (idempotent avec hash)
      // eslint-disable-next-line no-await-in-loop
      const {objectKey, skipped} = await uploadDocumentToS3({
        buffer,
        filename: nom_fichier,
        codeTerritoire,
        preleveurSeqId: currentPreleveurId
      })

      if (skipped) {
        fichiersSkippes.push(`${nom_fichier} (préleveur ${currentPreleveurId})`)
      }

      const documentToInsert = {
        _id: new ObjectId(),
        preleveur: preleveurObjectId,
        nom_fichier,
        taille: buffer.length,
        objectKey,
        reference: document.reference,
        nature: document.nature,
        date_signature: document.date_signature,
        date_fin_validite: document.date_fin_validite,
        date_ajout: document.date_ajout,
        remarque: document.remarque
      }

      documentsToInsert.push(documentToInsert)

      // Mémoriser le mapping id_document → ObjectId (dernier créé)
      documentsIds.set(id_document, documentToInsert._id)

      if (beneficiaireIds.length > 1) {
        console.log(`Préparation du document ${nom_fichier} pour le préleveur ${currentPreleveurId} (${beneficiaireIds.indexOf(currentPreleveurId) + 1}/${beneficiaireIds.length})`)
      } else {
        console.log(`Préparation du document ${nom_fichier}`)
      }
    }
  }

  if (documentsToInsert.length > 0) {
    const {insertedCount} = await bulkInsertDocuments(codeTerritoire, documentsToInsert)
    console.log(
      '\u001B[32;1m%s\u001B[0m',
      `\n=> ${insertedCount} documents insérés dans la collection documents\n`
    )
  }

  if (fichiersIntrouvables.length > 0) {
    // eslint-disable-next-line unicorn/no-console-spaces
    console.log('Fichiers introuvables : ', fichiersIntrouvables)
  }

  if (fichiersSkippes.length > 0) {
    console.log(`Fichiers déjà présents dans S3 (${fichiersSkippes.length} skippés) :`, fichiersSkippes)
  }

  console.log()
}

async function importPoints(points, codeTerritoire, nomTerritoire) {
  console.log('\n\u001B[35;1;4m%s\u001B[0m', '=> Importation des données points_prelevement pour : ' + nomTerritoire)

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

async function importExploitations(csvData, codeTerritoire, nomTerritoire) {
  console.log('\n\u001B[35;1;4m%s\u001B[0m', '=> Importation des données exploitations pour : ' + nomTerritoire)

  const {exploitations, exploitationsUsages, exploitationsDocuments} = csvData

  // Index des documents par exploitation
  const exploitationDocumentsMap = chain(exploitationsDocuments)
    .groupBy('id_exploitation')
    .mapValues(items => items.map(item => item.id_document))
    .value()

  const exploitationsToInsert = await Promise.all(
    exploitations.map(
      exploitation => prepareExploitation(exploitation, exploitationsUsages, exploitationDocumentsMap)
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
}

async function importRegles(csvData, codeTerritoire) {
  console.log('\n\u001B[35;1;4m%s\u001B[0m', '=> Importation des règles')

  const {regles, exploitationsRegles, exploitations} = csvData

  if (regles.length === 0) {
    console.log('Aucune règle à importer')
    return
  }

  console.log('\n=> Nettoyage de la collection regles...')
  await bulkDeleteRegles(codeTerritoire)
  console.log('...Ok !')

  // Index des règles par id_regle
  const reglesIndex = keyBy(regles, 'id_regle')

  // Grouper les exploitations par règle
  const reglesData = chain(exploitationsRegles)
    .groupBy('id_regle')
    .map((items, idRegle) => {
      const regle = reglesIndex[idRegle]
      const exploitationIds = items.map(item => getExploitationId(item.id_exploitation))

      // Trouver le préleveur via la première exploitation
      const firstExploitation = exploitations.find(e => e.id_exploitation === items[0].id_exploitation)
      const preleveurId = firstExploitation ? getPreleveurId(firstExploitation.id_beneficiaire) : null

      const regleToInsert = {
        _id: new ObjectId(),
        preleveur: preleveurId,
        exploitations: exploitationIds,
        parametre: regle.parametre,
        unite: regle.unite,
        valeur: regle.valeur,
        contrainte: regle.contrainte,
        debut_validite: regle.debut_validite,
        fin_validite: regle.fin_validite,
        debut_periode: regle.debut_periode,
        fin_periode: regle.fin_periode,
        remarque: regle.remarque
      }

      // Ajouter le document si présent
      if (regle.id_document) {
        const documentId = getDocumentId(regle.id_document)
        if (documentId) {
          regleToInsert.document = documentId
        }
      }

      return regleToInsert
    })
    .value()

  const {insertedCount} = await bulkInsertRegles(codeTerritoire, reglesData)
  console.log(
    '\u001B[32;1m%s\u001B[0m',
    '\n=> ' + insertedCount + ' règles insérées dans la collection regles\n\n'
  )
}

async function importData(folderPath, codeTerritoire) {
  if (!codeTerritoire) {
    console.error(
      '\u001B[41m\u001B[30m%s\u001B[0m',
      'Vous devez renseigner l\'id du territoire à importer. \nExemple : npm run import-territoire-data DEP-974 /data/reunion'
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

  // Lecture des fichiers CSV une seule fois
  console.log('\n\u001B[35;1;4m%s\u001B[0m', '=> Lecture des fichiers CSV')
  const csvData = {
    preleveurs: await readDataFromCsvFile(
      `${folderPath}/beneficiaire-email.csv`,
      PRELEVEURS_DEFINITION,
      false
    ),
    points: await readDataFromCsvFile(
      `${folderPath}/point-prelevement.csv`,
      POINTS_PRELEVEMENT_DEFINITION
    ),
    exploitations: await readDataFromCsvFile(
      `${folderPath}/exploitation.csv`,
      EXPLOITATIONS_DEFINITION,
      false
    ),
    exploitationsUsages: await readDataFromCsvFile(
      `${folderPath}/exploitation-usage.csv`,
      EXPLOITATIONS_USAGES_DEFINITION,
      false
    ),
    exploitationsDocuments: await readDataFromCsvFile(
      `${folderPath}/exploitation-document.csv`,
      EXPLOITATIONS_DOCUMENTS_DEFINITION,
      false
    ),
    documents: await readDataFromCsvFile(
      `${folderPath}/document.csv`,
      DOCUMENTS_DEFINITION,
      false
    ),
    regles: await readDataFromCsvFile(
      `${folderPath}/regle.csv`,
      REGLES_DEFINITION,
      false
    ),
    exploitationsRegles: await readDataFromCsvFile(
      `${folderPath}/exploitation-regle.csv`,
      EXPLOITATIONS_REGLES_DEFINITION,
      false
    )
  }
  console.log('\u001B[32;1m%s\u001B[0m', '=> Fichiers CSV chargés en mémoire\n')

  await importPreleveurs(csvData.preleveurs, codeTerritoire, validTerritoire.nom)
  await importDocuments(csvData, folderPath, codeTerritoire)
  await importPoints(csvData.points, codeTerritoire, validTerritoire.nom)
  await importExploitations(csvData, codeTerritoire, validTerritoire.nom)
  await importRegles(csvData, codeTerritoire)

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
