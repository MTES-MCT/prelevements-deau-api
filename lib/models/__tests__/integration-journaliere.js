import test from 'ava'
import {MongoMemoryServer} from 'mongodb-memory-server'
import mongo, {ObjectId} from '../../util/mongo.js'
import {insertIntegration, getIntegration} from '../integration-journaliere.js'

let memoryServer

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

test('integration-journaliere: idempotence insertion', async t => {
  const preleveurId = new ObjectId()
  const pointId = new ObjectId()
  const date = '2024-01-01'

  const dossierId = new ObjectId()
  const first = await insertIntegration({preleveurId, pointId}, date, {dossierId, attachmentId: 'att-1'})
  const second = await insertIntegration({preleveurId, pointId}, date, {dossierId, attachmentId: 'att-1'})

  t.is(first._id.toString(), second._id.toString())

  const fetched = await getIntegration({preleveurId, pointId}, date)
  t.is(fetched._id.toString(), first._id.toString())
})
