import test from 'ava'

import {
  EXPECTED_SEED_STATE,
  verifySeedState
} from '../lib/seed-verifier.js'

function validState() {
  const contentDigests = {
    declarations: '1'.repeat(64),
    sources: '2'.repeat(64),
    chunks: '3'.repeat(64),
    values: '4'.repeat(64)
  }

  return {
    accounts: {matching: 6},
    authentication: {
      personaUsers: 6,
      emailAliases: 0,
      emailIdentityClaims: 0,
      activeEmailVerifications: 0,
      emailVerificationTokens: 0,
      passwordCredentials: 0,
      passwordActivations: 0,
      authTokens: 0,
      sessionTokens: 0
    },
    zones: {total: 1},
    preleveurs: {
      total: 300,
      byType: {
        IRRIGANT: 240,
        ICPE: 30,
        GESTIONNAIRE_AEP: 30
      },
      active: 210
    },
    points: {
      total: 800,
      byUsageCode: {
        2: 700,
        4: 50,
        5: 50
      },
      byDepartmentCode: {
        'dep-38': 400,
        'dep-26': 400
      },
      byWaterBodyType: {
        SUPERFICIELLE: 400,
        SOUTERRAIN: 400
      },
      declared: 560,
      shared: {
        total: 1,
        preleveurs: 2
      },
      multiMeter: {
        total: 1,
        meters: 2
      }
    },
    ougc: {managedPreleveurs: 200},
    cohorts: {
      MONTHLY: 150,
      WEEKLY: 40,
      DAILY: 20
    },
    years: [2025, 2026],
    integrity: {
      expected: {
        declarations: 420,
        sources: 420,
        chunks: 1124,
        values: 48_288,
        exploitations: 801,
        meters: 801,
        meterPointLinks: 801,
        matchingMeterPointLinks: 801,
        matchingPointCoordinates: 800,
        matchedPointYears: 1120,
        unexpectedMatchedPointYears: 0,
        gidafUnassociated: 4,
        gidafUnassociatedWithValues: 4,
        gidafUnassociatedPendingWithValues: 4,
        contentDigests
      },
      actual: {
        declarations: 420,
        sources: 420,
        completedSources: 420,
        chunks: 1124,
        values: 48_288,
        exploitations: 801,
        meters: 801,
        meterPointLinks: 801,
        matchingMeterPointLinks: 801,
        matchingPointCoordinates: 800,
        matchedPointYears: 1120,
        unexpectedMatchedPointYears: 0,
        gidafUnassociated: 4,
        gidafUnassociatedWithValues: 4,
        gidafUnassociatedPendingWithValues: 4,
        contentDigests: {...contentDigests}
      }
    },
    gidaf: {
      unassociated: 4,
      unassociatedWithValues: 4,
      unassociatedPendingWithValues: 4
    },
    agents: {
      total: 2,
      ddt: {
        total: 1,
        role: 'INSTRUCTOR',
        assignments: 2,
        unexpectedAssignments: 0,
        zonesExact: true,
        isAdminExact: true,
        permissionsExact: true,
        departmentAccess: 'FULL',
        sageAccess: 'READ_ONLY'
      },
      sage: {
        total: 1,
        role: 'INSTRUCTOR',
        assignments: 1,
        unexpectedAssignments: 0,
        zonesExact: true,
        isAdminExact: true,
        permissionsExact: true,
        sageAccess: 'FULL'
      }
    }
  }
}

function setValue(target, path, value) {
  let cursor = target

  for (const part of path.slice(0, -1)) {
    cursor = cursor[part]
  }

  cursor[path.at(-1)] = value
}

test('valide toutes les postconditions du jeu Grivaise', t => {
  const result = verifySeedState(validState())

  t.true(result.success)
  t.is(result.checks.length, 69)
  t.true(result.checks.every(check => check.success))
  t.deepEqual(result.errors, [])
})

test('considère les années comme un ensemble exact', t => {
  const state = validState()
  state.years = [2026, 2025]

  t.true(verifySeedState(state).success)

  state.years = [2025, 2026, 2027]
  const result = verifySeedState(state)

  t.false(result.success)
  t.is(result.errors.length, 1)
  t.is(result.errors[0].code, 'years')
  t.is(result.errors[0].operator, 'SAME_SET')
})

