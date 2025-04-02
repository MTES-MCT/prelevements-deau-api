import mongo from '../lib/util/mongo.js'
import * as storage from '../lib/models/internal/in-memory.js'

async function importBSS(bss) {
  console.log('Importation des données BSS...')
  if (!bss || bss.length === 0) {
    console.error('Le fichier est vide !')
    return
  }

  const collection = mongo.db.collection('bss')

  const documents = bss.map(b => ({
    id_bss: b.id_bss,
    lien_infoterre: b.lien_infoterre
  }))

  try {
    const result = await collection.insertMany(documents)
    console.log('=> ' + result.insertedCount + ' documents BSS insérés')
  } catch (error) {
    console.error('Erreur lors de l’importation : ' + error)
  }
}

async function importBNPE(bnpe) {
  console.log('Importation des données BNPE...')
  if (!bnpe || bnpe.length === 0) {
    console.error('Le fichier est vide !')
    return
  }

  const collection = mongo.db.collection('bnpe')

  const documents = bnpe.map(b => ({
    code_point_prelevement: b.code_point_prelevement,
    uri_ouvrage: b.uri_ouvrage
  }))

  try {
    const result = await collection.insertMany(documents)
    console.log('=> ' + result.insertedCount + ' documents BNPE insérés')
  } catch (error) {
    console.error('Erreur lors de l’importation : ' + error)
  }
}

await mongo.connect()

await importBSS(storage.bss)
await importBNPE(storage.bnpe)

await mongo.disconnect()
