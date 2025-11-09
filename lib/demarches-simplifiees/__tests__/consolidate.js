import test from 'ava'
import {compareDays, computeAttachmentsStats} from '../consolidate.js'

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

/* Tests pour la logique de statut dossier */

test('compareDays - dossier non accepté = aucun jour intégrable', t => {
  // Simule le comportement : si dossier.status !== 'accepte', integrableDays = []
  const existingDays = ['2025-01-01', '2025-01-02', '2025-01-03']
  const newDays = [] // Aucun jour intégrable car dossier non accepté
  const result = compareDays(existingDays, newDays)

  // Tous les jours existants doivent être supprimés
  t.is(result.toAdd.length, 0)
  t.is(result.toRemove.length, 3)
  t.deepEqual(result.toRemove.sort(), ['2025-01-01', '2025-01-02', '2025-01-03'])
  t.is(result.unchangedCount, 0)
})

test('compareDays - passage de non-accepté à accepté', t => {
  // Avant: dossier non accepté, aucune intégration
  const existingDays = []
  // Après: dossier accepté, jours présents dans le fichier
  const newDays = ['2025-01-01', '2025-01-02', '2025-01-03']
  const result = compareDays(existingDays, newDays)

  // Tous les jours doivent être ajoutés
  t.is(result.toAdd.length, 3)
  t.deepEqual(result.toAdd.sort(), ['2025-01-01', '2025-01-02', '2025-01-03'])
  t.is(result.toRemove.length, 0)
  t.is(result.unchangedCount, 0)
})

/* Tests pour computeAttachmentsStats */

test('computeAttachmentsStats - aucun attachment', t => {
  const attachments = []
  const stats = computeAttachmentsStats(attachments)

  t.is(stats.attachmentCount, 0)
  t.is(stats.unprocessedAttachmentCount, 0)
  t.is(stats.unparsedAttachmentCount, 0)
  t.deepEqual(stats.parsedAttachmentCounts, {})
  t.is(stats.totalVolumePreleve, 0)
})

test('computeAttachmentsStats - un seul attachment non traité', t => {
  const attachments = [
    {_id: '1', processed: false}
  ]
  const stats = computeAttachmentsStats(attachments)

  t.is(stats.attachmentCount, 1)
  t.is(stats.unprocessedAttachmentCount, 1)
  t.is(stats.unparsedAttachmentCount, 0)
  t.deepEqual(stats.parsedAttachmentCounts, {})
  t.is(stats.totalVolumePreleve, 0)
})

test('computeAttachmentsStats - attachments avec différents statuts', t => {
  const attachments = [
    {_id: '1', processed: false},
    {_id: '2', processed: true, validationStatus: 'success', result: {totalVolumePreleve: 100}},
    {_id: '3', processed: true, validationStatus: 'warning', result: {totalVolumePreleve: 50}},
    {_id: '4', processed: true, validationStatus: 'error', result: {totalVolumePreleve: 25}}
  ]
  const stats = computeAttachmentsStats(attachments)

  t.is(stats.attachmentCount, 4)
  t.is(stats.unprocessedAttachmentCount, 1)
  t.is(stats.unparsedAttachmentCount, 0)
  t.is(stats.parsedAttachmentCounts.success, 1)
  t.is(stats.parsedAttachmentCounts.warning, 1)
  t.is(stats.parsedAttachmentCounts.error, 1)
  t.is(stats.totalVolumePreleve, 175)
})

test('computeAttachmentsStats - attachment sans result', t => {
  const attachments = [
    {_id: '1', processed: true, validationStatus: 'success', result: {totalVolumePreleve: 100}},
    {_id: '2', processed: true, validationStatus: 'success'},
    {_id: '3', processed: true, validationStatus: 'success', result: {totalVolumePreleve: 50}}
  ]
  const stats = computeAttachmentsStats(attachments)

  t.is(stats.attachmentCount, 3)
  t.is(stats.parsedAttachmentCounts.success, 3)
  t.is(stats.totalVolumePreleve, 150)
})

test('computeAttachmentsStats - attachment avec result mais sans totalVolumePreleve', t => {
  const attachments = [
    {_id: '1', processed: true, validationStatus: 'success', result: {totalVolumePreleve: 100}},
    {_id: '2', processed: true, validationStatus: 'success', result: {seriesCount: 5}},
    {_id: '3', processed: true, validationStatus: 'success', result: {totalVolumePreleve: 50}}
  ]
  const stats = computeAttachmentsStats(attachments)

  t.is(stats.totalVolumePreleve, 150)
})

test('computeAttachmentsStats - valeurs décimales', t => {
  const attachments = [
    {_id: '1', processed: true, validationStatus: 'success', result: {totalVolumePreleve: 10.5}},
    {_id: '2', processed: true, validationStatus: 'success', result: {totalVolumePreleve: 20.75}},
    {_id: '3', processed: true, validationStatus: 'success', result: {totalVolumePreleve: 5.25}}
  ]
  const stats = computeAttachmentsStats(attachments)

  t.is(stats.totalVolumePreleve, 36.5)
})

test('computeAttachmentsStats - volume 0 est compté', t => {
  const attachments = [
    {_id: '1', processed: true, validationStatus: 'success', result: {totalVolumePreleve: 0}},
    {_id: '2', processed: true, validationStatus: 'success', result: {totalVolumePreleve: 10}}
  ]
  const stats = computeAttachmentsStats(attachments)

  t.is(stats.totalVolumePreleve, 10)
})

test('computeAttachmentsStats - attachment non parsé (processed mais sans validationStatus)', t => {
  const attachments = [
    {_id: '1', processed: true, validationStatus: 'success', result: {totalVolumePreleve: 100}},
    {_id: '2', processed: true},
    {_id: '3', processed: true, validationStatus: 'warning', result: {totalVolumePreleve: 50}}
  ]
  const stats = computeAttachmentsStats(attachments)

  t.is(stats.attachmentCount, 3)
  t.is(stats.unparsedAttachmentCount, 1)
  t.is(stats.totalVolumePreleve, 150)
})

test('computeAttachmentsStats - plusieurs attachments avec même validationStatus', t => {
  const attachments = [
    {_id: '1', processed: true, validationStatus: 'success', result: {totalVolumePreleve: 100}},
    {_id: '2', processed: true, validationStatus: 'success', result: {totalVolumePreleve: 200}},
    {_id: '3', processed: true, validationStatus: 'success', result: {totalVolumePreleve: 300}}
  ]
  const stats = computeAttachmentsStats(attachments)

  t.is(stats.attachmentCount, 3)
  t.is(stats.parsedAttachmentCounts.success, 3)
  t.is(stats.totalVolumePreleve, 600)
})
