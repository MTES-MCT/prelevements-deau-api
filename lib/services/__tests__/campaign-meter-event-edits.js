import test from 'ava'
import {pendingCampaignMeterId} from '../campaign-meter-event-edits.js'
import {prepareCampaignResponseMeters} from '../campaign-response-meters.js'
import {campaignIndexDraftSchema, validateCampaignValue, validateCampaignDraft} from '../../validation/campaigns.js'

const id = suffix => `10000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`
const target = {id: id(1), pointPrelevementId: id(2), meters: []}
const campaign = {indexDates: ['2026-01-01', '2026-04-01', '2026-07-01'], periods: []}
const event = {targetId: target.id, type: 'REPLACEMENT', at: '2026-02-01', previousCompteurId: null,
  nextMeter: {serialNumber: 'AVANT', identifier: 'repère'}, previousIndex: '200', nextIndex: '0', reason: 'Remplacement'}
const pendingId = pendingCampaignMeterId(event)
const reading = {targetId: target.id, compteurId: pendingId, readingDate: '2026-04-01', value: '300.1234',
  sourceChunkValueId: id(3), sourceValueUpdatedAt: '2026-09-10T12:00:00.000Z', meterConfirmed: true}
const previousDraft = {comment: 'À conserver', readings: [reading], meterEvents: [event]}
const edit = (changes = {}) => ({...event, ...changes,
  previousEvent: {at: event.at, previousCompteurId: event.previousCompteurId, nextMeter: event.nextMeter}})
const prepare = (incoming, saved = previousDraft, targets = [target]) => prepareCampaignResponseMeters(targets, incoming, {campaign, previousDraft: saved})

test('modifier une identification pending conserve intégralement les valeurs et références du brouillon', t => {
  const incoming = {...previousDraft, meterEvents: [edit({nextMeter: {serialNumber: 'APRÈS', identifier: 'nouveau repère'}})]}
  const before = structuredClone(incoming)
  const result = prepare(incoming)
  const nextId = result.draft.meterEvents[0].nextCompteurId
  t.not(nextId, pendingId)
  t.deepEqual(result.draftForSave.readings, [{...reading, compteurId: nextId}])
  t.deepEqual(result.draftForSave.meterEvents[0].nextMeter, {serialNumber: 'APRÈS', identifier: 'nouveau repère'})
  t.false(Object.hasOwn(result.draftForSave.meterEvents[0], 'previousEvent'))
  t.false(Object.hasOwn(result.draft.meterEvents[0], 'previousEvent'))
  t.deepEqual(incoming, before)
  t.deepEqual(target.meters, [])
  t.is(result.draftForSave.comment, previousDraft.comment)
  t.notThrows(() => validateCampaignDraft('INDEX', result.draftForSave, {campaign, targets: result.targets}))
})

test('déplacer une date entre deux relevés change les UUID virtuels mais ne change aucune valeur', t => {
  const result = prepare({...previousDraft, meterEvents: [edit({at: '2026-03-01'})]})
  t.not(result.draft.readings[0].compteurId, pendingId)
  t.is(result.draft.readings[0].value, reading.value)
  t.is(result.targets[0].meters[0].startDate, '2026-03-01')
})

test('corriger un index ou un motif garde la même identité pending', t => {
  const result = prepare({...previousDraft, meterEvents: [edit({previousIndex: '250', reason: 'Motif corrigé'})]})
  t.deepEqual(result.draftForSave.readings, [reading])
  t.is(result.draft.meterEvents[0].previousIndex, '250')
  t.is(result.draft.meterEvents[0].reason, 'Motif corrigé')
})

