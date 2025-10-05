#!/usr/bin/env node
import process from 'node:process'
import path from 'node:path'
import {readFile} from 'node:fs/promises'

import {extractMultiParamFile, extractCamionCiterne} from '@fabnum/prelevements-deau-timeseries-parsers'

const filePath = process.argv[2]

if (!filePath) {
  console.error('Please provide a file path')
  process.exit(1)
}

const fileType = process.argv[3] || 'multi-params'

if (!['multi-params', 'camion-citerne'].includes(fileType)) {
  console.error('Invalid file type')
  process.exit(1)
}

const file = await readFile(path.resolve(filePath))

const validationMethod = fileType === 'multi-params' ? extractMultiParamFile : extractCamionCiterne

const result = await validationMethod(file)

console.log(JSON.stringify(result, null, 2))
