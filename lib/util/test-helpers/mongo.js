import {MongoMemoryServer} from 'mongodb-memory-server'
import mongo from '../mongo.js'

/**
 * Utilitaire pour créer une instance MongoDB isolée par fichier de test
 *
 * Usage dans un fichier de test :
 *
 * import test from 'ava'
 * import {setupTestMongo} from '../../util/test-helpers/mongo.js'
 *
 * setupTestMongo(test)
 *
 * test.serial('mon test', async t => {
 *   // mongo.db est maintenant disponible
 * })
 */

let memoryServer

export function setupTestMongo(test) {
  test.before(async () => {
    memoryServer = await MongoMemoryServer.create()
    const uri = memoryServer.getUri()
    await mongo.connect(uri)
  })

  test.after.always(async () => {
    await mongo.disconnect()
    if (memoryServer) {
      await memoryServer.stop()
    }
  })
}

/**
 * Nettoie les collections spécifiées avant chaque test
 *
 * Usage :
 *
 * setupTestMongo(test)
 * cleanupCollections(test, ['dossiers', 'exploitations'])
 */
export function cleanupCollections(test, collections) {
  test.beforeEach(async () => {
    await Promise.all(
      collections.map(name => mongo.db.collection(name).deleteMany({}))
    )
  })
}
