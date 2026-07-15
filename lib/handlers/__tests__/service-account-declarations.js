import test from 'ava'

import {serializeDeclarationProcessingPoint} from '../service-account-declarations.js'

test('le contexte de traitement expose le code BSS du point', t => {
  t.deepEqual(serializeDeclarationProcessingPoint({
    id: 'point-1',
    name: 'Forage communal',
    codeBSS: 'BSS002MUNP',
    sourceId: null,
    flowType: 'PRELEVEMENT'
  }), {
    pointId: 'point-1',
    name: 'Forage communal',
    codeBSS: 'BSS002MUNP',
    sourceId: undefined,
    flowType: 'PRELEVEMENT'
  })
})

test('le contexte conserve la compatibilité des points sans code BSS', t => {
  t.deepEqual(serializeDeclarationProcessingPoint({
    id: 'point-2',
    name: 'Prise en rivière',
    codeBSS: null,
    sourceId: 'source-2',
    flowType: null
  }), {
    pointId: 'point-2',
    name: 'Prise en rivière',
    codeBSS: undefined,
    sourceId: 'source-2',
    flowType: 'PRELEVEMENT'
  })
})
