import 'dotenv/config'
import process from 'node:process'
import mongo from '../lib/util/mongo.js'
import {finished} from '../lib/util/defer.js'
import {reprocessAllAttachments} from '../lib/demarches-simplifiees/index.js'

const demarcheNumber = Number.parseInt(process.env.DS_DEMARCHE_NUMBER, 10)

await mongo.connect()

async function main() {
  return reprocessAllAttachments(demarcheNumber)
}

try {
  await main()
} finally {
  await finished()
  await mongo.disconnect()
}
