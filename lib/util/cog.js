import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'

import {keyBy} from 'lodash-es'

const require = createRequire(import.meta.url)
const jsonPath = require.resolve('@etalab/decoupage-administratif/data/communes.json')
const communes = JSON.parse(await readFile(jsonPath, 'utf8'))

const indexedCommunes = keyBy(communes, 'code')

export function getCommune(codeCommune) {
  return indexedCommunes[codeCommune]
}
