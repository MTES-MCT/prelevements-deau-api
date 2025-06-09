import process from 'node:process'
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import got from 'got'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const {DS_API_ENDPOINT, DS_API_TOKEN} = process.env

async function readQueryFile(queryFileName) {
  const queryFilePath = path.join(__dirname, queryFileName)
  return fs.readFile(queryFilePath, 'utf8')
}

const queries = {
  getDemarche: await readQueryFile('getDemarche.graphql')
}

export async function fetchData(queryName, variables) {
  validateQueryName(queryName)

  const result = await got.post(DS_API_ENDPOINT, {
    json: {
      query: queries[queryName],
      variables,
      operationName: queryName
    },
    headers: {
      Authorization: `Bearer ${DS_API_TOKEN}`
    }
  }).json()

  if (result.data) {
    return result.data
  }

  const error = new Error('Error while fetching data from DS API')
  error.details = result.errors
  throw error
}

function validateQueryName(queryName) {
  if (!queries[queryName]) {
    throw new Error(`Query ${queryName} not found`)
  }
}

