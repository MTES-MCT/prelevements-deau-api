import 'dotenv/config'
import mongo from '../lib/util/mongo.js'
import {getAllDossiers, markDossierForReconsolidation} from '../lib/models/dossier.js'

// Connect to MongoDB
await mongo.connect()

async function main() {
  const dossiers = await getAllDossiers()
  console.log(`Re-consolidation de ${dossiers.length} dossiers`)

  let successCount = 0
  let errorCount = 0

  for (const dossier of dossiers) {
    try {
      await markDossierForReconsolidation(dossier._id)
      successCount++
    } catch (error) {
      console.error(`Erreur lors de la reconsolidation du dossier ${dossier._id}:`, error)
      errorCount++
    }
  }

  console.log(`${successCount} dossiers marqués pour reconsolidation avec succès`)
  if (errorCount > 0) {
    console.log(`${errorCount} erreurs rencontrées`)
  }
}

// Call the main function and ensure MongoDB is disconnected afterwards
try {
  await main()
} finally {
  // Disconnect from MongoDB
  await mongo.disconnect()
}
