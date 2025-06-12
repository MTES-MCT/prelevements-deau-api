import 'dotenv/config'
import process from 'node:process'
import mongo from '../lib/util/mongo.js'
import {finished} from '../lib/util/defer.js'
import {syncUpdatedDossiers} from '../lib/demarches-simplifiees/index.js'

const demarcheNumber = Number.parseInt(process.env.DS_DEMARCHE_NUMBER, 10)

// Connect to MongoDB
await mongo.connect()

async function main() {
  return syncUpdatedDossiers(demarcheNumber)
}

// Call the main function and ensure MongoDB is disconnected afterwards
try {
  await main()
} finally {
  // Disconnect from MongoDB
  await finished()
  await mongo.disconnect()
}
