import test from 'ava'
import {assertManualCollectionAccess, assertManualVolumePublication, canCollectManually, manualCollectionAccessWhere} from '../manual-collection.js'
import {validateChanges} from '../../validation/point-validation.js'

test('un point externe interdit la saisie et les modes historiques sont conservés', t => {
  t.false(canCollectManually({collectionMode: 'EXTERNAL'}))
  t.true(canCollectManually({collectionMode: 'MANUAL'}))
  t.true(canCollectManually({collectionMode: null}))
  t.true(canCollectManually({}))
})

test('un collecteur est limité aux exploitations qui lui sont rattachées', t => {
  t.deepEqual(manualCollectionAccessWhere({actorDeclarantUserId: 'collector', declarantUserId: 'farmer'}), {
    declarantUserId: 'farmer',
    collecteurs: {some: {collecteurUserId: 'collector'}},
    pointPrelevement: {deletedAt: null, OR: [{collectionMode: null}, {collectionMode: 'MANUAL'}]}
  })
  t.false('collecteurs' in manualCollectionAccessWhere({actorDeclarantUserId: 'farmer', declarantUserId: 'farmer'}))
})

test('une soumission forgée ne peut inclure un point externe ou non autorisé', t => {
  const points = new Map([
    ['manual', {pointPrelevement: {collectionMode: 'MANUAL'}}],
    ['external', {pointPrelevement: {collectionMode: 'EXTERNAL'}}]
  ])
  t.notThrows(() => assertManualCollectionAccess(points, ['manual']))
  t.is(t.throws(() => assertManualCollectionAccess(points, ['manual', 'external'])).status, 403)
  t.is(t.throws(() => assertManualCollectionAccess(points, ['other'])).status, 403)
})

test('le mode de collecte accepte uniquement les deux modes explicites ou la règle historique', t => {
  for (const collectionMode of ['MANUAL', 'EXTERNAL', null]) {
    t.deepEqual(validateChanges({collectionMode}), {collectionMode})
  }

  t.throws(() => validateChanges({collectionMode: 'UNKNOWN'}))
})

test('la saisie rapide refuse tout volume filtré par une couverture de campagne', t => {
  t.notThrows(() => assertManualVolumePublication({shouldSkip: false, valueRowsToInsert: [{value: 100}]}, 1))
  t.is(t.throws(() => assertManualVolumePublication({shouldSkip: true, valueRowsToInsert: []}, 1)).status, 409)
  t.is(t.throws(() => assertManualVolumePublication({shouldSkip: false, valueRowsToInsert: [{value: 100}]}, 2)).status, 409)
})
