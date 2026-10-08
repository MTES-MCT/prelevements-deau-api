import test from 'ava'
import {isDatabaseWriteConflict} from '../database-write-conflict.js'

test('classe les conflits Prisma, SQL et adaptateur sans masquer les autres erreurs', t => {
  for (const error of [{code: 'P2034'}, {code: '40001'}, {cause: {code: '40P01'}},
    {code: 'P2010', meta: {driverAdapterError: {cause: {originalCode: '40001'}}}}]) {
    t.true(isDatabaseWriteConflict(error))
  }
  t.false(isDatabaseWriteConflict({code: 'P2010', meta: {driverAdapterError: {cause: {originalCode: '23505'}}}}))
  t.false(isDatabaseWriteConflict(null))
})
