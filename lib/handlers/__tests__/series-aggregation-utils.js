import test from 'ava'
import {
  deduplicateAndLimitRemarks,
  extractValuesAndRemarks
} from '../series-aggregation.js'

// Tests pour deduplicateAndLimitRemarks
test('deduplicateAndLimitRemarks - déduplique les remarques identiques', t => {
  const remarks = ['Estimation', 'Estimation', 'Compteur défectueux', 'Estimation']
  const result = deduplicateAndLimitRemarks(remarks)
  t.is(result.length, 2)
  t.true(result.includes('Estimation'))
  t.true(result.includes('Compteur défectueux'))
})

test('deduplicateAndLimitRemarks - limite à 10 remarques par défaut', t => {
  const remarks = Array.from({length: 15}, (_, i) => `Remarque ${i}`)
  const result = deduplicateAndLimitRemarks(remarks)
  t.is(result.length, 10)
})

test('deduplicateAndLimitRemarks - accepte une limite personnalisée', t => {
  const remarks = Array.from({length: 10}, (_, i) => `Remarque ${i}`)
  const result = deduplicateAndLimitRemarks(remarks, 5)
  t.is(result.length, 5)
})

test('deduplicateAndLimitRemarks - retourne tableau vide si entrée vide', t => {
  t.deepEqual(deduplicateAndLimitRemarks([]), [])
  t.deepEqual(deduplicateAndLimitRemarks(null), [])
  t.deepEqual(deduplicateAndLimitRemarks(undefined), [])
})

test('deduplicateAndLimitRemarks - préserve l\'ordre d\'apparition', t => {
  const remarks = ['C', 'A', 'B', 'A', 'C']
  const result = deduplicateAndLimitRemarks(remarks)
  // Set préserve l'ordre d'insertion (première occurrence)
  t.deepEqual(result, ['C', 'A', 'B'])
})

test('deduplicateAndLimitRemarks - limite 0 retourne tableau vide', t => {
  const remarks = ['A', 'B', 'C']
  const result = deduplicateAndLimitRemarks(remarks, 0)
  t.deepEqual(result, [])
})

// Tests pour extractValuesAndRemarks
test('extractValuesAndRemarks - extrait valeurs numériques simples', t => {
  const items = [10, 20, 30]
  const {values, remarks} = extractValuesAndRemarks(items)
  t.deepEqual(values, [10, 20, 30])
  t.deepEqual(remarks, [])
})

test('extractValuesAndRemarks - extrait objets avec value et remark', t => {
  const items = [
    {value: 10, remark: 'Estimation'},
    {value: 20, remark: 'Compteur défectueux'},
    {value: 30}
  ]
  const {values, remarks} = extractValuesAndRemarks(items)
  t.deepEqual(values, [10, 20, 30])
  t.deepEqual(remarks, ['Estimation', 'Compteur défectueux'])
})

test('extractValuesAndRemarks - extrait objets avec remarks array', t => {
  const items = [
    {value: 10, remarks: ['Estimation', 'Valeur partielle']},
    {value: 20, remarks: ['Capteur défectueux']},
    {value: 30}
  ]
  const {values, remarks} = extractValuesAndRemarks(items)
  t.deepEqual(values, [10, 20, 30])
  t.deepEqual(remarks, ['Estimation', 'Valeur partielle', 'Capteur défectueux'])
})

test('extractValuesAndRemarks - mixe valeurs numériques et objets', t => {
  const items = [
    10,
    {value: 20, remark: 'Estimation'},
    30,
    {value: 40}
  ]
  const {values, remarks} = extractValuesAndRemarks(items)
  t.deepEqual(values, [10, 20, 30, 40])
  t.deepEqual(remarks, ['Estimation'])
})

test('extractValuesAndRemarks - filtre valeurs invalides mais garde remarques', t => {
  const items = [
    10,
    null,
    {value: 20, remark: 'OK'},
    {value: Number.NaN, remark: 'Invalide'},
    {value: Number.POSITIVE_INFINITY},
    30
  ]
  const {values, remarks} = extractValuesAndRemarks(items)
  t.deepEqual(values, [10, 20, 30])
  // Les remarques sont collectées même si les valeurs sont invalides
  t.deepEqual(remarks, ['OK', 'Invalide'])
})

test('extractValuesAndRemarks - gère remark et remarks simultanés', t => {
  const items = [
    {value: 10, remark: 'Single', remarks: ['Array1', 'Array2']}
  ]
  const {values, remarks} = extractValuesAndRemarks(items)
  t.deepEqual(values, [10])
  t.deepEqual(remarks, ['Single', 'Array1', 'Array2'])
})

test('extractValuesAndRemarks - retourne vides si entrée invalide', t => {
  const {values, remarks} = extractValuesAndRemarks(null)
  t.deepEqual(values, [])
  t.deepEqual(remarks, [])
})

test('extractValuesAndRemarks - retourne vides si tableau vide', t => {
  const {values, remarks} = extractValuesAndRemarks([])
  t.deepEqual(values, [])
  t.deepEqual(remarks, [])
})

test('extractValuesAndRemarks - ignore objets sans value numérique valide', t => {
  const items = [
    {remark: 'Sans valeur'},
    {value: 10, remark: 'Avec valeur'},
    {}
  ]
  const {values, remarks} = extractValuesAndRemarks(items)
  t.deepEqual(values, [10])
  // La remarque "Sans valeur" est quand même collectée car elle existe
  t.deepEqual(remarks, ['Sans valeur', 'Avec valeur'])
})

test('extractValuesAndRemarks - gère valeurs décimales', t => {
  const items = [1.5, {value: 2.3, remark: 'Décimal'}, 3.7]
  const {values, remarks} = extractValuesAndRemarks(items)
  t.deepEqual(values, [1.5, 2.3, 3.7])
  t.deepEqual(remarks, ['Décimal'])
})

test('extractValuesAndRemarks - gère valeurs négatives', t => {
  const items = [-10, {value: -20, remark: 'Négatif'}, -30]
  const {values, remarks} = extractValuesAndRemarks(items)
  t.deepEqual(values, [-10, -20, -30])
  t.deepEqual(remarks, ['Négatif'])
})

test('extractValuesAndRemarks - gère remarques vides dans array', t => {
  const items = [
    {value: 10, remarks: []},
    {value: 20, remarks: ['OK']}
  ]
  const {values, remarks} = extractValuesAndRemarks(items)
  t.deepEqual(values, [10, 20])
  t.deepEqual(remarks, ['OK'])
})

test('extractValuesAndRemarks - ignore remarks non-array', t => {
  const items = [
    {value: 10, remarks: 'Pas un tableau'},
    {value: 20, remarks: 123}
  ]
  const {values, remarks} = extractValuesAndRemarks(items)
  t.deepEqual(values, [10, 20])
  t.deepEqual(remarks, [])
})