test('une remise à zéro historique sans nextCompteurId garde la même identité lorsque le formulaire la précise', t => {
  const previousCompteurId = id(40)
  const original = {...event, type: 'RESET', previousCompteurId}
  delete original.nextMeter
  const saved = {...previousDraft, readings: [{...reading, compteurId: previousCompteurId}], meterEvents: [original]}
  const incoming = {...saved, meterEvents: [{...original, nextCompteurId: previousCompteurId, previousIndex: '220',
    previousEvent: {at: original.at, previousCompteurId}}]}
  const targets = [{...target, meters: [{compteurId: previousCompteurId}]}]
  const result = prepare(incoming, saved, targets)
  t.deepEqual(result.draftForSave.readings, saved.readings)
  t.is(result.draftForSave.meterEvents[0].previousIndex, '220')
  t.is(result.draftForSave.meterEvents[0].nextCompteurId, previousCompteurId)
  t.deepEqual(prepare(incoming, result.draftForSave, targets).draftForSave, result.draftForSave)
  const omitted = {...result.draftForSave, meterEvents: [{...original, previousIndex: '230', previousEvent: {at: original.at, previousCompteurId}}]}
  t.notThrows(() => prepare(omitted, result.draftForSave, targets))
})

test('transformer une remise à zéro connue sans dépendance en remplacement ne renomme pas l’ancien compteur', t => {
  const previousCompteurId = id(40)
  const original = {...event, type: 'RESET', previousCompteurId, nextCompteurId: previousCompteurId}
  delete original.nextMeter
  const saved = {...previousDraft, readings: [], meterEvents: [original]}
  const incoming = {...saved, meterEvents: [{...event, previousCompteurId, previousEvent: {at: original.at, previousCompteurId}}]}
  const targets = [{...target, meters: [{compteurId: previousCompteurId}]}]
  const result = prepare(incoming, saved, targets)
  t.is(result.targets[0].meters.length, 2)
  t.deepEqual(result.targets[0].meters[0], targets[0].meters[0])
  t.true(result.targets[0].meters[1].pending)
  t.is(targets[0].meters.length, 1)
})

test('un snapshot en attente peut rejouer le marqueur consommé tout en conservant la dernière valeur saisie', t => {
  const incoming = {...previousDraft, meterEvents: [edit({at: '2026-03-01', nextMeter: {serialNumber: 'APRÈS'}})]}
  const first = prepare(incoming)
  const queued = {...incoming, readings: [{...reading, value: '350.5678'}]}
  const second = prepare(queued, first.draftForSave)
  t.is(second.draft.readings[0].value, '350.5678')
  t.is(second.draft.readings[0].compteurId, first.draft.readings[0].compteurId)
  t.false(Object.hasOwn(second.draftForSave.meterEvents[0], 'previousEvent'))
  t.notThrows(() => validateCampaignDraft('INDEX', second.draftForSave, {campaign, targets: second.targets}))
})

test('le rejeu fonctionne aussi quand seule l’identification change, sans changement de clé', t => {
  const incoming = {...previousDraft, meterEvents: [edit({nextMeter: {serialNumber: 'APRÈS'}})]}
  const first = prepare(incoming)
  t.deepEqual(prepare(incoming, first.draftForSave).draftForSave, first.draftForSave)
})

test('modifier le premier remplacement propage les UUID dans une chaîne, même présentée à l’envers', t => {
  const second = {...event, at: '2026-05-01', previousCompteurId: pendingId, nextMeter: {serialNumber: 'SECOND'}}
  const secondId = pendingCampaignMeterId(second)
  const reset = {...event, type: 'RESET', at: '2026-06-01', previousCompteurId: secondId, nextCompteurId: secondId}
  delete reset.nextMeter
  const lastReading = {...reading, compteurId: secondId, readingDate: '2026-07-01', value: '0', sourceChunkValueId: undefined, sourceValueUpdatedAt: undefined}
  const saved = {...previousDraft, readings: [reading, lastReading], meterEvents: [reset, second, event]}
  const incoming = {...saved, meterEvents: [reset, second, edit({nextMeter: {serialNumber: 'PREMIER CORRIGÉ'}})]}
  const result = prepare(incoming, saved)
  const [newReset, newSecond, first] = result.draft.meterEvents
  t.not(first.nextCompteurId, pendingId)
  t.not(newSecond.nextCompteurId, secondId)
  t.is(newSecond.previousCompteurId, first.nextCompteurId)
  t.is(newReset.previousCompteurId, newSecond.nextCompteurId)
  t.is(newReset.nextCompteurId, newSecond.nextCompteurId)
  t.deepEqual(result.draft.readings.map(item => item.value), [reading.value, '0'])
  t.deepEqual(result.draft.readings.map(item => item.compteurId), [first.nextCompteurId, newSecond.nextCompteurId])
  t.deepEqual(prepare(incoming, result.draftForSave).draftForSave, result.draftForSave)
})

