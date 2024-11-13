import test from 'ava'
import {MongoMemoryServer} from 'mongodb-memory-server'
import mongo from '../../util/mongo.js'
import {createDossier, getFileFromDossier} from '../dossier.js'

let mongod

test.before('start server', async () => {
  mongod = await MongoMemoryServer.create()
  await mongo.connect(mongod.getUri())
})

test.after.always('cleanup', async () => {
  await mongo.disconnect()
  await mongod.stop()
})

test('getFileFromDossier should return the correct file when it exists in the dossier', async t => {
  const data = {
    number: 42,
    champs: [],
    demarche: {revision: {id: 'UHJvY2VkdXJlUmV2aXNpb24tMTM1NTYw'}}
  }
  const file = {
    filename: 'test.xlsx',
    checksum: '1234',
    size: 1234
  }

  await createDossier(data, [file], {})

  const res = await getFileFromDossier(data.number, file.checksum)
  t.is(res.filename, file.filename)
  t.is(res.checksum, file.checksum)
  t.is(res.size, file.size)
})

test('getFileFromDossier should return null when the file does not exist in the dossier', async t => {
  const data = {
    number: 42,
    champs: [],
    demarche: {revision: {id: 'UHJvY2VkdXJlUmV2aXNpb24tMTM1NTYw'}}
  }
  const file = {
    filename: 'test.xlsx',
    checksum: '1234',
    size: 1234
  }

  await createDossier(data, [file], {})

  const res = await getFileFromDossier(42, '0000')
  t.is(res, null)
})

test('getFileFromDossier should return null when the dossier does not exist', async t => {
  const res = await getFileFromDossier(42, '0000')
  t.is(res, null)
})
