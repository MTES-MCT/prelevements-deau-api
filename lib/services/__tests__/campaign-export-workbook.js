import test from 'ava'
import ExcelJS from 'exceljs'
import {buildCampaignWorkbook} from '../campaign-export-workbook.js'

test('export : dernières transmissions, précision décimale, absence distincte de zéro, périmètre', async t => {
  const workbook = buildCampaignWorkbook({
    campaign: {name: 'Campagne', periods: [{id: 'period', label: 'Étiage', startDate: '2027-06-01', endDate: '2027-11-01'}]},
    targets: [{id: 'target', pointPrelevementId: 'point', exploitationId: 'exploitation', preleveurUserId: 'farmer'}],
    responses: [{preleveurUserId: 'farmer', kind: 'INDEX', draft: {comment: 'BROUILLON SECRET'}, latestSubmission: {
      id: 'submission', version: 2, submittedAt: '2026-09-08T10:00:00Z', createdByUserId: 'collector',
      snapshot: {comment: '=HYPERLINK("evil")', readings: [
        {targetId: 'target', compteurId: null, meterConfirmed: true, readingDate: '2026-06-01', value: '1234567890123456.1234'},
        {targetId: 'target', compteurId: 'meter', readingDate: '2026-10-31', value: null, missingReason: 'Compteur inaccessible'},
        {targetId: 'forbidden', compteurId: 'other', readingDate: '2026-10-31', value: '99'}
      ], needs: [{targetId: 'target', periodId: 'period', requestedFlow: '0', requestedVolume: '0'}]},
      publication: {totals: [{targetId: 'target', periodId: 'period', periodStart: '2026-06-01', periodEnd: '2026-11-01', value: null, status: 'MISSING', missing: [{reason: 'Compteur inaccessible'}]}]}
    }}]
  })
  const roundTrip = new ExcelJS.Workbook()
  await roundTrip.xlsx.load(await workbook.xlsx.writeBuffer())
  t.is(roundTrip.getWorksheet('Index').rowCount, 3)
  t.is(roundTrip.getWorksheet('Index').getCell('G2').value, '1234567890123456.1234')
  t.is(roundTrip.getWorksheet('Index').getCell('E2').value, 'Non renseigné')
  t.is(roundTrip.getWorksheet('Index').getCell('Q2').value, 'Oui')
  t.falsy(roundTrip.getWorksheet('Index').getCell('G3').value)
  t.is(roundTrip.getWorksheet('Besoins').getCell('H2').value, '0')
  t.is(roundTrip.getWorksheet('Besoins').getCell('I2').value, '0')
  t.is(roundTrip.getWorksheet('Transmissions').getCell('H2').value, '=HYPERLINK("evil")')
  t.is(roundTrip.getWorksheet('Transmissions').getCell('H2').type, ExcelJS.ValueType.String)
  t.falsy(roundTrip.getWorksheet('Volumes exacts').getCell('G2').value)
  t.is(roundTrip.getWorksheet('Volumes exacts').getCell('H2').value, 'MISSING')
  t.false(JSON.stringify(roundTrip.model).includes('BROUILLON SECRET'))
  t.false(JSON.stringify(roundTrip.model).includes('forbidden'))
})
