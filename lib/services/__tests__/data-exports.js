import test from 'ava'

import {
  getUsageFilterSql,
  normalizeExportFilters,
  rowToExportObject
} from '../data-exports.js'
import {
  getAccessibleSandreZones,
  getSandreZoneFilterSql,
  toSandreZoneOption
} from '../sandre-alert-zone-query.js'

const FIRST_ZONE_ID = '123e4567-e89b-42d3-a456-426614174000'
const SECOND_ZONE_ID = '123e4567-e89b-42d3-a456-426614174001'

test('rowToExportObject identifie les données télérelevées', t => {
  t.is(rowToExportObject({isTelemetry: true}).donneeTelerelevee, 'Oui')
  t.is(rowToExportObject({isTelemetry: false}).donneeTelerelevee, 'Non')
  t.is(rowToExportObject({}).donneeTelerelevee, 'Non')
})

test('rowToExportObject traduit les caractéristiques du point', t => {
  const point = rowToExportObject({
    nature: 'PLAN_EAU',
    withdrawalType: 'STOCKAGE',
    isZre: true
  })

  t.is(point.originePoint, 'Plan d’eau')
  t.is(point.typePrelevementRejet, 'Stockage')
  t.is(point.zre, 'Oui')
  t.is(rowToExportObject({isZre: false}).zre, 'Non')
  t.is(rowToExportObject({isZre: null}).zre, 'Non renseigné')
})

test('rowToExportObject francise les types de valeur', t => {
  t.is(rowToExportObject({metricTypeCode: 'volume'}).typeValeur, 'Cumulée sur période')
  t.is(rowToExportObject({metricTypeCode: 'index'}).typeValeur, 'Ponctuelle')
  t.is(rowToExportObject({metricTypeCode: 'débit'}).typeValeur, 'Ponctuelle')
})

test('rowToExportObject conserve les colonnes temporelles adaptées au type de valeur', t => {
  const volume = rowToExportObject({
    metricTypeCode: 'volume',
    frequency: '1 month',
    periodStart: new Date('2026-06-01T00:00:00.000Z'),
    periodEnd: new Date('2026-07-01T00:00:00.000Z')
  })
  const index = rowToExportObject({
    metricTypeCode: 'index',
    frequency: 'instant',
    periodStart: new Date('2026-06-30T12:15:00.000Z'),
    periodEnd: new Date('2026-06-30T12:30:00.000Z')
  })

  t.is(volume.dateMesure, '')
  t.is(volume.dateDebutPeriode, '2026-06-01')
  t.is(volume.dateFinPeriode, '2026-06-30')
  t.is(index.dateMesure, '2026-06-30')
  t.is(index.heureMesure, '12:15:00')
  t.is(index.dateDebutPeriode, '')
})

test('normalizeExportFilters garde les anciens exports compatibles', t => {
  t.deepEqual(normalizeExportFilters({
    startDate: '2026-01-01',
    endDate: '2026-01-31',
    zoneIds: ['zone-1']
  }), {
    startDate: '2026-01-01',
    endDate: '2026-01-31',
    usageIds: [],
    zoneIds: ['zone-1'],
    sandreZoneIds: [],
    sandreZones: [],
    waterBodyTypes: []
  })
})

test('getUsageFilterSql filtre aussi par usage secondaire sans joindre les lignes exportées', t => {
  const usageId = '123e4567-e89b-42d3-a456-426614174002'
  const query = getUsageFilterSql([usageId])
  const sql = query.strings.join(' ')

  t.regex(sql, /AND EXISTS/)
  t.regex(sql, /DeclarantPointPrelevementSecondaryUsage/)
  t.regex(sql, /export_secondary_usage_link\."exploitationId" = export_dpp\.id/)
  t.is(query.values.filter(value => value === usageId).length, 4)
})

test('toSandreZoneOption expose un contrat sans géométrie', t => {
  t.deepEqual(toSandreZoneOption({
    id: FIRST_ZONE_ID,
    code: 'SUP001',
    name: 'Zone superficielle',
    type: 'SUP',
    coordinates: 'non exposées'
  }), {
    id: FIRST_ZONE_ID,
    code: 'SUP001',
    name: 'Zone superficielle',
    type: 'SUP',
    source: 'SANDRE_ZAS'
  })
})

test('getAccessibleSandreZones échoue fermé sans territoire instructeur', async t => {
  const client = {
    $queryRaw: () => t.fail('Aucune requête ne doit être exécutée sans zone autorisée.')
  }

  t.deepEqual(await getAccessibleSandreZones({
    user: {id: 'instructor-1', role: 'INSTRUCTOR'},
    allowedZoneIds: [],
    client
  }), [])
})

test('getAccessibleSandreZones limite les résultats aux points du périmètre autorisé', async t => {
  let query
  const zones = [{id: FIRST_ZONE_ID, code: 'SUP001', name: 'Zone 1', type: 'SUP'}]
  const client = {
    async $queryRaw(value) {
      query = value
      return zones
    }
  }

  const result = await getAccessibleSandreZones({
    user: {id: 'instructor-1', role: 'INSTRUCTOR'},
    allowedZoneIds: [SECOND_ZONE_ID],
    sandreZoneIds: [FIRST_ZONE_ID],
    client
  })
  const sql = query.strings.join(' ')

  t.deepEqual(result, zones)
  t.regex(sql, /sandre_zone\.active = true/)
  t.regex(sql, /ST_Covers\(sandre_zone\.coordinates, accessible_point\.coordinates\)/)
  t.regex(sql, /"PointPrelevementZone" accessible_ppz/)
  t.true(query.values.includes(FIRST_ZONE_ID))
  t.true(query.values.includes(SECOND_ZONE_ID))
})

test('getAccessibleSandreZones ne restreint pas un administrateur aux rattachements territoriaux', async t => {
  let query
  const client = {
    async $queryRaw(value) {
      query = value
      return []
    }
  }

  await getAccessibleSandreZones({
    user: {id: 'admin-1', role: 'ADMIN'},
    allowedZoneIds: [SECOND_ZONE_ID],
    client
  })

  t.notRegex(query.strings.join(' '), /PointPrelevementZone/)
})

test('getSandreZoneFilterSql combine les zones par existence spatiale sans type de milieu', t => {
  const query = getSandreZoneFilterSql([FIRST_ZONE_ID, SECOND_ZONE_ID])
  const sql = query.strings.join(' ')

  t.regex(sql, /"SandreAlertZone" export_sandre_zone/)
  t.notRegex(sql, /export_sandre_zone\.active/)
  t.regex(sql, /ST_Covers\(export_sandre_zone\.coordinates, p\.coordinates\)/)
  t.notRegex(sql, /waterBodyType/)
  t.deepEqual(query.values, [FIRST_ZONE_ID, SECOND_ZONE_ID])
})