test('accepte plus de deux compteurs sur le point multi-compteurs', t => {
  const state = validState()
  state.points.multiMeter.meters = 4

  const result = verifySeedState(state)

  t.true(result.success)
  t.true(result.checks.find(check => check.code === 'points.multi_meter.meters').success)
})

test('accepte les liens magiques et sessions créés après le seed', t => {
  const state = validState()
  state.authentication.authTokens = 2
  state.authentication.sessionTokens = 3

  t.true(verifySeedState(state).success)
})

test('retourne toutes les erreurs structurées sans lever sur une entrée absente', t => {
  const result = verifySeedState()

  t.false(result.success)
  t.is(result.errors.length, result.checks.length)
  t.true(result.errors.every(error => error.success === false))
  t.true(result.errors.every(error => typeof error.message === 'string'))
  t.true(result.errors.every(error => error.actual === undefined))
})

const invalidCases = [
  ['accounts.matching', ['accounts', 'matching'], 5],
  ['authentication.persona_users', ['authentication', 'personaUsers'], 5],
  ['authentication.email_aliases', ['authentication', 'emailAliases'], 1],
  [
    'authentication.email_identity_claims',
    ['authentication', 'emailIdentityClaims'],
    1
  ],
  [
    'authentication.active_email_verifications',
    ['authentication', 'activeEmailVerifications'],
    1
  ],
  [
    'authentication.email_verification_tokens',
    ['authentication', 'emailVerificationTokens'],
    1
  ],
  [
    'authentication.password_credentials',
    ['authentication', 'passwordCredentials'],
    1
  ],
  [
    'authentication.password_activations',
    ['authentication', 'passwordActivations'],
    1
  ],
  ['zones.total', ['zones', 'total'], 2],
  ['preleveurs.total', ['preleveurs', 'total'], 299],
  ['preleveurs.type.irrigant', ['preleveurs', 'byType', 'IRRIGANT'], 239],
  ['preleveurs.type.icpe', ['preleveurs', 'byType', 'ICPE'], 29],
  ['preleveurs.type.gestionnaire_aep', ['preleveurs', 'byType', 'GESTIONNAIRE_AEP'], 29],
  ['points.total', ['points', 'total'], 799],
  ['points.usage.2', ['points', 'byUsageCode', '2'], 699],
  ['points.usage.4', ['points', 'byUsageCode', '4'], 49],
  ['points.usage.5', ['points', 'byUsageCode', '5'], 49],
  ['points.department.dep-38', ['points', 'byDepartmentCode', 'dep-38'], 399],
  ['points.department.dep-26', ['points', 'byDepartmentCode', 'dep-26'], 399],
  ['points.water_body.superficielle', ['points', 'byWaterBodyType', 'SUPERFICIELLE'], 399],
  ['points.water_body.souterrain', ['points', 'byWaterBodyType', 'SOUTERRAIN'], 399],
  ['ougc.managed_preleveurs', ['ougc', 'managedPreleveurs'], 199],
  ['preleveurs.active', ['preleveurs', 'active'], 209],
  ['points.declared', ['points', 'declared'], 559],
  ['cohorts.monthly', ['cohorts', 'MONTHLY'], 149],
  ['cohorts.weekly', ['cohorts', 'WEEKLY'], 39],
  ['cohorts.daily', ['cohorts', 'DAILY'], 19],
  ['points.shared.total', ['points', 'shared', 'total'], 0],
  ['points.shared.preleveurs', ['points', 'shared', 'preleveurs'], 1],
  ['points.multi_meter.total', ['points', 'multiMeter', 'total'], 0],
  ['points.multi_meter.meters', ['points', 'multiMeter', 'meters'], 1],
  ['integrity.declarations', ['integrity', 'actual', 'declarations'], 419],
  ['integrity.sources', ['integrity', 'actual', 'sources'], 419],
  ['integrity.completed_sources', ['integrity', 'actual', 'completedSources'], 419],
  ['integrity.chunks', ['integrity', 'actual', 'chunks'], 1123],
  ['integrity.values', ['integrity', 'actual', 'values'], 48_287],
  ['integrity.exploitations', ['integrity', 'actual', 'exploitations'], 800],
  ['integrity.meters', ['integrity', 'actual', 'meters'], 800],
  ['integrity.meter_point_links', ['integrity', 'actual', 'meterPointLinks'], 800],
  [
    'integrity.matching_meter_point_links',
    ['integrity', 'actual', 'matchingMeterPointLinks'],
    800
  ],
  [
    'integrity.matching_point_coordinates',
    ['integrity', 'actual', 'matchingPointCoordinates'],
    799
  ],
  ['integrity.matched_point_years', ['integrity', 'actual', 'matchedPointYears'], 1119],
  [
    'integrity.unexpected_matched_point_years',
    ['integrity', 'actual', 'unexpectedMatchedPointYears'],
    1
  ],
  ['gidaf.unassociated', ['integrity', 'actual', 'gidafUnassociated'], 3],
  [
    'gidaf.unassociated_with_values',
    ['integrity', 'actual', 'gidafUnassociatedWithValues'],
    3
  ],
  [
    'gidaf.unassociated_pending_with_values',
    ['integrity', 'actual', 'gidafUnassociatedPendingWithValues'],
    3
  ],
  [
    'integrity.content_digest.declarations',
    ['integrity', 'actual', 'contentDigests', 'declarations'],
    'a'.repeat(64)
  ],
  [
    'integrity.content_digest.sources',
    ['integrity', 'actual', 'contentDigests', 'sources'],
    'b'.repeat(64)
  ],
  [
    'integrity.content_digest.chunks',
    ['integrity', 'actual', 'contentDigests', 'chunks'],
    'c'.repeat(64)
  ],
  [
    'integrity.content_digest.values',
    ['integrity', 'actual', 'contentDigests', 'values'],
    'd'.repeat(64)
  ],
  ['agents.total', ['agents', 'total'], 3],
  ['agents.ddt.total', ['agents', 'ddt', 'total'], 0],
  ['agents.ddt.role', ['agents', 'ddt', 'role'], 'ADMIN'],
  ['agents.ddt.assignments', ['agents', 'ddt', 'assignments'], 3],
  ['agents.ddt.unexpected_assignments', ['agents', 'ddt', 'unexpectedAssignments'], 1],
  ['agents.ddt.zones_exact', ['agents', 'ddt', 'zonesExact'], false],
  ['agents.ddt.is_admin_exact', ['agents', 'ddt', 'isAdminExact'], false],
  ['agents.ddt.permissions_exact', ['agents', 'ddt', 'permissionsExact'], false],
  ['agents.ddt.department_access', ['agents', 'ddt', 'departmentAccess'], 'READ_ONLY'],
  ['agents.ddt.sage_access', ['agents', 'ddt', 'sageAccess'], 'FULL'],
  ['agents.sage.total', ['agents', 'sage', 'total'], 0],
  ['agents.sage.role', ['agents', 'sage', 'role'], 'ADMIN'],
  ['agents.sage.assignments', ['agents', 'sage', 'assignments'], 2],
  ['agents.sage.unexpected_assignments', ['agents', 'sage', 'unexpectedAssignments'], 1],
  ['agents.sage.zones_exact', ['agents', 'sage', 'zonesExact'], false],
  ['agents.sage.is_admin_exact', ['agents', 'sage', 'isAdminExact'], false],
  ['agents.sage.permissions_exact', ['agents', 'sage', 'permissionsExact'], false],
  ['agents.sage.sage_access', ['agents', 'sage', 'sageAccess'], 'READ_ONLY']
]

for (const [code, path, invalidValue] of invalidCases) {
  test(`signale la postcondition invalide ${code}`, t => {
    const state = validState()
    setValue(state, path, invalidValue)

    const result = verifySeedState(state)

    t.false(result.success)
    t.is(result.errors.length, 1)
    t.is(result.errors[0].code, code)
    t.is(result.errors[0].actual, invalidValue)
  })
}

test('expose les attentes sans permettre leur mutation de premier niveau', t => {
  t.true(Object.isFrozen(EXPECTED_SEED_STATE))
  t.true(Object.isFrozen(EXPECTED_SEED_STATE.authentication))
  t.true(Object.isFrozen(EXPECTED_SEED_STATE.points))
  t.true(Object.isFrozen(EXPECTED_SEED_STATE.years))
})
