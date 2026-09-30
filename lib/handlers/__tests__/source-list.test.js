import test from 'ava'
import {parseSourceListQuery} from '../sources.js'

test('la liste des sources accepte summary en conservant les filtres et le défaut historique', t => {
  const filters = {page: '2', pageSize: '50', types: 'API', statuses: 'VALIDATED'}
  const legacy = parseSourceListQuery(filters)
  t.false(Object.hasOwn(legacy, 'view'))
  t.deepEqual(parseSourceListQuery({...filters, view: 'summary'}), {...legacy, view: 'summary'})
  t.is(legacy.page, 2)
  t.deepEqual(legacy.types, ['API'])
  t.deepEqual(legacy.statuses, ['VALIDATED'])
  for (const view of ['', 'full', ['summary']]) {
    t.is(t.throws(() => parseSourceListQuery({...filters, view})).statusCode, 400)
  }
})
