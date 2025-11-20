import 'dotenv/config'
import mongo from '../lib/util/mongo.js'
import {closeConnection} from '../lib/queues/config.js'
import {getAllAttachments} from '../lib/models/dossier.js'
import {markAttachmentForReprocessing} from '../lib/services/dossier.js'

// Connect to MongoDB
await mongo.connect()

async function main() {
  const attachments = await getAllAttachments()
  console.log(`Retraitement de tous les ${attachments.length} attachments`)

  let successCount = 0
  let errorCount = 0

  for (const attachment of attachments) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await markAttachmentForReprocessing(attachment._id)
      successCount++
    } catch (error) {
      console.error(`Erreur lors du retraitement de l'attachment ${attachment._id}:`, error)
      errorCount++
    }
  }

  console.log(`${successCount} attachments marqués pour retraitement avec succès`)
  if (errorCount > 0) {
    console.log(`${errorCount} erreurs rencontrées`)
  }
}

// Call the main function and ensure MongoDB is disconnected afterwards
try {
  await main()
} finally {
  // Disconnect from MongoDB and Redis
  await mongo.disconnect()
  await closeConnection()
}
