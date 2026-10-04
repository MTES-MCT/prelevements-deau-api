import test from 'ava'
import {lockCampaignMeterPoints} from '../campaign-meter-publication.js'

test('les verrous couvrent aussi les points revendiqués sans allocation et les reçus antérieurs, dans un ordre stable', async t => {
  const locks = []
  const tx = {
    meterAllocation: {findMany: async () => [{exploitation: {pointPrelevementId: 'b'}}]},
    chunk: {findMany: async () => [{pointPrelevementId: 'c'}, {pointPrelevementId: 'b'}]},
    $executeRaw: async (_strings, namespace, pointId) => { locks.push([namespace, pointId]) }
  }
  await lockCampaignMeterPoints(tx, 'campaign', ['meter'], ['a'])
  t.deepEqual(locks, ['a', 'b', 'c'].map(pointId => ['volumes-from-index', pointId]))
})
