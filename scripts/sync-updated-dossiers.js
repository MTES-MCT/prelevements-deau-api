import 'dotenv/config'
import mongo from '../lib/util/mongo.js'
import {syncUpdatedDossiers} from '../lib/demarches-simplifiees/index.js'

// Connect to MongoDB
await mongo.connect()

async function main() {
  return syncUpdatedDossiers()
}

// Call the main function and ensure MongoDB is disconnected afterwards
try {
  await main()
} finally {
  // Disconnect from MongoDB
  await mongo.disconnect()
}
