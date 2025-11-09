import test from 'ava'
import {ObjectId} from 'mongodb'
import mongo from '../../util/mongo.js'
import {setupTestMongo} from '../../util/test-helpers/mongo.js'
import {getPointInfo} from '../point-prelevement.js'

setupTestMongo(test)

async function seedPoints(points) {
  await mongo.db.collection('points_prelevement').insertMany(points)
}

test('getPointInfo retourne les infos d\'un point avec nom', async t => {
  const p1 = new ObjectId()
  await seedPoints([
    {
      _id: p1,
      id_point: 10,
      nom: 'Source A',
      territoire: 'TEST',
      commune: {code: '12345', nom: 'Test'},
      geometry: {type: 'Point', coordinates: [1, 2]}
    }
  ])

  const info = await getPointInfo(p1)

  t.is(info._id.toString(), p1.toString())
  t.is(info.id_point, 10)
  t.is(info.nom, 'Source A')
})

test('getPointInfo fallback sur id_point si pas de nom', async t => {
  const p1 = new ObjectId()
  await seedPoints([
    {
      _id: p1,
      id_point: 42,
      territoire: 'TEST',
      bss: {id_bss: '12345', lien: 'https://example.com'},
      createdAt: new Date()
    }
  ])

  const info = await getPointInfo(p1)

  t.is(info._id.toString(), p1.toString())
  t.is(info.id_point, 42)
  t.is(info.nom, 'Point 42')
})

test('getPointInfo ne retourne que les champs nécessaires', async t => {
  const p1 = new ObjectId()
  await seedPoints([
    {
      _id: p1,
      id_point: 99,
      nom: 'Puits Principal',
      territoire: 'BRETAGNE',
      commune: {code: '35238', nom: 'Rennes'},
      bss: {id_bss: 'BSS001', lien: 'https://example.com'},
      bnpe: {point: 'BNPE123', lien: 'https://example.com', nom: 'BNPE Test'},
      meso: {code: 'MESO01', nom: 'Meso test'},
      geometry: {type: 'Point', coordinates: [1.5, 48.1]},
      createdAt: new Date(),
      updatedAt: new Date()
    }
  ])

  const info = await getPointInfo(p1)

  // Vérifie que seuls _id, id_point et nom sont présents
  const keys = Object.keys(info)
  t.is(keys.length, 3)
  t.deepEqual(keys.sort(), ['_id', 'id_point', 'nom'])
  t.is(info._id.toString(), p1.toString())
  t.is(info.id_point, 99)
  t.is(info.nom, 'Puits Principal')
})

test('getPointInfo retourne null si point inexistant', async t => {
  const info = await getPointInfo(new ObjectId())
  t.is(info, null)
})

test('getPointInfo retourne null si pointId null', async t => {
  const info = await getPointInfo(null)
  t.is(info, null)
})
