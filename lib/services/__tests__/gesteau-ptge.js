import test from 'ava'
import {preparePtgeSnapshot} from '../gesteau-ptge.js'

const headers = '"Nom du PTGE";"Code du PTGE";"État d\'avancement";"Intervenant 1 - Email"'
const catalogueCsv = [headers, '"Lys";"SAGE01001";"Emergence";"exemple@example.test"', '"Sans contour";"PTGE2";"Révision";""'].join('\n')
const feature = {properties: {code: 'SAGE01001'}, geometry: {type: 'Polygon', coordinates: []}}
const snapshot = {
  catalogueCsv, catalogueCount: 2, perimeterCount: 1,
  featureCollection: {type: 'FeatureCollection', features: [feature]}
}

test('le catalogue des PTGE conserve le code du producteur et ignore les colonnes nominatives', t => {
  t.deepEqual(preparePtgeSnapshot(snapshot), [
    {code: 'SAGE01001', name: 'Lys', progressStatus: 'Emergence', geometry: feature.geometry},
    {code: 'PTGE2', name: 'Sans contour', progressStatus: 'Révision', geometry: null}
  ])
})

test('une extraction tronquée, un doublon ou un contour orphelin annulent l’import', t => {
  t.throws(() => preparePtgeSnapshot({...snapshot, catalogueCount: 3}), {message: /Catalogue Gest’eau incomplet/})
  t.throws(() => preparePtgeSnapshot({...snapshot, perimeterCount: 2}), {message: /Couche PTGE incomplète/})
  t.throws(() => preparePtgeSnapshot({...snapshot,
    featureCollection: {...snapshot.featureCollection, crs: {properties: {name: 'EPSG:2154'}}}}), {message: /Projection/})
  t.throws(() => preparePtgeSnapshot({...snapshot, catalogueCsv: catalogueCsv.replace('PTGE2', 'SAGE01001')}), {message: /en double/})
  t.throws(() => preparePtgeSnapshot({...snapshot, perimeterCount: 2,
    featureCollection: {type: 'FeatureCollection', features: [feature, feature]}}), {message: /en double/})
  t.throws(() => preparePtgeSnapshot({...snapshot,
    featureCollection: {type: 'FeatureCollection', features: [{...feature, properties: {code: 'absent'}}]}}), {message: /inconnu/})
})
