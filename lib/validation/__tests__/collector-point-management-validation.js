import test from 'ava'
import {canonicalizeCollectorCommune, searchCurrentCommunes, validateCollectorPointChanges, validateCollectorPointManagement} from '../collector-point-management-validation.js'

const expectedUpdatedAt = '2026-10-07T12:00:00.000Z'

test('habilitation désactivée par défaut logique, activation exige une zone explicite', t => {
  t.deepEqual(validateCollectorPointManagement({enabled: false, zoneIds: []}), {enabled: false, zoneIds: []})
  t.is(t.throws(() => validateCollectorPointManagement({enabled: true, zoneIds: []})).statusCode, 400)
  t.is(t.throws(() => validateCollectorPointManagement({enabled: 'true', zoneIds: []})).statusCode, 400)
  t.is(t.throws(() => validateCollectorPointManagement({enabled: false, zoneIds: [], pointManagementEnabled: true})).statusCode, 400)
})

test('la commune canonique courante ne prend pas le nom délégué du même code', t => {
  t.deepEqual(canonicalizeCollectorCommune({communeCode: '01015'}), {communeCode: '01015', communeName: 'Arboys en Bugey'})
  t.is(t.throws(() => canonicalizeCollectorCommune({communeCode: '01015', communeName: 'Arbignieu'})).status, 400)
  t.is(t.throws(() => canonicalizeCollectorCommune({communeName: 'Paris'})).status, 400)
  t.is(t.throws(() => canonicalizeCollectorCommune({communeCode: null, communeName: null})).status, 400)
  t.is(t.throws(() => canonicalizeCollectorCommune({communeCode: '99999'})).status, 400)
})

test('recherche commune bornée et insensible aux accents', t => {
  t.deepEqual(searchCurrentCommunes('01015'), [{code: '01015', name: 'Arboys en Bugey'}])
  t.true(searchCurrentCommunes('ABERGEMENT-CLEMENCIAT').some(row => row.code === '01001'))
  t.is(searchCurrentCommunes('saint', {limit: 3}).length, 3)
  t.deepEqual(searchCurrentCommunes('s'), [])
})

test('édition exige la version et refuse tous les champs réservés', t => {
  for (const field of ['name', 'internalComment', 'waterBodyIdentifier', 'flowType', 'pointKind', 'identifiers', 'collectionMode', 'deletedAt']) {
    t.is(t.throws(() => validateCollectorPointChanges({expectedUpdatedAt, [field]: 'value'})).statusCode, 400)
  }
  t.is(t.throws(() => validateCollectorPointChanges({usageName: 'Nouveau nom'})).statusCode, 400)
  t.is(t.throws(() => validateCollectorPointChanges({expectedUpdatedAt})).status, 400)
  t.is(t.throws(() => validateCollectorPointChanges({expectedUpdatedAt, coordinates: {type: 'Point', coordinates: [999, 44]}})).statusCode, 400)
  t.deepEqual(validateCollectorPointChanges({expectedUpdatedAt, usageName: ' Nouveau nom ', communeCode: '01015'}), {
    expectedUpdatedAt, changes: {usageName: 'Nouveau nom', communeCode: '01015', communeName: 'Arboys en Bugey'}
  })
})
