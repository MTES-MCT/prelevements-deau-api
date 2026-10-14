import test from 'ava'
import {validateCollectorPointForm} from '../collector-point-form-validation.js'
import {validateCollectorPointCreation} from '../collector-point-creation-validation.js'

const id = '11111111-1111-4111-8111-111111111111'
const meterId = '22222222-2222-4222-8222-222222222222'
const expectedUpdatedAt = '2026-10-14T10:00:00.000Z'
const body = exploitation => ({expectedUpdatedAt, exploitations: [{id, ...exploitation}]})

test('identifiants, volume et codes sont facultatifs et normalisés sans perdre les zéros initiaux', t => {
  const result = validateCollectorPointForm({expectedUpdatedAt,
    point: {nature: 'PLAN_EAU', waterAgencyInternalIdentifier: ' 00042 ', waterBodyIdentifier: ' 00005 ', reservoirNominalVolume: 20.5},
    exploitations: [{id, countingCode: ' 0009 ', expectedCountingCode: null, meters: [{serialNumber: ' 000001 '}]}]})
  t.is(result.point.waterAgencyInternalIdentifier, '00042')
  t.is(result.point.waterBodyIdentifier, '00005')
  t.is(result.point.reservoirNominalVolume, 20.5)
  t.is(result.exploitations[0].countingCode, '0009')
  t.deepEqual(result.exploitations[0].meters, [{serialNumber: '000001'}])
  t.deepEqual(validateCollectorPointForm({expectedUpdatedAt, point: {usageName: 'Nom'}}).exploitations, [])
})

test('les champs facultatifs peuvent être effacés sans supprimer le compteur', t => {
  const result = validateCollectorPointForm({...body({countingCode: '', expectedCountingCode: 'CODE',
    meters: [{id: meterId, expectedUpdatedAt, serialNumber: null}]}),
  point: {waterAgencyInternalIdentifier: null, waterBodyIdentifier: null, reservoirNominalVolume: null}})
  t.is(result.exploitations[0].countingCode, null)
  t.deepEqual(result.exploitations[0].meters[0], {id: meterId, expectedUpdatedAt, serialNumber: null})
  t.is(validateCollectorPointForm(body({meters: [{id: meterId, expectedUpdatedAt, serialNumber: '  '}]})).exploitations[0].meters[0].serialNumber, null)
})

test('les préconditions et identités explicites sont obligatoires', t => {
  const invalid = [
    {point: {usageName: 'Nom'}}, {expectedUpdatedAt},
    body({countingCode: 'CODE'}), body({expectedCountingCode: null}),
    body({meters: [{id: meterId, serialNumber: 'NUM'}]}),
    body({meters: [{expectedUpdatedAt, serialNumber: 'NUM'}]}),
    body({meters: [{serialNumber: ''}]}), body({meters: [{serialNumber: null}]}),
    body({meters: [{id: meterId, expectedUpdatedAt}]}),
    {expectedUpdatedAt, exploitations: [{countingCode: 'CODE', expectedCountingCode: null}]}
  ]
  for (const payload of invalid) t.is(t.throws(() => validateCollectorPointForm(payload)).statusCode ?? 400, 400)
})

test('les champs de gestion, doublons et changements hors périmètre sont refusés', t => {
  const edit = {id, countingCode: 'CODE', expectedCountingCode: null}
  const invalid = [
    {expectedUpdatedAt, point: {internalComment: 'secret'}},
    {expectedUpdatedAt, point: {expectedUpdatedAt}},
    {expectedUpdatedAt, point: {name: 'Nouveau nom'}},
    body({declarantUserId: meterId, countingCode: 'CODE', expectedCountingCode: null}),
    body({meters: [{serialNumber: 'NUM', percentage: 100}]}),
    {expectedUpdatedAt, exploitations: [edit, edit]},
    body({meters: [{id: meterId, expectedUpdatedAt, serialNumber: 'A'}, {id: meterId, expectedUpdatedAt, serialNumber: 'B'}]})
  ]
  for (const payload of invalid) t.is(t.throws(() => validateCollectorPointForm(payload)).statusCode ?? 400, 400)
})

test('volume positif et longueurs maximales sont contrôlés', t => {
  for (const reservoirNominalVolume of [0, -1]) {
    t.is(t.throws(() => validateCollectorPointForm({expectedUpdatedAt, point: {reservoirNominalVolume}})).statusCode, 400)
  }
  t.is(t.throws(() => validateCollectorPointForm({expectedUpdatedAt, point: {waterAgencyInternalIdentifier: 'x'.repeat(101)}})).statusCode, 400)
  t.is(t.throws(() => validateCollectorPointForm(body({meters: [{serialNumber: 'x'.repeat(101)}]}))).statusCode, 400)
  t.is(t.throws(() => validateCollectorPointForm(body({countingCode: 'x'.repeat(256), expectedCountingCode: null}))).statusCode, 400)
})

test('création accepte les cinq champs et seulement de nouveaux compteurs non vides', t => {
  const input = {requestId: id, preleveurId: meterId,
    point: {name: 'Synthétique', waterBodyType: 'SUPERFICIELLE', nature: 'PLAN_EAU', flowType: 'PRELEVEMENT',
      coordinates: {type: 'Point', coordinates: [1, 44]}, waterAgencyInternalIdentifier: '0001', waterBodyIdentifier: '0002', reservoirNominalVolume: 1},
    exploitation: {usageId: id, status: 'EN_ACTIVITE', countingCode: ' C1 ', meters: [{serialNumber: ' NUM '}]}}
  const result = validateCollectorPointCreation(input)
  t.is(result.exploitation.countingCode, 'C1')
  t.deepEqual(result.exploitation.meters, [{serialNumber: 'NUM'}])
  for (const meters of [[{serialNumber: ''}], [{id: meterId, expectedUpdatedAt, serialNumber: 'NUM'}]]) {
    t.is(t.throws(() => validateCollectorPointCreation({...input, exploitation: {...input.exploitation, meters}})).statusCode, 400)
  }
})
