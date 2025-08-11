import mongo from '../util/mongo.js'

async function _getTerritoires() {
  return mongo.db.collection('territoires').find().toArray()
}

const territoires = await _getTerritoires()

export async function getTerritoire(codeTerritoire) {
  return territoires.find(t => t.code === codeTerritoire)
}

export async function getTerritoires() {
  return territoires
}
