import mongo from '../lib/util/mongo.js'
import * as storage from '../lib/models/internal/in-memory.js'
import {getBnpe, getBssById} from '../lib/models/points-prelevement.js'

async function updateExploitationsWithDocuments() {
  console.log('\u001B[35;1;4m%s\u001B[0m', '• Ajout des documments dans les exploitations')

  const bulkOperations = storage.exploitationsDocuments.map(ed => ({
    updateOne: {
      filter: {id_exploitation: ed.id_exploitation},
      update: {$addToSet: {documents: storage.indexedDocuments[ed.id_document]}}
    }
  }))

  if (bulkOperations.length > 0) {
    await mongo.db.collection('exploitations').bulkWrite(bulkOperations, {ordered: false})
  }

  console.log('\u001B[32;1m%s\u001B[0m', `\n=> ${bulkOperations.length} documents insérés\n\n`)
}

async function updateExploitationsWithRegles() {
  console.log('\u001B[35;1;4m%s\u001B[0m', '• Ajout des regles dans les exploitations')

  const bulkOperations = storage.exploitationsRegles.map(er => ({
    updateOne: {
      filter: {id_exploitation: er.id_exploitation},
      update: {$addToSet: {regles: storage.indexedRegles[er.id_regle]}}
    }
  }))

  if (bulkOperations.length > 0) {
    await mongo.db.collection('exploitations').bulkWrite(bulkOperations, {ordered: false})
  }

  console.log('\u001B[32;1m%s\u001B[0m', `\n=> ${bulkOperations.length} règles insérées\n\n`)
}

async function updateExploitationsWithModalites() {
  console.log('\u001B[35;1;4m%s\u001B[0m', '• Ajout des modalités dans les exploitations')

  const bulkOperations = storage.exploitationModalites.map(er => ({
    updateOne: {
      filter: {id_exploitation: er.id_exploitation},
      update: {$addToSet: {modalites: storage.indexedModalitesSuivis[er.id_modalite]}}
    }
  }))

  if (bulkOperations.length > 0) {
    await mongo.db.collection('exploitations').bulkWrite(bulkOperations, {ordered: false})
  }

  console.log('\u001B[32;1m%s\u001B[0m', `\n=> ${bulkOperations.length} modalités insérées\n\n`)
}

async function importCollection(data, collectionName) {
  console.log('\u001B[35;1;4m%s\u001B[0m', '• Importation des données : ' + collectionName)

  if (!data || data.length === 0) {
    console.error('Le fichier est vide !')
    return
  }

  const collection = mongo.db.collection(collectionName)

  console.log('\n=> Nettoyage de la collection...')
  await collection.deleteMany()
  console.log('...Ok !')

  try {
    const result = await collection.insertMany(data)
    console.log('\u001B[32;1m%s\u001B[0m', '\n=> ' + result.insertedCount + ' documents insérés dans ' + collectionName + '\n\n')
  } catch (error) {
    throw new Error('Erreur lors de l’importation des données : ' + error)
  }
}

async function addBssToPoints() {
  console.log('\u001B[35;1;4m%s\u001B[0m', '• Ajout du BSS dans les points')
  const points = await mongo.db.collection('points_prelevement').find().toArray()
  const bulkOps = []

  const bssData = points
    .filter(point => point.id_bss)
    .map(point => {
      const bss = getBssById(point.id_bss)
      return {
        id_point: point.id_point,
        bss: {
          ...bss
        }
      }
    })

  for (const {id_point, bss} of bssData) {
    bulkOps.push({
      updateOne: {
        filter: {id_point},
        update: {
          $set: {bss},
          $unset: {id_bss: ''}
        }
      }
    })
  }

  if (bulkOps.length > 0) {
    const result = await mongo.db.collection('points_prelevement').bulkWrite(bulkOps)
    console.log('\u001B[32;1m%s\u001B[0m', '\n=> ' + result.modifiedCount + ' points modifiés\n\n')
  }
}

async function addBnpeToPoints() {
  console.log('\u001B[35;1;4m%s\u001B[0m', '• Ajout du BNPE dans les points')
  const points = await mongo.db.collection('points_prelevement').find().toArray()
  const bulkOps = []

  const bnpeData = points
    .filter(point => point.code_bnpe)
    .map(point => {
      const bnpe = getBnpe(point.code_bnpe)
      return {
        id_point: point.id_point,
        bnpe
      }
    })

  for (const {id_point, bnpe} of bnpeData) {
    bulkOps.push({
      updateOne: {
        filter: {id_point},
        update: {
          $set: {bnpe},
          $unset: {code_bnpe: ''}
        }
      }
    })
  }

  if (bulkOps.length > 0) {
    const result = await mongo.db.collection('points_prelevement').bulkWrite(bulkOps)
    console.log('\u001B[32;1m%s\u001B[0m', '\n=> ' + result.modifiedCount + ' points modifiés\n\n')
  }
}
  }
}

await mongo.connect()

await importCollection(storage.beneficiaires, 'preleveurs')
await importCollection(storage.exploitations, 'exploitations')
await importCollection(storage.pointsPrelevement, 'points_prelevement')

await updateExploitationsWithDocuments()
await updateExploitationsWithRegles()
await updateExploitationsWithModalites()

await mongo.disconnect()
