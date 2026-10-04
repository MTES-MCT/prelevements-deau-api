import test from 'ava'

import {
  getAllowedTypesMetaForDeclarant,
  serializeQuickDeclarationPoint,
  shouldIncludeAllowedTypePreleveurs
} from '../declarations.js'

function declarationType(id, code, name) {
  return {
    id,
    code,
    name,
    version: 1,
    isAvailable: true
  }
}

function createAllowedTypesDependencies(preleveurs, allowedTypesByDeclarantId, eligibleDeclarantIds = preleveurs.map(preleveur => preleveur.id)) {
  const calls = {
    profile: 0,
    targets: 0,
    types: 0,
    typeDeclarantUserIds: [],
    quickEligibility: 0,
    quickEligibilityQuery: null
  }

  return {
    calls,
    options: {
      async findDeclarantProfile() {
        calls.profile += 1
        return {
          declarantRole: 'COLLECTEUR',
          quickDeclarationEnabled: true
        }
      },
      async findDeclarationTargets() {
        calls.targets += 1
        return preleveurs
      },
      async listAllowedTypes(declarantUserIds) {
        calls.types += 1
        calls.typeDeclarantUserIds = declarantUserIds
        return new Map(declarantUserIds.map(declarantUserId => [
          declarantUserId,
          allowedTypesByDeclarantId.get(declarantUserId) ?? []
        ]))
      },
      async findQuickDeclarationEligibleDeclarantIds(query) {
        calls.quickEligibility += 1
        calls.quickEligibilityQuery = query
        return new Set(eligibleDeclarantIds)
      }
    }
  }
}

test('getAllowedTypesMetaForDeclarant conserve le contrat fonctionnel avec un nombre constant de lectures', async t => {
  const collecteurType = declarationType('type-template', 'template-file', 'Modèle de déclaration')
  const preleveurType = declarationType('type-quick', 'quick-declaration', 'Saisie rapide')
  const preleveurs = Array.from({length: 600}, (_, index) => ({
    id: `preleveur-${index}`,
    email: `preleveur-${index}@example.test`,
    loginEmail: `preleveur-${index}@example.test`,
    contactEmails: [{email: `contact-${index}@example.test`, isPrimary: true}],
    firstName: `Prénom ${index}`,
    lastName: `Nom ${index}`,
    declarant: {
      userId: `preleveur-${index}`,
      declarantRole: 'PRELEVEUR',
      socialReason: index === 0 ? 'Exploitation principale' : null,
      quickDeclarationEnabled: index !== 1,
      user: {
        id: `preleveur-${index}`,
        email: `preleveur-${index}@example.test`,
        firstName: `Prénom ${index}`,
        lastName: `Nom ${index}`
      }
    }
  }))
  const allowedTypesByDeclarantId = new Map([
    ['collecteur-1', [collecteurType]],
    ['preleveur-0', [preleveurType]]
  ])
  const {calls, options} = createAllowedTypesDependencies(
    preleveurs,
    allowedTypesByDeclarantId,
    ['preleveur-0', 'preleveur-1']
  )

  const result = await getAllowedTypesMetaForDeclarant('collecteur-1', options)

  t.deepEqual(calls, {
    profile: 1,
    targets: 1,
    types: 1,
    typeDeclarantUserIds: [
      'collecteur-1',
      ...preleveurs.map(preleveur => preleveur.id)
    ],
    quickEligibility: 1,
    quickEligibilityQuery: {
      actorDeclarantUserId: 'collecteur-1',
      declarantUserIds: preleveurs.filter(preleveur => preleveur.id !== 'preleveur-1').map(preleveur => preleveur.id)
    }
  })
  t.deepEqual(result.data, [collecteurType])
  t.deepEqual(Object.keys(result.meta), [
    'declarantRole',
    'quickDeclarationEnabled',
    'canCreateDeclaration',
    'canCreateQuickDeclaration',
    'allowedDeclarationTypes',
    'preleveurs'
  ])
  t.like(result.meta, {
    declarantRole: 'COLLECTEUR',
    quickDeclarationEnabled: true,
    canCreateDeclaration: true,
    canCreateQuickDeclaration: true,
    allowedDeclarationTypes: [collecteurType]
  })
  t.is(result.meta.preleveurs.length, 600)
  t.deepEqual(Object.keys(result.meta.preleveurs[0]), [
    'id',
    'userId',
    'firstName',
    'lastName',
    'email',
    'loginEmail',
    'contactEmails',
    'declarant',
    'quickDeclarationEnabled',
    'canCreateQuickDeclaration',
    'allowedDeclarationTypes'
  ])
  t.deepEqual(result.meta.preleveurs[0].contactEmails, [{
    email: 'contact-0@example.test',
    isPrimary: true
  }])
  t.deepEqual(result.meta.preleveurs[0].allowedDeclarationTypes, [preleveurType])
  t.true(result.meta.preleveurs[0].canCreateQuickDeclaration)
  t.false(result.meta.preleveurs[1].canCreateQuickDeclaration)
  t.false(result.meta.preleveurs[2].canCreateQuickDeclaration)
  t.false(Object.hasOwn(result.meta.preleveurs[0].declarant, 'collecteurExploitations'))
  t.false(Object.hasOwn(result.meta.preleveurs[0].declarant, 'pointPrelevements'))
})

