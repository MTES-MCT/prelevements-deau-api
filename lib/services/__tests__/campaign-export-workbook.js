import test from 'ava'
import ExcelJS from 'exceljs'
import {buildCampaignWorkbook} from '../campaign-export-workbook.js'

const id = suffix => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`
const targetId = id(1)
const farmerId = id(2)
const periodId = id(3)
const meterId = id(4)
const nextMeterId = id(5)
const forbiddenId = id(99)

function target(overrides = {}) {
  return {
    id: targetId, pointPrelevementId: id(6), exploitationId: id(7), preleveurUserId: farmerId,
    pointPrelevement: {name: 'PUITS-014', usageName: 'Forage des Saules'},
    preleveur: {socialReason: 'GAEC des Saules', user: {firstName: 'Alex', lastName: 'Martin'}},
    exploitation: {usage: {label: 'Irrigation'}},
    meters: [
      {compteurId: meterId, compteur: {id: meterId, serialNumber: 'SERIE-100', identifier: 'Ancien compteur'}},
      {compteurId: nextMeterId, compteur: {id: nextMeterId, serialNumber: null, identifier: 'COMPTEUR-NORD'}}
    ],
    ...overrides
  }
}

function campaign(overrides = {}) {
  return {
    name: 'Campagne 2026', timezone: 'Europe/Paris',
    periods: [{id: periodId, kind: 'NEEDS', label: 'Étiage', startDate: '2027-06-01', endDate: '2027-11-01'}],
    ...overrides
  }
}

function response(kind = 'INDEX', submission = {}, overrides = {}) {
  return {
    preleveurUserId: farmerId, kind, status: 'SUBMITTED',
    latestSubmission: {
      id: id(8), version: 7, submittedAt: '2026-09-08T10:00:00Z', createdByUserId: id(9),
      createdBy: {firstName: 'Camille', lastName: 'Rivière'}, snapshot: {}, ...submission
    },
    ...overrides
  }
}

function build(overrides = {}) {
  return buildCampaignWorkbook({campaign: campaign(), targets: [target()], responses: [], ...overrides})
}

function headers(sheet) {
  return sheet.getRow(1).values.slice(1)
}

function cell(sheet, header, row = 2) {
  const column = headers(sheet).indexOf(header) + 1
  if (column === 0) {
    throw new Error(`Colonne absente : ${header}`)
  }

  return sheet.getCell(row, column)
}

async function roundTrip(workbook) {
  const result = new ExcelJS.Workbook()
  await result.xlsx.load(await workbook.xlsx.writeBuffer())
  return result
}

const valuesText = workbook => JSON.stringify(workbook.worksheets.map(sheet => sheet.getSheetValues()))

test('export : feuilles métier, préleveur, nom usuel, référence, usage et personne ayant transmis', async t => {
  const workbook = await roundTrip(build({responses: [response('INDEX', {snapshot: {
    readings: [{targetId, compteurId: meterId, readingDate: '2026-06-01', value: '15'}]
  }})]}))
  t.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['Réponses', 'Relevés de compteurs', 'Changements de compteur', 'Volumes prélevés', 'Besoins en eau'])
  const readings = workbook.getWorksheet('Relevés de compteurs')
  t.is(cell(readings, 'Point de prélèvement').value, 'Forage des Saules')
  t.is(cell(readings, 'Référence du point').value, 'PUITS-014')
  t.is(cell(readings, 'Préleveur').value, 'GAEC des Saules')
  t.is(cell(readings, 'Usage').value, 'Irrigation')
  t.is(cell(readings, 'Compteur').value, 'SERIE-100')
  t.is(cell(readings, 'Réponse transmise par').value, 'Camille Rivière')
  const summary = workbook.getWorksheet('Réponses')
  t.is(cell(summary, 'Type de réponse').value, 'Relevés de compteurs')
  t.is(cell(summary, 'État de la réponse').value, 'Reçue')
  t.is(cell(summary, 'Type de réponse', 3).value, 'Besoins en eau')
  t.is(cell(summary, 'État de la réponse', 3).value, 'Non transmise')
  const text = valuesText(workbook)
  t.notRegex(text, /00000000-0000-4000-8000-\d{12}/)
  for (const sheet of workbook.worksheets) {
    t.notRegex(headers(sheet).join(' | '), /(?:^| \| )(?:Cible|Exploitation|Auteur|Volet|Version|Transmission|Relevé source)(?: \| |$)/)
  }
})

test('export : précision décimale conservée, valeur zéro distincte d’un relevé absent', async t => {
  const workbook = await roundTrip(build({responses: [response('INDEX', {snapshot: {
    readings: ['1234567890123456.1234', '0', 0, null, undefined].map((value, index) => ({
      targetId, compteurId: null, meterConfirmed: true, readingDate: `2026-06-0${index + 1}`, value,
      ...(value === null ? {missingReason: 'Compteur inaccessible'} : {})
    }))
  }})]}))
  const readings = workbook.getWorksheet('Relevés de compteurs')
  t.is(cell(readings, 'Index (m³)').value, '1234567890123456.1234')
  t.is(cell(readings, 'Index (m³)').type, ExcelJS.ValueType.String)
  t.is(cell(readings, 'Index (m³)', 3).value, '0')
  t.is(cell(readings, 'Index (m³)', 4).value, '0')
  t.falsy(cell(readings, 'Index (m³)', 5).value)
  t.falsy(cell(readings, 'Index (m³)', 6).value)
  t.is(cell(readings, 'Motif d’indisponibilité', 5).value, 'Compteur inaccessible')
  t.is(cell(readings, 'Compteur').value, 'Non renseigné')
  t.is(cell(readings, 'Continuité du compteur confirmée').value, 'Oui')
})

test('export : dernière transmission officielle conservée pendant une correction, jamais le brouillon', t => {
  const workbook = build({responses: [response('INDEX', {snapshot: {
    comment: 'Commentaire transmis', readings: [{targetId, readingDate: '2026-06-01', value: '100'}]
  }}, {status: 'DRAFT', draft: {comment: 'BROUILLON SECRET', readings: [{targetId, value: '999999.9999'}]}})]})
  t.is(cell(workbook.getWorksheet('Réponses'), 'État de la réponse').value, 'Reçue')
  t.is(cell(workbook.getWorksheet('Réponses'), 'Commentaire').value, 'Commentaire transmis')
  t.is(cell(workbook.getWorksheet('Relevés de compteurs'), 'Index (m³)').value, '100')
  t.false(valuesText(workbook).includes('BROUILLON SECRET'))
  t.false(valuesText(workbook).includes('999999.9999'))
})

test('export : commentaires et noms restent du texte, sans formule ni lien exécutable', async t => {
  const formula = '=HYPERLINK("https://example.test","Cliquer")'
  const workbook = await roundTrip(build({
    targets: [target({preleveur: {label: formula}, pointPrelevement: {name: '+SUM(1,2)', usageName: '@SUM(1,2)'}})],
    responses: [response('INDEX', {createdBy: {firstName: '-1+1'}, snapshot: {
      comment: formula, readings: [{targetId, readingDate: '2026-06-01', value: '0', correctionReason: formula}]
    }})]
  }))
  const summary = workbook.getWorksheet('Réponses')
  for (const header of ['Préleveur', 'Commentaire']) {
    t.is(cell(summary, header).value, formula)
    t.is(cell(summary, header).type, ExcelJS.ValueType.String)
  }

  for (const sheet of workbook.worksheets) {
    sheet.eachRow(row => row.eachCell(value => {
      t.not(value.type, ExcelJS.ValueType.Formula)
      t.not(value.type, ExcelJS.ValueType.Hyperlink)
    }))
  }
})

test('export : tous les tableaux excluent les points, périodes et préleveurs hors périmètre', t => {
  const readings = [targetId, forbiddenId].map((targetId, index) => ({targetId, readingDate: '2026-06-01', value: index ? '999' : '100'}))
  const meterEvents = [targetId, forbiddenId].map(targetId => ({targetId, type: 'RESET', at: '2026-07-01', previousCompteurId: meterId, previousIndex: '100', nextIndex: '0'}))
  const needs = [
    {targetId, periodId, requestedVolume: '200'},
    {targetId: forbiddenId, periodId, requestedVolume: '999'},
    {targetId, periodId: forbiddenId, requestedVolume: '999'}
  ]
  const totals = needs.map(line => ({targetId: line.targetId, periodId: line.periodId, status: 'COMPLETE', value: line.requestedVolume}))
  const workbook = build({responses: [
    response('INDEX', {snapshot: {readings, meterEvents, needs}, publication: {totals}}),
    response('NEEDS', {snapshot: {comment: 'AUTRE PRÉLEVEUR SECRET'}}, {preleveurUserId: forbiddenId})
  ]})
  for (const name of ['Relevés de compteurs', 'Changements de compteur', 'Volumes prélevés', 'Besoins en eau']) {
    t.is(workbook.getWorksheet(name).rowCount, 2)
  }

  t.is(workbook.getWorksheet('Réponses').rowCount, 3)
  t.false(valuesText(workbook).includes('999'))
  t.false(valuesText(workbook).includes('AUTRE PRÉLEVEUR SECRET'))
  t.false(valuesText(workbook).includes(forbiddenId))
})

test('export : les volumes ne sont renseignés que pour les calculs complets, avec états et motifs français', async t => {
  const totals = [
    {status: 'COMPLETE', value: '0'},
    {status: 'COMPLETE', value: '1234567890123456.1234'},
    {status: 'MISSING', value: '999', missing: [{reason: 'Compteur inaccessible', compteurId: forbiddenId}]},
    {status: 'CONFLICT', value: '999', conflicts: [{code: 'NEGATIVE_DELTA_REQUIRES_EVENT', compteurId: forbiddenId}]},
    {status: 'UNEXPECTED_STATE', value: '999', conflicts: ['NEW_UNKNOWN_CODE', {code: 'MISSING_READING'}, {code: 'MISSING_READING'}]}
  ].map(total => ({targetId, periodId, ...total}))
  const workbook = await roundTrip(build({responses: [response('INDEX', {publication: {totals}})]}))
  const volumes = workbook.getWorksheet('Volumes prélevés')
  t.is(cell(volumes, 'Volume prélevé (m³)').value, '0')
  t.is(cell(volumes, 'Volume prélevé (m³)', 3).value, '1234567890123456.1234')
  t.is(cell(volumes, 'État du calcul').value, 'Calculé')
  t.is(cell(volumes, 'État du calcul', 4).value, 'Relevé indisponible')
  t.is(cell(volumes, 'État du calcul', 5).value, 'Calcul impossible')
  t.is(cell(volumes, 'État du calcul', 6).value, 'Calcul à vérifier')
  for (const row of [4, 5, 6]) {
    t.falsy(cell(volumes, 'Volume prélevé (m³)', row).value)
  }

  t.is(cell(volumes, 'Précisions', 4).value, 'Compteur inaccessible')
  t.true(cell(volumes, 'Précisions', 5).value.includes('L’index a diminué'))
  t.is(cell(volumes, 'Précisions', 6).value, 'Données à vérifier; Relevé manquant')
  t.notRegex(valuesText(workbook), /MISSING|CONFLICT|COMPLETE|UNEXPECTED_STATE|NEW_UNKNOWN_CODE|NEGATIVE_DELTA_REQUIRES_EVENT/)
  t.false(valuesText(workbook).includes(forbiddenId))
})

test('export : les codes de calcul sont traduits sans exposer les objets techniques, les motifs saisis restent intacts', t => {
  const codes = [
    'UNKNOWN_TARGET_OR_METER',
    'INVALID_READING_DATE',
    'DUPLICATE_READING',
    'INVALID_INDEX',
    'MISSING_REASON_REQUIRED',
    'METER_CONTINUITY_CONFIRMATION_REQUIRED',
    'CORRECTION_REASON_REQUIRED',
    'EXISTING_READING_REFERENCE_REQUIRED',
    'STALE_SOURCE_READING',
    'INVALID_SOURCE_READING',
    'SOURCE_METER_MISMATCH',
    'AMBIGUOUS_HISTORICAL_METER',
    'SOURCE_READING_CHANGED',
    'SOURCE_READING_REUSED_FOR_ANOTHER_METER',
    'INVALID_METER_EVENT_DATE',
    'INVALID_METER_EVENT',
    'METER_TRANSITION_REQUIRED',
    'NEGATIVE_DELTA_REQUIRES_EVENT',
    'CAMPAIGN_TARGETS_AND_PERIODS_REQUIRED',
    'READING_OUTSIDE_CAMPAIGN_BOUNDARIES',
    'METER_EVENT_OUTSIDE_CAMPAIGN',
    'METER_OR_PERIOD_REQUIRED',
    'AMBIGUOUS_METER_BINDING',
    'NO_ACTIVE_METER',
    'INVALID_PERIOD_OR_METER_DATE',
    'MISSING_READING',
    'VOLUME_OUT_OF_RANGE',
    'AMBIGUOUS_VOLUME_OWNER',
    'PARTIAL_VOLUME_OVERLAP'
  ]
  const workbook = build({responses: [response('INDEX', {publication: {totals: [
    ...codes.map(code => ({targetId, periodId, status: 'CONFLICT', conflicts: [{code, compteurId: forbiddenId}]})),
    {targetId, periodId, status: 'MISSING', missing: [{reason: 'PANNE', compteurId: forbiddenId}, {reason: 'HS'}, {code: 'NEW_UNKNOWN_CODE', sourceId: forbiddenId}]}
  ]}})]})
  const volumes = workbook.getWorksheet('Volumes prélevés')
  for (const [index, code] of codes.entries()) {
    const reason = cell(volumes, 'Précisions', index + 2).value
    t.true(typeof reason === 'string' && reason.length > 0)
    t.not(reason, code)
    t.not(reason, 'Relevé manquant ou données à vérifier')
  }

  t.is(cell(volumes, 'Précisions', codes.length + 2).value, 'PANNE; HS; Relevé manquant ou données à vérifier')
  t.false(valuesText(workbook).includes(forbiddenId))
})

test('export : libellés lisibles même lorsque les anciennes relations sont incomplètes, sans UUID de secours', t => {
  const workbook = build({
    targets: [{id: targetId, pointPrelevementId: id(6), exploitationId: id(7), preleveurUserId: farmerId}],
    responses: [response('INDEX', {createdBy: null, snapshot: {readings: [{targetId, compteurId: meterId, value: '0'}]}})]
  })
  const readings = workbook.getWorksheet('Relevés de compteurs')
  t.is(cell(readings, 'Point de prélèvement').value, 'Point non renseigné')
  t.is(cell(readings, 'Préleveur').value, 'Préleveur non renseigné')
  t.is(cell(readings, 'Usage').value, 'Usage non renseigné')
  t.is(cell(readings, 'Compteur').value, 'Compteur sans numéro renseigné')
  t.is(cell(readings, 'Réponse transmise par').value, 'Personne non renseignée')
  t.notRegex(valuesText(workbook), /00000000-0000-4000-8000-\d{12}|undefined/)
})

test('export : les noms publics, les personnes physiques et la raison sociale de l’auteur sont compatibles', t => {
  const workbook = build({
    targets: [target({preleveur: {user: {firstName: 'Alex', lastName: 'Martin'}}, usage: {name: 'Eau potable'}, pointPrelevement: {name: 'PUITS-014'}})],
    responses: [response('INDEX', {createdBy: {firstName: null, lastName: null, declarant: {socialReason: 'Syndicat du Canal'}}, snapshot: {
      readings: [{targetId, compteurId: nextMeterId, readingDate: '2026-06-01', value: '0'}]
    }})]
  })
  const readings = workbook.getWorksheet('Relevés de compteurs')
  t.is(cell(readings, 'Préleveur').value, 'Alex Martin')
  t.is(cell(readings, 'Point de prélèvement').value, 'PUITS-014')
  t.is(cell(readings, 'Usage').value, 'Eau potable')
  t.is(cell(readings, 'Réponse transmise par').value, 'Syndicat du Canal')
  t.is(cell(readings, 'Compteur').value, 'COMPTEUR-NORD')
})

test('export : dates civiles inchangées, fin de période incluse et date de transmission dans le fuseau local', async t => {
  const workbook = await roundTrip(build({responses: [response('INDEX', {snapshot: {
    readings: [{targetId, readingDate: '2026-06-01', value: '100'}],
    needs: [{targetId, periodId, requestedVolume: '100'}]
  }, publication: {totals: [{targetId, periodId, periodStart: '2026-06-01T00:00:00Z', periodEnd: '2026-11-01T00:00:00Z', status: 'COMPLETE', value: '100'}]}})]}))
  const readings = workbook.getWorksheet('Relevés de compteurs')
  t.is(cell(readings, 'Date du relevé').value.toISOString(), '2026-06-01T00:00:00.000Z')
  t.is(cell(readings, 'Date du relevé').numFmt, 'dd/mm/yyyy')
  t.is(cell(readings, 'Date de transmission').value.toISOString(), '2026-09-08T12:00:00.000Z')
  t.is(cell(readings, 'Date de transmission').numFmt, 'dd/mm/yyyy hh:mm:ss')
  const needs = workbook.getWorksheet('Besoins en eau')
  t.is(cell(needs, 'Du').value.toISOString(), '2027-06-01T00:00:00.000Z')
  t.is(cell(needs, 'Au').value.toISOString(), '2027-10-31T00:00:00.000Z')
  t.is(cell(workbook.getWorksheet('Volumes prélevés'), 'Au').value.toISOString(), '2026-10-31T00:00:00.000Z')
})

for (const [timezone, submittedAt, expected] of [
  ['Europe/Paris', '2026-10-25T00:30:00Z', '2026-10-25T02:30:00.000Z'],
  ['Europe/Paris', '2026-10-25T01:30:00Z', '2026-10-25T02:30:00.000Z'],
  ['Europe/Paris', '2026-12-31T23:15:00Z', '2027-01-01T00:15:00.000Z'],
  ['UTC', '2026-09-08T10:00:00Z', '2026-09-08T10:00:00.000Z']
]) {
  test(`export : heure locale ${timezone} pour ${submittedAt}`, async t => {
    const workbook = await roundTrip(build({campaign: campaign({timezone}), responses: [response('NEEDS', {submittedAt})]}))
    t.is(cell(workbook.getWorksheet('Réponses'), 'Date de transmission', 3).value.toISOString(), expected)
  })
}

test('export : fin exclusive aux changements d’année et année bissextile, sans décaler les dates civiles', t => {
  const periods = [
    {id: periodId, label: 'Année', startDate: new Date('2027-01-01'), endDate: new Date('2028-01-01')},
    {id: id(10), label: 'Février', startDate: '2028-02-01', endDate: '2028-03-01'}
  ]
  const workbook = build({campaign: campaign({periods}), responses: [response('NEEDS', {snapshot: {
    needs: periods.map(period => ({targetId, periodId: period.id, requestedVolume: '0'}))
  }})]})
  const needs = workbook.getWorksheet('Besoins en eau')
  t.is(cell(needs, 'Au').value.toISOString(), '2027-12-31T00:00:00.000Z')
  t.is(cell(needs, 'Au', 3).value.toISOString(), '2028-02-29T00:00:00.000Z')
})

test('export : le débit historique apparaît seulement pour les données transmises du périmètre', t => {
  const needs = [
    {targetId, periodId, requestedVolume: '0'},
    {targetId: forbiddenId, periodId, requestedFlow: '12', requestedVolume: '200'},
    {targetId, periodId: forbiddenId, requestedFlow: '12', requestedVolume: '200'}
  ]
  const withoutLegacy = build({responses: [response('NEEDS', {snapshot: {needs}})]}).getWorksheet('Besoins en eau')
  t.false(headers(withoutLegacy).includes('Débit historique (m³/h)'))
  t.is(cell(withoutLegacy, 'Volume demandé (m³)').value, '0')
  t.is(withoutLegacy.rowCount, 2)
  const withLegacy = build({responses: [response('NEEDS', {snapshot: {needs: [{...needs[0], requestedFlow: '0'}]}})]}).getWorksheet('Besoins en eau')
  t.true(headers(withLegacy).includes('Débit historique (m³/h)'))
  t.is(cell(withLegacy, 'Débit historique (m³/h)').value, '0')
  t.is(cell(withLegacy, 'Volume demandé (m³)').value, '0')
})

test('export : la provenance des relevés remplace les références techniques sans perdre le motif de correction', t => {
  const workbook = build({responses: [response('INDEX', {snapshot: {readings: [
    {targetId, readingDate: '2026-01-01', value: '1'},
    {targetId, readingDate: '2026-04-01', value: '2', sourceChunkValueId: id(10), sourceValueUpdatedAt: '2026-09-01T12:00:00Z'},
    {targetId, readingDate: '2026-07-01', value: '3', correctionOfChunkValueId: id(11), correctionReason: 'Erreur de saisie corrigée'}
  ]}})]})
  const readings = workbook.getWorksheet('Relevés de compteurs')
  t.is(cell(readings, 'Origine du relevé').value, 'Saisi pour cette campagne')
  t.is(cell(readings, 'Origine du relevé', 3).value, 'Relevé existant repris')
  t.is(cell(readings, 'Origine du relevé', 4).value, 'Relevé existant corrigé')
  t.is(cell(readings, 'Motif de correction', 4).value, 'Erreur de saisie corrigée')
  t.false(valuesText(workbook).includes(id(10)))
  t.false(valuesText(workbook).includes(id(11)))
})

test('export : les changements de compteur identifient les deux appareils avec leur type français et leurs index exacts', async t => {
  const workbook = await roundTrip(build({responses: [response('INDEX', {snapshot: {meterEvents: [
    {targetId, type: 'RESET', at: '2026-05-01', previousCompteurId: meterId, previousIndex: '1234567890123456.1234', nextIndex: '0', reason: 'Remise à zéro prévue'},
    {
      targetId, type: 'REPLACEMENT', at: '2026-06-01', previousCompteurId: meterId, nextCompteurId: nextMeterId,
      previousIndex: null, nextIndex: null, previousMissingReason: 'Compteur défectueux', nextMissingReason: 'Non accessible', reason: 'Remplacement prévu'
    }
  ]}})]}))
  const events = workbook.getWorksheet('Changements de compteur')
  t.is(cell(events, 'Type de changement').value, 'Remise à zéro')
  t.is(cell(events, 'Type de changement', 3).value, 'Remplacement de compteur')
  t.is(cell(events, 'Ancien compteur').value, 'SERIE-100')
  t.is(cell(events, 'Compteur après changement').value, 'SERIE-100')
  t.is(cell(events, 'Compteur après changement', 3).value, 'COMPTEUR-NORD')
  t.is(cell(events, 'Index avant changement (m³)').value, '1234567890123456.1234')
  t.is(cell(events, 'Index après changement (m³)').value, '0')
  t.falsy(cell(events, 'Index avant changement (m³)', 3).value)
  t.falsy(cell(events, 'Index après changement (m³)', 3).value)
  t.is(cell(events, 'Motif d’indisponibilité avant', 3).value, 'Compteur défectueux')
  t.is(cell(events, 'Motif d’indisponibilité après', 3).value, 'Non accessible')
  t.is(cell(events, 'Motif', 3).value, 'Remplacement prévu')
  t.notRegex(valuesText(workbook), /RESET|REPLACEMENT|00000000-0000-4000-8000-\d{12}/)
})

test('export : présentation homogène, en-têtes figés, filtres et explications des colonnes ambiguës', async t => {
  const workbook = await roundTrip(build())
  for (const sheet of workbook.worksheets) {
    t.is(sheet.views[0].state, 'frozen')
    t.is(sheet.views[0].ySplit, 1)
    t.truthy(sheet.autoFilter)
    t.true(sheet.getRow(1).font.bold)
    t.is(sheet.getRow(1).fill.fgColor.argb, 'FF000091')
  }

  const summary = workbook.getWorksheet('Réponses')
  t.true(JSON.stringify(cell(summary, 'Réponse transmise par', 1).note).includes('collecteur'))
  t.true(JSON.stringify(cell(summary, 'Type de réponse', 1).note).includes('besoins en eau'))
  t.true(JSON.stringify(cell(summary, 'Date de transmission', 1).note).includes('Europe/Paris'))
})
