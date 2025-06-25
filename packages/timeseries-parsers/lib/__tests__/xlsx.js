import test from 'ava'
import {readAsNumber} from '../xlsx.js'

// Ensure that numerical zero values are correctly read

test('readAsNumber handles 0 as a valid value', t => {
  const sheet = {
    A1: {v: 0, t: 'n'}
  }

  t.is(readAsNumber(sheet, 0, 0), 0)
})
