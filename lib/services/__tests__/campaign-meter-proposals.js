import test from 'ava'
import {findAbsentCampaignSerialNumbers} from '../campaign-meter-proposals.js'

test('absence checks never search blank serials or resolve a physical identity', async t => {
  const client = {compteur: {findMany: async query => {
    t.deepEqual(query, {where: {OR: ['EXISTING', 'NEW'].map(equals => ({serialNumber: {equals, mode: 'insensitive'}}))}, select: {serialNumber: true}})
    return [{serialNumber: 'existing'}]
  }}}
  t.deepEqual(await findAbsentCampaignSerialNumbers(client, [null, undefined, '', ' ', 'Existing', 'NEW', 'new']), ['NEW'])
  t.deepEqual(await findAbsentCampaignSerialNumbers({}, [null, undefined, '', ' ']), [])
})
