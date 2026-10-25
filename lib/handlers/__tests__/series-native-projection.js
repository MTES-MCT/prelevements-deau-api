import test from 'ava'
import {mapSeriesMetadata, mapSeriesValue} from '../series.js'
import {getNativeSeriesChunkScope} from '../../models/series.js'
import {NON_NATIVE_CHUNK_WHERE} from '../../util/native-temporal.js'

test('la projection HTTP native conserve nature, fuseau et précision sub-journalière', t => {
  const extras = {nativeTemporal: true, timezone: 'Indian/Reunion', detailPointSuivi: 'Sortie', profondeur: 2}
  t.like(mapSeriesMetadata({id: 'synthetic', parameter: 'température', valueType: 'minimum', frequency: '1 second', originalFrequency: '1 second', hasSubDaily: true, extras}), {
    nativeTemporal: true, hasSubDaily: true, timezone: 'Indian/Reunion', valueType: 'minimum', originalFrequency: '1 second', extras
  })
})

test('la projection HTTP native conserve la décimale exacte, l’instant et sa provenance', t => {
  const date = '2024-02-01T00:05:06.789Z'
  const result = mapSeriesValue({date, nativeTemporal: true, periodStart: date, periodEnd: date,
    remark: 'Observation originale', metadata: {row: 13, cell: 'C13'}, timezone: 'Indian/Reunion',
    values: {value: '21.12345678901234567890123456789'}})
  t.deepEqual(result, {date, nativeTemporal: true, periodStart: date, periodEnd: date, remark: 'Observation originale',
    metadata: {row: 13, cell: 'C13'}, timezone: 'Indian/Reunion', value: '21.12345678901234567890123456789'})
})

test('les projections existantes legacy et compteurs gardent leur forme', t => {
  t.deepEqual(mapSeriesValue({date: '2026-01-01', values: {value: 12}}), {date: '2026-01-01', value: 12})
  t.deepEqual(mapSeriesValue({date: '2026-01-01', periodStart: 'start', periodEnd: 'end', compteurId: 'meter', calculationStrategy: 'METER', values: {value: 12}}),
    {date: '2026-01-01', periodStart: 'start', periodEnd: 'end', compteurId: 'meter', calculationStrategy: 'METER', value: 12})
  const legacy = mapSeriesMetadata({id: 'legacy', valueType: 'cumulative'})
  t.false(legacy.hasSubDaily)
  t.false(Object.hasOwn(legacy, 'nativeTemporal'))
  t.false(Object.hasOwn(legacy, 'extras'))
})

test('la recherche par dossier natif intersecte les points autorisés, même sans point demandé', t => {
  t.deepEqual(getNativeSeriesChunkScope({user: {role: 'INSTRUCTOR'}, pointIds: ['allowed']}), [
    {OR: [NON_NATIVE_CHUNK_WHERE, {pointPrelevementId: {in: ['allowed']}}]}
  ])
  t.deepEqual(getNativeSeriesChunkScope({user: {role: 'INSTRUCTOR'}}), [
    {OR: [NON_NATIVE_CHUNK_WHERE, {pointPrelevementId: {in: []}}]}
  ])
  t.deepEqual(getNativeSeriesChunkScope({user: {role: 'ADMIN'}}), [])
})
