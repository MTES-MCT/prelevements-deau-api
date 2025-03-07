import 'dotenv/config'
import process from 'node:process'
import mongo from '../lib/util/mongo.js'
import {processAllDossiers} from '../lib/demarches-simplifiees/index.js'

const demarcheNumber = Number.parseInt(process.env.DS_DEMARCHE_NUMBER, 10)

// Connect to MongoDB
await mongo.ensureConnected()

async function main() {
  return processAllDossiers({
    demarcheNumber,
    first: 100,
    includeDossiers: true,
    includeChamps: true
  })
}

// Call the main function and ensure MongoDB is disconnected afterwards
try {
  await main()
} finally {
  // Disconnect from MongoDB
  await mongo.disconnect()
}
