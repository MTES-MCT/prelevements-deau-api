import mongo from '../util/mongo.js'

export async function insertVolumesPreleves(exploitationId, volumesPreleves) {
  if (volumesPreleves.length === 0) {
    return
  }

  const operations = volumesPreleves.map(volumePreleve => ({
    updateOne: {
      filter: {
        exploitation: exploitationId,
        date: volumePreleve.date
      },
      update: {
        $set: {
          volume: volumePreleve.volume,
          remarque: volumePreleve.remarque
        }
      },
      upsert: true
    }
  }))

  await mongo.db.collection('volumes_preleves').bulkWrite(operations)
}
