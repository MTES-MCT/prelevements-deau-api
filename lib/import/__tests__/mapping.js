import test from 'ava'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {readDataFromCsvFile} from '../csv.js'
import {MODALITES_DEFINITION} from '../mapping.js'
import {frequences} from '../../nomenclature.js'

async function writeTempCsv(content) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'modalites-'))
  const filePath = path.join(tmpDir, 'modalite-suivi.csv')
  await fs.writeFile(filePath, content, 'utf8')
  return {tmpDir, filePath}
}

test('MODALITES_DEFINITION / parse fichier CSV valide', async t => {
  const csv = 'id_modalite,freq_volume_preleve,freq_debit_preleve,freq_turbidite,remarque\n1,5,7,9,Remarque A\n2,,,10,' // Ligne 2: valeurs vides -> null/undefined

  const {filePath} = await writeTempCsv(csv)
  const rows = await readDataFromCsvFile(filePath, MODALITES_DEFINITION, true)

  t.is(rows.length, 2)
  t.deepEqual(rows[0], {
    id_modalite: 1,
    freq_volume_preleve: frequences[5],
    freq_debit_preleve: frequences[7],
    freq_turbidite: frequences[9],
    remarque: 'Remarque A'
  })

  t.deepEqual(rows[1], {
    id_modalite: 2,
    freq_volume_preleve: undefined,
    freq_debit_preleve: undefined,
    freq_turbidite: frequences[10],
    remarque: undefined
  })
})

test('MODALITES_DEFINITION / ignore lignes sans id_modalite', async t => {
  const csv = 'id_modalite,freq_volume_preleve,remarque\n,5,Sans id\n3,5,Ok'

  const {filePath} = await writeTempCsv(csv)
  const rows = await readDataFromCsvFile(filePath, MODALITES_DEFINITION, true)

  t.is(rows.length, 1)
  t.is(rows[0].id_modalite, 3)
})

test('MODALITES_DEFINITION / valeur de fréquence inconnue -> warning mais garde la ligne', async t => {
  const csv = 'id_modalite,freq_volume_preleve\n4,999'

  const {filePath} = await writeTempCsv(csv)
  const rows = await readDataFromCsvFile(filePath, MODALITES_DEFINITION, true)

  t.is(rows.length, 1)
  t.deepEqual(rows[0], {id_modalite: 4, freq_volume_preleve: undefined}) // Fréquence inconnue => champ undefined
})