test('getAllowedTypesMetaForDeclarant peut omettre les préleveurs sans modifier les capacités', async t => {
  const collecteurType = declarationType('type-template', 'template-file', 'Modèle de déclaration')
  const preleveurs = [{
    id: 'preleveur-1',
    email: null,
    firstName: 'Alice',
    lastName: 'Martin',
    declarant: {
      userId: 'preleveur-1',
      socialReason: null,
      quickDeclarationEnabled: true
    }
  }]
  const {calls, options} = createAllowedTypesDependencies(
    preleveurs,
    new Map([['collecteur-1', [collecteurType]]])
  )

  const result = await getAllowedTypesMetaForDeclarant('collecteur-1', {
    ...options,
    includePreleveurs: false
  })

  t.deepEqual(calls.typeDeclarantUserIds, ['collecteur-1'])
  t.is(calls.types, 1)
  t.deepEqual(result.meta.preleveurs, [])
  t.true(result.meta.canCreateQuickDeclaration)
  t.deepEqual(result.meta.allowedDeclarationTypes, [collecteurType])
  t.is(calls.quickEligibility, 1)
  t.deepEqual(calls.quickEligibilityQuery.declarantUserIds, ['preleveur-1'])
})

test('un collecteur sans exploitation éligible ne peut pas créer de saisie rapide', async t => {
  const {options} = createAllowedTypesDependencies([
    {id: 'preleveur-1', declarant: {quickDeclarationEnabled: true}}
  ], new Map(), [])

  await Promise.all([true, false].map(async includePreleveurs => {
    const result = await getAllowedTypesMetaForDeclarant('collecteur-1', {...options, includePreleveurs})
    t.true(result.meta.quickDeclarationEnabled)
    t.false(result.meta.canCreateQuickDeclaration)
    if (includePreleveurs) t.false(result.meta.preleveurs[0].canCreateQuickDeclaration)
  }))
})

test('le droit global désactivé du collecteur bloque la saisie même avec une exploitation éligible', async t => {
  const {calls, options} = createAllowedTypesDependencies([
    {id: 'preleveur-1', declarant: {quickDeclarationEnabled: true}}
  ], new Map())
  options.findDeclarantProfile = async () => ({declarantRole: 'COLLECTEUR', quickDeclarationEnabled: false})

  const result = await getAllowedTypesMetaForDeclarant('collecteur-1', options)

  t.false(result.meta.quickDeclarationEnabled)
  t.false(result.meta.canCreateQuickDeclaration)
  t.false(result.meta.preleveurs[0].canCreateQuickDeclaration)
  t.true(result.meta.preleveurs[0].quickDeclarationEnabled)
  t.is(calls.quickEligibility, 0)
})

test('la capacité du préleveur nécessite une exploitation éligible et préserve son réglage global', async t => {
  await Promise.all([[true, true, true], [true, false, false], [false, true, false]].map(async ([quickDeclarationEnabled, eligible, expected]) => {
    const {calls, options} = createAllowedTypesDependencies([], new Map(), eligible ? ['preleveur-1'] : [])
    options.findDeclarantProfile = async () => ({declarantRole: 'PRELEVEUR', quickDeclarationEnabled})

    const result = await getAllowedTypesMetaForDeclarant('preleveur-1', options)

    t.is(result.meta.quickDeclarationEnabled, quickDeclarationEnabled)
    t.is(result.meta.canCreateQuickDeclaration, expected)
    t.is(calls.quickEligibility, quickDeclarationEnabled ? 1 : 0)
    t.is(calls.targets, 0)
  }))
})

test('includePreleveurs reste compatible par défaut et accepte false explicitement', t => {
  t.true(shouldIncludeAllowedTypePreleveurs(undefined))
  t.true(shouldIncludeAllowedTypePreleveurs('true'))
  t.true(shouldIncludeAllowedTypePreleveurs(['true']))
  t.false(shouldIncludeAllowedTypePreleveurs(false))
  t.false(shouldIncludeAllowedTypePreleveurs('false'))
  t.false(shouldIncludeAllowedTypePreleveurs(['false']))
})

test('serializeQuickDeclarationPoint ne duplique pas le catalogue global des usages', t => {
  const pointId = 'point-1'
  const irrigation = {
    id: 'usage-irrigation',
    code: '2',
    kind: 'USAGE',
    parentId: null,
    mnemonic: null,
    label: 'Irrigation',
    definition: null,
    status: null,
    color: '#000091',
    dashboardVisible: true
  }
  const cooling = {
    ...irrigation,
    id: 'usage-cooling',
    code: '5',
    label: 'Refroidissement'
  }
  const historicalUsage = {
    ...irrigation,
    id: 'usage-historical',
    code: '1',
    label: 'Alimentation en eau potable'
  }
  const point = serializeQuickDeclarationPoint({
    coordsById: new Map([[pointId, {type: 'Point', coordinates: [2, 48]}]]),
    exploitation: {
      id: 'exploitation-1',
      pointPrelevement: {
        id: pointId,
        name: 'Forage 1',
        usageName: 'Parcelle nord',
        flowType: 'PRELEVEMENT',
        waterBodyType: 'SOUTERRAIN',
        nature: 'NAPPE',
        withdrawalType: 'SOUTERRAIN'
      },
      usage: irrigation,
      secondaryUsageLinks: [{usage: cooling}]
    },
    lastKnownUsagesByPointId: new Map([[pointId, historicalUsage]]),
    lastReadingsByPointId: new Map(),
    lastVolumePeriodsByPointId: new Map()
  })
  const response = {
    usageOptions: [irrigation],
    points: [point, {...point, id: 'point-2', pointPrelevementId: 'point-2'}]
  }
  const serialized = JSON.stringify(response)

  t.false(Object.hasOwn(point, 'usageOptions'))
  t.false(Object.hasOwn(point, 'declarationUsageOptions'))
  t.deepEqual(point.usage, irrigation)
  t.deepEqual(point.secondaryUsages, [cooling])
  t.deepEqual(point.lastKnownUsage, historicalUsage)
  t.is(serialized.match(/"usageOptions"/g)?.length, 1)
})
