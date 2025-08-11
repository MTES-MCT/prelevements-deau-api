import mongo from '../util/mongo.js'

let _getTerritoiresPromise

export async function getTerritoires() {
  _getTerritoiresPromise ||= mongo.db.collection('territoires').find().toArray()
  return _getTerritoiresPromise
}

export async function getTerritoire(codeTerritoire) {
  const territoires = await getTerritoires()
  return territoires.find(t => t.code === codeTerritoire)
}
