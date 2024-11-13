import process from 'node:process'

import {MongoClient, ObjectId} from 'mongodb'

const MONGODB_URL = process.env.MONGODB_URL || 'mongodb://localhost'
const MONGODB_DBNAME = process.env.MONGODB_DBNAME || 'prelevements-deau'

class Mongo {
  async connect(connectionString) {
    if (this.db) {
      throw new Error('mongo.connect() should not be called twice')
    }

    this.client = new MongoClient(connectionString || MONGODB_URL)
    await this.client.connect()
    this.dbName = MONGODB_DBNAME
    this.db = this.client.db(this.dbName)

    await this.createIndexes()
  }

  async createIndexes() {}

  disconnect(force) {
    const {client} = this
    this.client = undefined
    this.db = undefined

    return client.close(force)
  }

  parseObjectId(string) {
    try {
      return ObjectId.createFromHexString(string)
    } catch {
      return null
    }
  }

  decorateCreation(obj) {
    const now = new Date()

    obj._created = now
    obj._updated = now
    obj._id = new ObjectId()
  }

  decorateUpdate(obj) {
    obj._updated = new Date()
  }
}

const mongo = new Mongo()

export default mongo
export {ObjectId} from 'mongodb'

