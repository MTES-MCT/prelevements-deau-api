import test from 'ava'

import {rowToExportObject} from '../data-exports.js'

test('rowToExportObject identifie les données télérelevées', t => {
  t.is(rowToExportObject({isTelemetry: true}).donneeTelerelevee, 'Oui')
  t.is(rowToExportObject({isTelemetry: false}).donneeTelerelevee, 'Non')
  t.is(rowToExportObject({}).donneeTelerelevee, 'Non')
})
