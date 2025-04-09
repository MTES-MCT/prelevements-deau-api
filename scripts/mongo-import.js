import mongo from '../lib/util/mongo.js'
import * as storage from '../lib/models/internal/in-memory.js'
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


  }))

  }
}

    console.error('Le fichier est vide !')
    return
  }



  try {
  } catch (error) {
  }
}

await mongo.connect()

await importCollection(storage.beneficiaires, 'preleveurs')
await importCollection(storage.exploitations, 'exploitations')
await importCollection(storage.pointsPrelevement, 'points_prelevement')

await updateExploitationsWithDocuments()
await updateExploitationsWithRegles()
await mongo.disconnect()
