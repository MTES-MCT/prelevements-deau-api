import test from 'ava'
import {CAMPAIGN_CSV_HEADER, campaignCsvCell, campaignResponseCsvRows} from '../collection-campaigns.js'

const cell = (row, name) => row[CAMPAIGN_CSV_HEADER.indexOf(name)]

test('CSV protège les formules, séparateurs et guillemets fournis par les utilisateurs', t => {
  for (const text of ['=1+1', '  =1+1', '\t=1+1', '-2+3', '@SUM(A1)']) t.true(campaignCsvCell(text).startsWith('"\''))
  t.is(campaignCsvCell('Une "culture"; ici'), '"Une ""culture""; ici"')
  t.is(campaignCsvCell(0), '"0"')
  t.is(campaignCsvCell(null), '""')
})

test('CSV sépare les index par compteur, les besoins par exploitation et les volumes calculés sans répétition', t => {
  const meter = serialNumber => ({serialNumber, offSeason: {indexStart: 100, indexEnd: 200}, season: {indexEnd: 250}})
  const rows = campaignResponseCsvRows({publicationStatus: 'PUBLISHED', submittedData: {meters: [meter('A'), meter('B')], needs: {season: {volume: 800}, offSeason: {volume: 400}}}, volumes: {offSeason: 200, season: 100}})
  t.is(rows.length, 8)
  t.true(rows.every(row => row.length === CAMPAIGN_CSV_HEADER.length))
  t.is(rows.filter(row => cell(row, 'Section') === 'Bilan').length, 4)
  t.is(rows.filter(row => cell(row, 'Section') === 'Besoins').length, 2)
  t.is(rows.filter(row => cell(row, 'Section') === 'Volumes calculés').reduce((sum, row) => sum + cell(row, 'Volume calculé (m³)'), 0), 300)
  t.is(rows.reduce((sum, row) => sum + Number(cell(row, 'Volume demandé (m³)') || 0), 0), 1200)
  t.false(CAMPAIGN_CSV_HEADER.includes('Publication des volumes'))
})

test('CSV conserve les index incohérents et les périodes calculables sans validation', t => {
  const rows = campaignResponseCsvRows({publicationStatus: 'PENDING_REVIEW', publicationIssues: [{code: 'METER_CHANGE_REPORTED'}],
    submittedData: {meters: [{serialNumber: 'A', meterChanged: true, meterChangeReason: '=Motif fourni', offSeason: {indexStart: '1000', indexEnd: '50'}, season: {indexEnd: '80'}}]},
    volumes: {offSeason: null, season: 30}})
  t.deepEqual([cell(rows[0], 'Index début (m³)'), cell(rows[0], 'Index fin (m³)')], ['1000', '50'])
  t.is(cell(rows[0], 'Changement de compteur signalé'), 'Oui')
  t.is(cell(rows[0], 'Motif du changement de compteur'), '=Motif fourni')
  t.deepEqual(rows.filter(row => cell(row, 'Section') === 'Volumes calculés').map(row => cell(row, 'Volume calculé (m³)')), ['', 30])
  t.notRegex(JSON.stringify(rows), /validation|publication|Non calculé/)
  t.true(campaignCsvCell(cell(rows[0], 'Motif du changement de compteur')).startsWith('"\''))
})

test('CSV affiche les assolements multiples et historiques, les besoins 2027–2028 et les index inchangés', t => {
  const rows = campaignResponseCsvRows({submittedData: {
    meters: [{serialNumber: 'A', offSeason: {crops: ['Céréales', 'Maïs']}, season: {crops: 'Culture historique, libre'}}],
    needs: {season: {crops: ['Légumes', 'Haricots']}, offSeason: {crops: []}}
  }})
  t.deepEqual(rows.map(row => cell(row, 'Période')), ['Hors étiage 2025–2026', 'Étiage 2026', 'Étiage 2027', 'Hors étiage 2027–2028', 'Hors étiage 2025–2026', 'Étiage 2026'])
  t.deepEqual(rows.slice(0, 4).map(row => cell(row, 'Assolements')), ['Céréales, Maïs', 'Culture historique, libre', 'Légumes, Haricots', ''])
})
