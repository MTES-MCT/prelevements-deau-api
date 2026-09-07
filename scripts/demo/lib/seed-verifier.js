export const EXPECTED_SEED_STATE = Object.freeze({
  accounts: Object.freeze({matching: 6}),
  authentication: Object.freeze({
    personaUsers: 6,
    emailAliases: 0,
    emailIdentityClaims: 0,
    activeEmailVerifications: 0,
    emailVerificationTokens: 0,
    passwordCredentials: 0,
    passwordActivations: 0
  }),
  zones: Object.freeze({total: 1}),
  preleveurs: Object.freeze({
    total: 300,
    byType: Object.freeze({
      IRRIGANT: 240,
      ICPE: 30,
      GESTIONNAIRE_AEP: 30
    }),
    active: 210
  }),
  points: Object.freeze({
    total: 800,
    byUsageCode: Object.freeze({
      2: 700,
      4: 50,
      5: 50
    }),
    byDepartmentCode: Object.freeze({
      'dep-38': 400,
      'dep-26': 400
    }),
    byWaterBodyType: Object.freeze({
      SUPERFICIELLE: 400,
      SOUTERRAIN: 400
    }),
    declared: 560,
    shared: Object.freeze({
      total: 1,
      preleveurs: 2
    }),
    multiMeter: Object.freeze({
      total: 1,
      minimumMeters: 2
    })
  }),
  ougc: Object.freeze({managedPreleveurs: 200}),
  cohorts: Object.freeze({
    MONTHLY: 150,
    WEEKLY: 40,
    DAILY: 20
  }),
  years: Object.freeze([2025, 2026]),
  agents: Object.freeze({
    total: 2,
    ddt: Object.freeze({
      total: 1,
      role: 'INSTRUCTOR',
      assignments: 2,
      unexpectedAssignments: 0,
      zonesExact: true,
      isAdminExact: true,
      permissionsExact: true,
      departmentAccess: 'FULL',
      sageAccess: 'READ_ONLY'
    }),
    sage: Object.freeze({
      total: 1,
      role: 'INSTRUCTOR',
      assignments: 1,
      unexpectedAssignments: 0,
      zonesExact: true,
      isAdminExact: true,
      permissionsExact: true,
      sageAccess: 'FULL'
    })
  })
})

function getValue(input, path) {
  let value = input

  for (const part of path) {
    if (!value || typeof value !== 'object') {
      return undefined
    }

    value = value[part]
  }

  return value
}

function formatValue(value) {
  if (value === undefined) {
    return 'absent'
  }

  return JSON.stringify(value)
}

function exactCheck({code, label, actual, expected}) {
  return {
    code,
    label,
    expected,
    actual,
    success: Object.is(actual, expected)
  }
}

function datasetExactCheck({code, label, actual, expected}) {
  return {
    code,
    label,
    expected,
    actual,
    operator: 'DATASET_EXACT',
    success: Number.isInteger(expected)
      && expected >= 0
      && Object.is(actual, expected)
  }
}

function minimumCheck({code, label, actual, expected}) {
  return {
    code,
    label,
    expected,
    actual,
    operator: 'GREATER_THAN_OR_EQUAL',
    success: typeof actual === 'number' && Number.isFinite(actual) && actual >= expected
  }
}

function exactSetCheck({code, label, actual, expected}) {
  const success = Array.isArray(actual)
    && actual.length === expected.length
    && expected.every(value => actual.includes(value))

  return {
    code,
    label,
    expected: [...expected],
    actual,
    operator: 'SAME_SET',
    success
  }
}

function contentDigestCheck({code, label, actual, expected}) {
  const sha256Pattern = /^[a-f\d]{64}$/

  return {
    code,
    label,
    expected,
    actual,
    operator: 'SHA256_EXACT',
    success: typeof expected === 'string'
      && sha256Pattern.test(expected)
      && Object.is(actual, expected)
  }
}

function withErrorMessage(check) {
  const expectation = check.operator === 'GREATER_THAN_OR_EQUAL'
    ? `au moins ${formatValue(check.expected)}`
    : formatValue(check.expected)

  return {
    ...check,
    message: `${check.label} : attendu ${expectation}, obtenu ${formatValue(check.actual)}.`
  }
}

