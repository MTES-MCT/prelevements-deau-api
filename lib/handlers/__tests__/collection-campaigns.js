import test from 'ava'
import {campaignCsvCell, campaignResponseCsvRows} from '../collection-campaigns.js'

test('CSV protège les formules, séparateurs et guillemets fournis par les utilisateurs', t => {
  for (const text of ['=1+1', '  =1+1', '\t=1+1', '-2+3', '@SUM(A1)']) t.true(campaignCsvCell(text).startsWith('"\''))
  t.is(campaignCsvCell('Une "culture"; ici'), '"Une ""culture""; ici"')
  t.is(campaignCsvCell(0), '"0"')
  t.is(campaignCsvCell(null), '""')
})

test('CSV sépare les index par compteur, les besoins par exploitation et les volumes publiés sans répétition', t => {
  const meter = serialNumber => ({serialNumber, offSeason: {indexStart: 100, indexEnd: 200}, season: {indexEnd: 250}})
  const rows = campaignResponseCsvRows({publicationStatus: 'PUBLISHED', submittedData: {meters: [meter('A'), meter('B')], needs: {season: {volume: 800}, offSeason: {volume: 400}}}, volumes: {offSeason: 200, season: 100}})
  t.is(rows.length, 8)
  t.true(rows.every(row => row.length === 19))
  t.is(rows.filter(row => row[5] === 'Bilan').length, 4)
  t.is(rows.filter(row => row[5] === 'Besoins').length, 2)
  t.is(rows.filter(row => row[5] === 'Volumes publiés').reduce((sum, row) => sum + row[18], 0), 300)
  t.is(rows.reduce((sum, row) => sum + Number(row[12] || 0), 0), 1200)
})

test('CSV affiche les assolements multiples et historiques, les besoins 2027–2028 et les index inchangés', t => {
  const rows = campaignResponseCsvRows({submittedData: {
    meters: [{serialNumber: 'A', offSeason: {crops: ['Céréales', 'Maïs']}, season: {crops: 'Culture historique, libre'}}],
    needs: {season: {crops: ['Légumes', 'Haricots']}, offSeason: {crops: []}}
  }})
  t.deepEqual(rows.map(row => row[7]), ['Hors étiage 2025–2026', 'Étiage 2026', 'Étiage 2027', 'Hors étiage 2027–2028', 'Hors étiage 2025–2026', 'Étiage 2026'])
  t.deepEqual(rows.slice(0, 4).map(row => row[14]), ['Céréales, Maïs', 'Culture historique, libre', 'Légumes, Haricots', ''])
})
