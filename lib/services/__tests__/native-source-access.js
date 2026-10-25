import test from 'ava'
import {scopeNativeSource} from '../native-source-access.js'

test('une source native entière garde ses diagnostics mais ne divulgue jamais les reçus techniques', t => {
  const source = {status: 'COMPLETED', metadata: {nativeTemporal: true, provenance: 'DN', nativeBatch: {hashes: ['internal']}, parsingErrors: [{code: 'FILE_WARNING'}]},
    _count: {chunks: 2}, chunks: [{seriesKey: 'accepted', instructionStatus: 'VALIDATED', metadata: {totalWaterVolumeWithdrawn: 12}},
      {seriesKey: 'pending', instructionStatus: 'PENDING', metadata: {totalWaterVolumeWithdrawn: 100}}], declaration: {files: [{filename: 'original.xlsx'}]}}
  const result = scopeNativeSource(source)
  t.is(result.metadata.totalWaterVolumeWithdrawn, 112)
  t.deepEqual(result.metadata.parsingErrors, [{code: 'FILE_WARNING'}])
  t.falsy(result.metadata.nativeBatch)
  t.deepEqual(result.declaration.files, source.declaration.files)
  t.truthy(source.metadata.nativeBatch)
})

test('une source native en cours ne présente pas de totaux publiés', t => {
  const result = scopeNativeSource({status: 'PROCESSING', metadata: {nativeTemporal: true, totalWaterVolumeWithdrawn: 123},
    chunks: [{instructionStatus: 'VALIDATED', metadata: {totalWaterVolumeWithdrawn: 123}}]})
  t.is(result.metadata.totalWaterVolumeWithdrawn, 0)
})

test('le circuit existant conserve exactement sa projection', t => {
  const source = {metadata: {totalWaterVolumeWithdrawn: 123}, chunks: []}
  t.is(scopeNativeSource(source), source)
})