test('le remapping ne touche jamais les relevés d’un autre point', t => {
  const other = {...target, id: id(10)}
  const outside = {...reading, targetId: other.id}
  const result = prepare({...previousDraft, readings: [reading, outside], meterEvents: [edit({nextMeter: {serialNumber: 'APRÈS'}})]}, previousDraft, [target, other])
  t.not(result.draft.readings[0].compteurId, pendingId)
  t.deepEqual(result.draft.readings[1], outside)
})

for (const date of ['2026-04-01', '2026-05-01']) {
  test(`une date qui atteint ou traverse un relevé est refusée sans réattribuer les valeurs : ${date}`, t => {
    const incoming = {...previousDraft, meterEvents: [edit({at: date})]}
    const before = structuredClone(incoming)
    const error = t.throws(() => prepare(incoming))
    t.is(error.statusCode, 400)
    t.regex(error.message, /relevés déjà saisis/)
    t.deepEqual(incoming, before)
    t.deepEqual(previousDraft.readings, [reading])
  })
}

test('les relevés du brouillon sauvegardé protègent aussi un déplacement quand le client les omet', t => {
  t.is(t.throws(() => prepare({...previousDraft, readings: [], meterEvents: [edit({at: '2026-05-01'})]})).statusCode, 400)
})

test('changer de type avec des relevés dépendants est refusé, sans les supprimer', t => {
  const changed = edit({type: 'RESET', nextCompteurId: null})
  delete changed.nextMeter
  t.is(t.throws(() => prepare({...previousDraft, meterEvents: [changed]})).statusCode, 400)
})

test('changer de type reste possible sans relevé ni changement dépendant', t => {
  const changed = edit({type: 'RESET', nextCompteurId: null})
  delete changed.nextMeter
  const saved = {...previousDraft, readings: []}
  const result = prepare({...saved, meterEvents: [changed]}, saved)
  t.is(result.draftForSave.meterEvents[0].type, 'RESET')
  t.deepEqual(result.targets[0].meters, [])
})

test('le rejeu d’un changement de type déjà enregistré accepte une nouvelle saisie dans sa phase courante', t => {
  const changed = edit({type: 'RESET', nextCompteurId: null})
  delete changed.nextMeter
  const saved = {...previousDraft, readings: []}
  const first = prepare({...saved, meterEvents: [changed]}, saved)
  const queued = {...saved, meterEvents: [changed], readings: [{targetId: target.id, compteurId: null, readingDate: '2026-04-01', value: '50'}]}
  const second = prepare(queued, first.draftForSave)
  t.deepEqual(second.draftForSave.readings, queued.readings)
  t.is(second.draftForSave.meterEvents[0].type, 'RESET')
  t.notThrows(() => validateCampaignDraft('INDEX', second.draftForSave, {campaign, targets: second.targets}))
})

test('le rejeu d’une date déjà déplacée accepte une nouvelle saisie valide entre les deux anciennes bornes', t => {
  const incoming = {...previousDraft, readings: [], meterEvents: [edit({at: '2026-05-01'})]}
  const first = prepare(incoming, {...previousDraft, readings: []})
  const queued = {...incoming, readings: [{targetId: target.id, compteurId: null, readingDate: '2026-04-01', value: '150'}]}
  const second = prepare(queued, first.draftForSave)
  t.deepEqual(second.draftForSave.readings, queued.readings)
  t.notThrows(() => validateCampaignDraft('INDEX', second.draftForSave, {campaign, targets: second.targets}))
})

