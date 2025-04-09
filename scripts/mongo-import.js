import mongo from '../lib/util/mongo.js'
import * as storage from '../lib/models/internal/in-memory.js'

  }



  }))

  }
}

    console.error('Le fichier est vide !')
    return
  }



  try {
  } catch (error) {
  }
}

await mongo.connect()

await importCollection(storage.beneficiaires, 'preleveurs')
await importCollection(storage.exploitations, 'exploitations')
await importCollection(storage.pointsPrelevement, 'points_prelevement')

await mongo.disconnect()
