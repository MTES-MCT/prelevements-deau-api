import process from 'node:process'

import {MongoClient, ObjectId} from 'mongodb'

const MONGODB_URL = process.env.MONGODB_URL || 'mongodb://localhost'
const MONGODB_DBNAME = process.env.MONGODB_DBNAME || 'prelevements-deau'
const MONGODB_TLS_CA_FILE_PATH = process.env.MONGODB_TLS_CA_FILE_PATH

export function parseObjectId(string) {
  try {
    return ObjectId.createFromHexString(string)
  } catch {
    return null
  }
}

class Mongo {
  async connect(connectionString) {
    if (this.db) {
      throw new Error('mongo.connect() should not be called twice')
    }

    const options = {}
    if (MONGODB_TLS_CA_FILE_PATH) {
      options.tls = true;
      options.tlsCAFile = MONGODB_TLS_CA_FILE_PATH;
    }

    this.client = new MongoClient(connectionString || MONGODB_URL, options)
    await this.client.connect()
    this.dbName = MONGODB_DBNAME
    this.db = this.client.db(this.dbName)

    await this.createIndexes()
  }

  async createIndexes() {
    await this.db.collection('dossiers').createIndex({territoire: 1})
    await this.db.collection('dossiers').createIndex({'ds.demarcheNumber': 1, 'ds.dossierNumber': 1}, {unique: true})
    await this.db.collection('dossiers').createIndex({consolidatedAt: 1}, {sparse: true})

    await this.db.collection('dossier_attachments').createIndex({dossierId: 1})
    await this.db.collection('dossier_attachments').createIndex({dossierId: 1, storageKey: 1}, {unique: true})
    await this.db.collection('dossier_attachments').createIndex({processed: 1})

    await this.db.collection('points_prelevement').createIndex({id_point: 1, territoire: 1}, {unique: true})
    await this.db.collection('exploitations').createIndex({id_exploitation: 1, territoire: 1}, {unique: true})
    await this.db.collection('preleveurs').createIndex({id_preleveur: 1, territoire: 1}, {unique: true})

    await this.db.collection('sequences').createIndex({name: 1}, {unique: true})

    // Intégrations journalières (triplet unique preleveur/point/date)
    await this.db.collection('integrations_journalieres').createIndex({preleveur: 1, point: 1, date: 1}, {unique: true})
    await this.db.collection('integrations_journalieres').createIndex({attachmentId: 1})

    // Users et authentification
    await this.db.collection('users').createIndex({email: 1}, {unique: true})
    await this.db.collection('users').createIndex({'roles.territoire': 1})

    // Auth tokens
    await this.db.collection('auth_tokens').createIndex({token: 1}, {unique: true})
    await this.db.collection('auth_tokens').createIndex({expiresAt: 1}, {expireAfterSeconds: 0})

    // Session tokens
    await this.db.collection('session_tokens').createIndex({token: 1}, {unique: true})
    await this.db.collection('session_tokens').createIndex({userId: 1})
    await this.db.collection('session_tokens').createIndex({expiresAt: 1}, {expireAfterSeconds: 0})
  }

  disconnect(force) {
    const {client} = this
    this.client = undefined
    this.db = undefined

    return client.close(force)
  }
}

const mongo = new Mongo()

export default mongo
