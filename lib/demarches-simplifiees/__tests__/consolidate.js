import test from 'ava'
import {compareDays} from '../consolidate.js'

/* Tests pour compareDays */

test('compareDays - tous nouveaux jours', t => {
  const existingDays = []
  const newDays = ['2025-01-01', '2025-01-02', '2025-01-03']
  const result = compareDays(existingDays, newDays)

  t.is(result.toAdd.length, 3)
  t.deepEqual(result.toAdd, ['2025-01-01', '2025-01-02', '2025-01-03'])
  t.is(result.toRemove.length, 0)
  t.is(result.unchangedCount, 0)
})

test('compareDays - tous jours inchangés', t => {
  const existingDays = ['2025-01-01', '2025-01-02', '2025-01-03']
  const newDays = ['2025-01-01', '2025-01-02', '2025-01-03']
  const result = compareDays(existingDays, newDays)

  t.is(result.toAdd.length, 0)
  t.is(result.toRemove.length, 0)
  t.is(result.unchangedCount, 3)
})

test('compareDays - tous jours supprimés', t => {
  const existingDays = ['2025-01-01', '2025-01-02', '2025-01-03']
  const newDays = []
  const result = compareDays(existingDays, newDays)

  t.is(result.toAdd.length, 0)
  t.is(result.toRemove.length, 3)
  t.deepEqual(result.toRemove, ['2025-01-01', '2025-01-02', '2025-01-03'])
  t.is(result.unchangedCount, 0)
})

test('compareDays - scénario mixte', t => {
  const existingDays = ['2025-01-01', '2025-01-02', '2025-01-03', '2025-01-04']
  const newDays = ['2025-01-01', '2025-01-03', '2025-01-05', '2025-01-06']
  const result = compareDays(existingDays, newDays)

  // Jours à ajouter: 2025-01-05, 2025-01-06
  t.is(result.toAdd.length, 2)
  t.true(result.toAdd.includes('2025-01-05'))
  t.true(result.toAdd.includes('2025-01-06'))

  // Jours à supprimer: 2025-01-02, 2025-01-04
  t.is(result.toRemove.length, 2)
  t.true(result.toRemove.includes('2025-01-02'))
  t.true(result.toRemove.includes('2025-01-04'))

  // Jours inchangés: 2025-01-01, 2025-01-03
  t.is(result.unchangedCount, 2)
})

test('compareDays - ordre différent mais mêmes jours', t => {
  const existingDays = ['2025-01-03', '2025-01-01', '2025-01-02']
  const newDays = ['2025-01-01', '2025-01-02', '2025-01-03']
  const result = compareDays(existingDays, newDays)

  t.is(result.toAdd.length, 0)
  t.is(result.toRemove.length, 0)
  t.is(result.unchangedCount, 3)
})

test('compareDays - doublons dans les entrées', t => {
  const existingDays = ['2025-01-01', '2025-01-01', '2025-01-02']
  const newDays = ['2025-01-01', '2025-01-03', '2025-01-03']
  const result = compareDays(existingDays, newDays)

  // Les doublons sont traités comme des valeurs uniques grâce au Set
  // ToAdd contient les éléments de newDays qui ne sont pas dans existingSet
  // NewDays a 2 occurrences de '2025-01-03', donc toAdd aura aussi 2 occurrences
  t.is(result.toAdd.length, 2)
  t.is(result.toAdd.filter(d => d === '2025-01-03').length, 2)

  // ToRemove contient '2025-01-02' qui apparaît 1 fois dans existingDays
  t.is(result.toRemove.length, 1)
  t.true(result.toRemove.includes('2025-01-02'))

  // UnchangedCount compte combien de fois les éléments de newDays sont dans existingSet
  // NewDays a 1 occurrence de '2025-01-01' qui est dans existingSet
  t.is(result.unchangedCount, 1)
})

test('compareDays - entrées vides', t => {
  const result = compareDays([], [])

  t.is(result.toAdd.length, 0)
  t.is(result.toRemove.length, 0)
  t.is(result.unchangedCount, 0)
})

test('compareDays - un seul jour ajouté', t => {
  const existingDays = ['2025-01-01']
  const newDays = ['2025-01-01', '2025-01-02']
  const result = compareDays(existingDays, newDays)

  t.is(result.toAdd.length, 1)
  t.deepEqual(result.toAdd, ['2025-01-02'])
  t.is(result.toRemove.length, 0)
  t.is(result.unchangedCount, 1)
})

test('compareDays - un seul jour supprimé', t => {
  const existingDays = ['2025-01-01', '2025-01-02']
  const newDays = ['2025-01-01']
  const result = compareDays(existingDays, newDays)

  t.is(result.toAdd.length, 0)
  t.is(result.toRemove.length, 1)
  t.deepEqual(result.toRemove, ['2025-01-02'])
  t.is(result.unchangedCount, 1)
})

test('compareDays - remplacement complet', t => {
  const existingDays = ['2025-01-01', '2025-01-02']
  const newDays = ['2025-01-03', '2025-01-04']
  const result = compareDays(existingDays, newDays)

  t.is(result.toAdd.length, 2)
  t.deepEqual(result.toAdd.sort(), ['2025-01-03', '2025-01-04'])
  t.is(result.toRemove.length, 2)
  t.deepEqual(result.toRemove.sort(), ['2025-01-01', '2025-01-02'])
  t.is(result.unchangedCount, 0)
})