export function verifySeedState(state) {
  const checks = []
  const addExact = (code, label, path, expected) => {
    checks.push(exactCheck({
      code,
      label,
      expected,
      actual: getValue(state, path)
    }))
  }

  const addMinimum = (code, label, path, expected) => {
    checks.push(minimumCheck({
      code,
      label,
      expected,
      actual: getValue(state, path)
    }))
  }

  const addDatasetExact = (code, label, expectedField, actualField = expectedField) => {
    checks.push(datasetExactCheck({
      code,
      label,
      expected: getValue(state, ['integrity', 'expected', expectedField]),
      actual: getValue(state, ['integrity', 'actual', actualField])
    }))
  }

  addExact('accounts.matching', 'Nombre de comptes personas correctement associés', ['accounts', 'matching'], EXPECTED_SEED_STATE.accounts.matching)
  addExact('authentication.persona_users', 'Nombre de personas soumis au contrôle d’authentification', ['authentication', 'personaUsers'], EXPECTED_SEED_STATE.authentication.personaUsers)
  addExact('authentication.email_aliases', 'Nombre d’alias email des personas', ['authentication', 'emailAliases'], EXPECTED_SEED_STATE.authentication.emailAliases)
  addExact(
    'authentication.email_identity_claims',
    'Nombre de revendications email secondaires des personas',
    ['authentication', 'emailIdentityClaims'],
    EXPECTED_SEED_STATE.authentication.emailIdentityClaims
  )
  addExact(
    'authentication.active_email_verifications',
    'Nombre de validations email actives des personas',
    ['authentication', 'activeEmailVerifications'],
    EXPECTED_SEED_STATE.authentication.activeEmailVerifications
  )
  addExact(
    'authentication.email_verification_tokens',
    'Nombre de jetons de validation email des personas',
    ['authentication', 'emailVerificationTokens'],
    EXPECTED_SEED_STATE.authentication.emailVerificationTokens
  )
  addExact('authentication.password_credentials', 'Nombre d’identifiants mot de passe des personas', ['authentication', 'passwordCredentials'], EXPECTED_SEED_STATE.authentication.passwordCredentials)
  addExact('authentication.password_activations', 'Nombre d’activations mot de passe des personas', ['authentication', 'passwordActivations'], EXPECTED_SEED_STATE.authentication.passwordActivations)
  addExact('zones.total', 'Nombre de zones du jeu de démonstration', ['zones', 'total'], EXPECTED_SEED_STATE.zones.total)

  addExact('preleveurs.total', 'Nombre total de préleveurs', ['preleveurs', 'total'], EXPECTED_SEED_STATE.preleveurs.total)
  addExact('preleveurs.type.irrigant', 'Nombre de préleveurs irrigants', ['preleveurs', 'byType', 'IRRIGANT'], EXPECTED_SEED_STATE.preleveurs.byType.IRRIGANT)
  addExact('preleveurs.type.icpe', 'Nombre de préleveurs industriels', ['preleveurs', 'byType', 'ICPE'], EXPECTED_SEED_STATE.preleveurs.byType.ICPE)
  addExact('preleveurs.type.gestionnaire_aep', 'Nombre de gestionnaires AEP', ['preleveurs', 'byType', 'GESTIONNAIRE_AEP'], EXPECTED_SEED_STATE.preleveurs.byType.GESTIONNAIRE_AEP)

  addExact('points.total', 'Nombre total de points de prélèvement', ['points', 'total'], EXPECTED_SEED_STATE.points.total)
  addExact('points.usage.2', 'Nombre de points d’irrigation', ['points', 'byUsageCode', '2'], EXPECTED_SEED_STATE.points.byUsageCode[2])
  addExact('points.usage.4', 'Nombre de points industriels', ['points', 'byUsageCode', '4'], EXPECTED_SEED_STATE.points.byUsageCode[4])
  addExact('points.usage.5', 'Nombre de points AEP', ['points', 'byUsageCode', '5'], EXPECTED_SEED_STATE.points.byUsageCode[5])
  addExact('points.department.dep-38', 'Nombre de points en Isère', ['points', 'byDepartmentCode', 'dep-38'], EXPECTED_SEED_STATE.points.byDepartmentCode['dep-38'])
  addExact('points.department.dep-26', 'Nombre de points dans la Drôme', ['points', 'byDepartmentCode', 'dep-26'], EXPECTED_SEED_STATE.points.byDepartmentCode['dep-26'])
  addExact('points.water_body.superficielle', 'Nombre de points en eau superficielle', ['points', 'byWaterBodyType', 'SUPERFICIELLE'], EXPECTED_SEED_STATE.points.byWaterBodyType.SUPERFICIELLE)
  addExact('points.water_body.souterrain', 'Nombre de points en eau souterraine', ['points', 'byWaterBodyType', 'SOUTERRAIN'], EXPECTED_SEED_STATE.points.byWaterBodyType.SOUTERRAIN)

  addExact('ougc.managed_preleveurs', 'Nombre de préleveurs gérés par l’OUGC', ['ougc', 'managedPreleveurs'], EXPECTED_SEED_STATE.ougc.managedPreleveurs)
  addExact('preleveurs.active', 'Nombre de préleveurs ayant déclaré', ['preleveurs', 'active'], EXPECTED_SEED_STATE.preleveurs.active)
  addExact('points.declared', 'Nombre de points déclarés', ['points', 'declared'], EXPECTED_SEED_STATE.points.declared)

  addExact('cohorts.monthly', 'Taille de la cohorte mensuelle', ['cohorts', 'MONTHLY'], EXPECTED_SEED_STATE.cohorts.MONTHLY)
  addExact('cohorts.weekly', 'Taille de la cohorte hebdomadaire', ['cohorts', 'WEEKLY'], EXPECTED_SEED_STATE.cohorts.WEEKLY)
  addExact('cohorts.daily', 'Taille de la cohorte journalière', ['cohorts', 'DAILY'], EXPECTED_SEED_STATE.cohorts.DAILY)

  checks.push(exactSetCheck({
    code: 'years',
    label: 'Années couvertes',
    expected: EXPECTED_SEED_STATE.years,
    actual: getValue(state, ['years'])
  }))

  addExact('points.shared.total', 'Nombre de points partagés', ['points', 'shared', 'total'], EXPECTED_SEED_STATE.points.shared.total)
  addExact('points.shared.preleveurs', 'Nombre de préleveurs du point partagé', ['points', 'shared', 'preleveurs'], EXPECTED_SEED_STATE.points.shared.preleveurs)
  addExact('points.multi_meter.total', 'Nombre de points multi-compteurs', ['points', 'multiMeter', 'total'], EXPECTED_SEED_STATE.points.multiMeter.total)
  addMinimum('points.multi_meter.meters', 'Nombre de compteurs sur le point multi-compteurs', ['points', 'multiMeter', 'meters'], EXPECTED_SEED_STATE.points.multiMeter.minimumMeters)

  addDatasetExact('integrity.declarations', 'Nombre exact de déclarations du dataset', 'declarations')
  addDatasetExact('integrity.sources', 'Nombre exact de sources du dataset', 'sources')
  addDatasetExact(
    'integrity.completed_sources',
    'Nombre exact de sources terminées',
    'sources',
    'completedSources'
  )
  addDatasetExact('integrity.chunks', 'Nombre exact de lignes de déclaration', 'chunks')
  addDatasetExact('integrity.values', 'Nombre exact de valeurs déclarées', 'values')
  addDatasetExact('integrity.exploitations', 'Nombre exact d’exploitations', 'exploitations')
  addDatasetExact('integrity.meters', 'Nombre exact de compteurs', 'meters')
  addDatasetExact('integrity.meter_point_links', 'Nombre exact de liens compteur-point', 'meterPointLinks')
  addDatasetExact(
    'integrity.matching_meter_point_links',
    'Nombre exact de liens compteur-point conformes',
    'matchingMeterPointLinks'
  )
  addDatasetExact(
    'integrity.matching_point_coordinates',
    'Nombre exact de coordonnées de point conformes',
    'matchingPointCoordinates'
  )
  addDatasetExact(
    'integrity.matched_point_years',
    'Nombre exact de couples point et année rapprochés',
    'matchedPointYears'
  )
  addDatasetExact(
    'integrity.unexpected_matched_point_years',
    'Nombre de couples point et année inattendus',
    'unexpectedMatchedPointYears'
  )
  addDatasetExact(
    'gidaf.unassociated',
    'Nombre exact de lignes GIDAF non rapprochées',
    'gidafUnassociated'
  )
  addDatasetExact(
    'gidaf.unassociated_with_values',
    'Nombre exact de lignes GIDAF non rapprochées avec valeurs',
    'gidafUnassociatedWithValues'
  )
  addDatasetExact(
    'gidaf.unassociated_pending_with_values',
    'Nombre exact de lignes GIDAF non rapprochées en attente avec valeurs',
    'gidafUnassociatedPendingWithValues'
  )

  for (const [contentType, label] of [
    ['declarations', 'déclarations'],
    ['sources', 'sources'],
    ['chunks', 'lignes de déclaration'],
    ['values', 'valeurs déclarées']
  ]) {
    checks.push(contentDigestCheck({
      code: `integrity.content_digest.${contentType}`,
      label: `Empreinte exacte du contenu possédé des ${label}`,
      expected: getValue(state, ['integrity', 'expected', 'contentDigests', contentType]),
      actual: getValue(state, ['integrity', 'actual', 'contentDigests', contentType])
    }))
  }

  addExact('agents.total', 'Nombre total d’agents', ['agents', 'total'], EXPECTED_SEED_STATE.agents.total)
  addExact('agents.ddt.total', 'Nombre d’agents DDT', ['agents', 'ddt', 'total'], EXPECTED_SEED_STATE.agents.ddt.total)
  addExact('agents.ddt.role', 'Rôle du persona DDT', ['agents', 'ddt', 'role'], EXPECTED_SEED_STATE.agents.ddt.role)
  addExact('agents.ddt.assignments', 'Nombre d’affectations du persona DDT', ['agents', 'ddt', 'assignments'], EXPECTED_SEED_STATE.agents.ddt.assignments)
  addExact('agents.ddt.unexpected_assignments', 'Affectations hors contrat du persona DDT', ['agents', 'ddt', 'unexpectedAssignments'], EXPECTED_SEED_STATE.agents.ddt.unexpectedAssignments)
  addExact('agents.ddt.zones_exact', 'Zones exactes du persona DDT', ['agents', 'ddt', 'zonesExact'], EXPECTED_SEED_STATE.agents.ddt.zonesExact)
  addExact('agents.ddt.is_admin_exact', 'Indicateurs administrateur exacts du persona DDT', ['agents', 'ddt', 'isAdminExact'], EXPECTED_SEED_STATE.agents.ddt.isAdminExact)
  addExact('agents.ddt.permissions_exact', 'Permissions exactes du persona DDT', ['agents', 'ddt', 'permissionsExact'], EXPECTED_SEED_STATE.agents.ddt.permissionsExact)
  addExact('agents.ddt.department_access', 'Droits DDT sur son département', ['agents', 'ddt', 'departmentAccess'], EXPECTED_SEED_STATE.agents.ddt.departmentAccess)
  addExact('agents.ddt.sage_access', 'Droits DDT sur le SAGE', ['agents', 'ddt', 'sageAccess'], EXPECTED_SEED_STATE.agents.ddt.sageAccess)
  addExact('agents.sage.total', 'Nombre d’agents SAGE', ['agents', 'sage', 'total'], EXPECTED_SEED_STATE.agents.sage.total)
  addExact('agents.sage.role', 'Rôle du persona SAGE', ['agents', 'sage', 'role'], EXPECTED_SEED_STATE.agents.sage.role)
  addExact('agents.sage.assignments', 'Nombre d’affectations du persona SAGE', ['agents', 'sage', 'assignments'], EXPECTED_SEED_STATE.agents.sage.assignments)
  addExact('agents.sage.unexpected_assignments', 'Affectations hors contrat du persona SAGE', ['agents', 'sage', 'unexpectedAssignments'], EXPECTED_SEED_STATE.agents.sage.unexpectedAssignments)
  addExact('agents.sage.zones_exact', 'Zones exactes du persona SAGE', ['agents', 'sage', 'zonesExact'], EXPECTED_SEED_STATE.agents.sage.zonesExact)
  addExact('agents.sage.is_admin_exact', 'Indicateurs administrateur exacts du persona SAGE', ['agents', 'sage', 'isAdminExact'], EXPECTED_SEED_STATE.agents.sage.isAdminExact)
  addExact('agents.sage.permissions_exact', 'Permissions exactes du persona SAGE', ['agents', 'sage', 'permissionsExact'], EXPECTED_SEED_STATE.agents.sage.permissionsExact)
  addExact('agents.sage.sage_access', 'Droits de l’agent SAGE', ['agents', 'sage', 'sageAccess'], EXPECTED_SEED_STATE.agents.sage.sageAccess)

  const errors = checks
    .filter(check => !check.success)
    .map(withErrorMessage)

  return {
    success: errors.length === 0,
    checks,
    errors
  }
}
