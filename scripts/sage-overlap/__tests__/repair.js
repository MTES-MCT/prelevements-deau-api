import test from 'ava'
import {randomUUID} from 'node:crypto'
import {buildReview, fingerprint, projectedState, validateReview} from '../lib/repair.js'

const target = 'testing'
const createdAt = '2026-10-08T12:34:56.123Z'

function fixture() {
  const zones = ['sage-SAGE06028', 'sage-SAGE06030'].map(code => ({id: randomUUID(), code, type: 'SAGE',
    managedResourceType: 'MIXTE', geometryHash: 'synthetic', updatedAt: '2026-01-01T00:00:00.000001'}))
  const link = zoneId => ({id: randomUUID(), zoneId, createdAt: '2026-01-01T00:00:00.000001'})
  const point = {id: randomUUID(), waterBodyType: 'SUPERFICIELLE', coordinatesHash: 'synthetic-point',
    updatedAt: '2026-01-01T00:00:00.000001', deletedAt: null, candidateZoneIds: zones.map(zone => zone.id),
    links: [...zones.map(zone => link(zone.id)), link(randomUUID())]}
  return {state: {zones, points: [point]}, point, zones, link}
}

test('surface et souterrain suivent la paire et préservent exactement les liens extérieurs', t => {
  for (const [waterBodyType, code] of [['SUPERFICIELLE', 'sage-SAGE06030'], ['SOUTERRAIN', 'sage-SAGE06028']]) {
    const {state, point, zones} = fixture()
    point.waterBodyType = waterBodyType
    const source = structuredClone(state)
    const review = buildReview(state, {target, createdAt})
    const entry = review.entries[0]
    t.is(entry.status, 'CHANGE')
    t.is(entry.targetZoneId, zones.find(zone => zone.code === code).id)
    t.deepEqual(entry.afterLinks, entry.beforeLinks.filter(link => link.zoneId !== zones.find(zone => zone.code !== code).id))
    t.deepEqual(state, source)
    t.is(buildReview(projectedState(review), {target, createdAt}).summary.changed, 0)
  }
})

test('lien manquant ajouté avec UUID déterministe et horodatage sans perte de précision', t => {
  const {state, point} = fixture()
  point.links = []
  const a = buildReview(state, {target, createdAt})
  const b = buildReview(state, {target, createdAt})
  t.deepEqual(a, b)
  t.regex(a.entries[0].afterLinks[0].id, /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/)
  t.is(a.entries[0].afterLinks[0].createdAt, '2026-10-08T12:34:56.123000')
})

test('suppression, absence de coordonnées, extérieur et milieu transition sont signalés sans changements', t => {
  const cases = [
    [point => { point.deletedAt = '2026-01-01T00:00:00.000000' }, 'DELETED_POINT'],
    [point => { point.coordinatesHash = null }, 'MISSING_COORDINATES'],
    [point => { point.candidateZoneIds.pop() }, 'OUTSIDE_INTERSECTION'],
    [point => { point.waterBodyType = 'TRANSITION' }, 'UNSUPPORTED_WATER_BODY_TYPE'],
    [point => { point.waterBodyType = null }, 'UNSUPPORTED_WATER_BODY_TYPE']
  ]
  for (const [mutate, reason] of cases) {
    const {state, point} = fixture()
    mutate(point)
    const review = buildReview(state, {target, createdAt})
    t.is(review.entries[0].reason, reason)
    t.deepEqual(review.entries[0].afterLinks, review.entries[0].beforeLinks)
    t.is(review.summary.exceptions, 1)
  }
})

test('troisième SAGE existant incompatible hors géométrie conservé, comme troisième candidat compatible', t => {
  for (const existing of [true, false]) {
    const {state, point, zones, link} = fixture()
    const third = {id: randomUUID(), code: 'sage-SYNTHETIC', type: 'SAGE', managedResourceType: existing ? 'SOUTERRAIN' : 'MIXTE', geometryHash: 'third'}
    zones.push(third)
    if (existing) point.links.push(link(third.id))
    else point.candidateZoneIds.push(third.id)
    const review = buildReview(state, {target, createdAt})
    t.is(review.entries[0].reason, existing ? 'EXISTING_THIRD_SAGE' : 'SAGE_CANDIDATES_AMBIGUOUS')
    t.is(review.summary.changed, 0)
  }
})

test('configuration cible incompatible reste une exception explicite', t => {
  const {state, zones} = fixture()
  zones.find(zone => zone.code === 'sage-SAGE06030').managedResourceType = 'SOUTERRAIN'
  const review = buildReview(state, {target, createdAt})
  t.is(review.entries[0].reason, 'SAGE_OVERLAP_RESOURCE_CONFLICT')
  t.is(review.summary.changed, 0)
})

test('revue borne cible, code, présence des deux SAGE et intégrité du plan', t => {
  const {state} = fixture()
  const review = buildReview(state, {target, createdAt})
  t.is(validateReview(review, target), review)
  t.throws(() => validateReview(review, 'prod'))
  const modified = structuredClone(review)
  modified.entries[0].afterLinks = []
  t.throws(() => validateReview(modified, target))
  const {reportHash, ...body} = modified
  t.throws(() => validateReview({...body, reportHash: fingerprint(body)}, target))
  t.throws(() => buildReview({...state, zones: state.zones.slice(1)}, {target, createdAt}))
  t.throws(() => buildReview(state, {target: 'arbitrary', createdAt}))
})

test('empreinte stable malgré ordre des propriétés et de l’inventaire', t => {
  const {state} = fixture()
  const a = buildReview(state, {target, createdAt})
  state.zones.reverse()
  state.points[0].candidateZoneIds.reverse()
  state.points[0].links.reverse()
  t.deepEqual(buildReview(state, {target, createdAt}), a)
  t.is(fingerprint({a: 1, b: 2}), fingerprint({b: 2, a: 1}))
})
