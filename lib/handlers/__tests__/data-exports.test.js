import test from 'ava'

import {validateCreateDataExportPayload} from '../data-exports.js'

const FIRST_ZONE_ID = '123e4567-e89b-42d3-a456-426614174000'
const SECOND_ZONE_ID = '123e4567-e89b-42d3-a456-426614174001'

function validPayload() {
  return {
    startDate: '2026-01-01',
    endDate: '2026-01-31'
  }
}

test('validateCreateDataExportPayload accepte et normalise les zones SANDRE', t => {
  const value = validateCreateDataExportPayload({
    ...validPayload(),
    sandreZoneIds: [FIRST_ZONE_ID.toUpperCase(), SECOND_ZONE_ID],
    sandreZones: [{id: FIRST_ZONE_ID, name: 'Snapshot injecté'}]
  })

  t.deepEqual(value.sandreZoneIds, [FIRST_ZONE_ID, SECOND_ZONE_ID])
  t.false(Object.hasOwn(value, 'sandreZones'))
})

test('validateCreateDataExportPayload refuse les doublons de zones SANDRE', t => {
  const error = t.throws(() => validateCreateDataExportPayload({
    ...validPayload(),
    sandreZoneIds: [FIRST_ZONE_ID, FIRST_ZONE_ID.toUpperCase()]
  }))

  t.is(error.status, 400)
  t.regex(error.message, /duplicate value/)
})