test('une identité ancienne différente est refusée si des relevés dépendent du remplacement', t => {
  t.is(t.throws(() => prepare({...previousDraft, meterEvents: [edit({previousCompteurId: id(15)})]})).statusCode, 400)
})

test('un changement aval empêche aussi de transformer un remplacement en remise à zéro', t => {
  const next = {...event, at: '2026-05-01', previousCompteurId: pendingId, nextMeter: {serialNumber: 'SECOND'}}
  const changed = edit({type: 'RESET', nextCompteurId: null})
  delete changed.nextMeter
  const saved = {...previousDraft, readings: [], meterEvents: [event, next]}
  t.is(t.throws(() => prepare({...saved, meterEvents: [changed, next]}, saved)).statusCode, 400)
})

test('un marqueur inconnu, étranger ou consommé pour une autre identité n’autorise pas une édition', t => {
  const changed = edit({nextMeter: {serialNumber: 'APRÈS'}})
  t.is(t.throws(() => prepare({...previousDraft, meterEvents: [changed]}, null)).statusCode, 409)
  t.is(t.throws(() => prepare({...previousDraft, meterEvents: [changed]}, {meterEvents: []})).statusCode, 409)
  t.is(t.throws(() => prepare({...previousDraft, meterEvents: [{...changed, targetId: id(99)}]})).statusCode, 403)
  const first = prepare({...previousDraft, meterEvents: [changed]})
  t.is(t.throws(() => prepare({...previousDraft, meterEvents: [edit({nextMeter: {serialNumber: 'TROISIÈME'}})]}, first.draftForSave)).statusCode, 409)
})

test('deux éditions de la même origine sont refusées', t => {
  t.is(t.throws(() => prepare({...previousDraft, meterEvents: [edit(), edit({at: '2026-03-01'})]})).statusCode, 409)
})

test('un UUID virtuel devenu réel ne peut plus être renommé ni réaffecté via un ancien marqueur', t => {
  const inventory = [{...target, meters: [{compteurId: pendingId, startDate: event.at}]}]
  t.is(t.throws(() => prepare({...previousDraft, meterEvents: [edit({nextMeter: {serialNumber: 'APRÈS'}})]}, previousDraft, inventory)).statusCode, 400)
})

test('un remplacement publié ne peut pas transformer le compteur réel en nouvelle fiche', t => {
  const realEvent = {...event, nextCompteurId: id(20)}
  delete realEvent.nextMeter
  const saved = {...previousDraft, readings: [], meterEvents: [realEvent]}
  const changed = {...event, previousEvent: {at: event.at, previousCompteurId: null}}
  t.is(t.throws(() => prepare({...saved, meterEvents: [changed]}, saved, [{...target, meters: [{compteurId: id(20)}]}])).statusCode, 400)
})

test('sans marqueur, aucune correction d’identité n’est devinée', t => {
  const changed = {...event, nextMeter: {serialNumber: 'APRÈS'}}
  const result = prepare({...previousDraft, meterEvents: [changed]})
  t.deepEqual(result.draftForSave.readings, [reading])
  t.is(t.throws(() => validateCampaignDraft('INDEX', result.draftForSave, {campaign, targets: result.targets})).statusCode, 400)
})

test('le schéma borne le marqueur aux données nécessaires et rejette un UUID pending arbitraire', t => {
  const result = validateCampaignValue(campaignIndexDraftSchema, {...previousDraft, meterEvents: [edit()]})
  t.deepEqual(result.meterEvents[0].previousEvent, edit().previousEvent)
  for (const marker of [{at: event.at}, {...edit().previousEvent, nextCompteurId: pendingId}, {...edit().previousEvent, at: 'pas une date'}]) {
    t.is(t.throws(() => validateCampaignValue(campaignIndexDraftSchema, {...previousDraft, meterEvents: [{...event, previousEvent: marker}]})).statusCode, 400)
  }
})
