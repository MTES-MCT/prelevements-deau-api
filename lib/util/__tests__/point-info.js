import test from 'ava'
import {MongoMemoryServer} from 'mongodb-memory-server'
import mongo, {ObjectId} from '../../util/mongo.js'
import {enrichWithPointInfo, buildPointInfo} from '../point-info.js'

let memoryServer

// Collection mock points_prelevement minimaliste pour test
async function seedPoints(points) {
  await mongo.db.collection('points_prelevement').insertMany(points)
}

async function fetchPoints(ids) {
  const objectIds = ids.map(id => ObjectId.createFromHexString(id))
  return mongo.db.collection('points_prelevement').find({_id: {$in: objectIds}}).toArray()
}

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

test('enrichWithPointInfo enrichit les objets avec pointInfo', async t => {
  const p1 = new ObjectId()
  const p2 = new ObjectId()
  await seedPoints([
    {_id: p1, id_point: 10, nom: 'Source A'},
    {_id: p2, id_point: 11, bnpe: {nom: 'BNPE-B'}}
  ])
  const list = [
    {id: 1, point: p1},
    {id: 2, point: p2},
    {id: 3, point: null}
  ]

  await enrichWithPointInfo(list, {
    getId(i) {
      return i.point
    },
    setInfo(i, info) {
      i.pointInfo = info
    },
    fetchPoints
  })

  t.deepEqual(list[0].pointInfo, buildPointInfo({_id: p1, id_point: 10, nom: 'Source A'}))
  t.is(list[1].pointInfo.nom, 'BNPE-B')
  t.is(list[2].pointInfo, undefined) // Pas d'id => pas de set
})

test('enrichWithPointInfo liste vide', async t => {
  const list = []
  await enrichWithPointInfo(list, {
    getId() {
      return null
    },
    setInfo() {},
    fetchPoints
  })
  t.deepEqual(list, [])
})
