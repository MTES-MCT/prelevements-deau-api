#!/usr/bin/env node
import process from 'node:process'
import path from 'node:path'
import {readFile} from 'node:fs/promises'

import {validateMultiParamFile} from '@fabnum/timeseries-parsers'

const filePath = process.argv[2]

if (!filePath) {
  console.error('Please provide a file path')
  process.exit(1)
}

const file = await readFile(path.resolve(filePath))

const result = await validateMultiParamFile(file)
console.log(JSON.stringify(result.data, null, 2))
