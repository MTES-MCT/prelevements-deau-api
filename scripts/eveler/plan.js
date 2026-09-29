import {digest} from './manifest.js'

function assert(condition, code) {
  if (!condition) throw new Error(code)
}

function matchingFields(actual, expected, code) {
  const mismatches = Object.keys(expected).filter(key => actual[key] !== expected[key])
  assert(!mismatches.length, `${code}: ${mismatches.join(',')}`)
}

const entityId = entity => entity?.id ?? null

function assertPoint(point, expected, usageLabel) {
  if (point) {
    matchingFields(point, {
      name: expected.name, sourceId: expected.sourceId, waterBodyType: expected.waterBodyType,
      flowType: expected.flowType, pointKind: expected.pointKind, nature: expected.nature,
      withdrawalType: expected.withdrawalType, isZre: expected.isZre, deletedAt: null, usageName: usageLabel,
      ...(expected.communeCode ? {communeCode: expected.communeCode, communeName: expected.communeName} : {})
    }, 'POINT_CONFLICT')
    assert(point.coordinateDistance !== null && point.coordinateDistance < 0.001, 'POINT_COORDINATES_CONFLICT')
    assert(point.identifiers?.DDT === expected.identifiers.DDT, 'POINT_IDENTIFIER_CONFLICT')
  }
}

function assertUser(user, preleveur, emailIdentity) {
  if (user) {
    matchingFields(user, {
      email: preleveur.email, firstName: preleveur.firstName, lastName: preleveur.lastName,
      role: 'DECLARANT', deletedAt: null
    }, 'USER_CONFLICT')
    if (user.declarantUserId) {
      matchingFields(user, {
        socialReason: preleveur.companyName, siret: preleveur.siret,
        declarantType: 'LEGAL_PERSON', declarantRole: 'PRELEVEUR'
      }, 'PRELEVEUR_CONFLICT')
    }
  }
  if (emailIdentity) {
    assert(!emailIdentity.aliasUserId || emailIdentity.aliasUserId === user?.id, 'EMAIL_ALIAS_CONFLICT')
    assert(!emailIdentity.verificationUserId || emailIdentity.verificationUserId === user?.id, 'EMAIL_RESERVED')
    assert(emailIdentity.primaryUserId === user?.id, 'EMAIL_IDENTITY_CONFLICT')
  } else {
    assert(!user, 'EMAIL_IDENTITY_MISSING')
  }
}

function assertConnector(existingConnector, exploitation, connector) {
  if (existingConnector) {
    matchingFields(existingConnector, {declarantPointPrelevementId: exploitation?.id, connectorType: 'eveler', rate: connector.rate}, 'CONNECTOR_CONFLICT')
    assert(digest(existingConnector.connectorParameters) === digest({sourcePointId: connector.sourcePointId, sourceMeterId: connector.sourceMeterId, sourceStartDate: connector.sourceStartDate}), 'CONNECTOR_PARAMETERS_CONFLICT')
  }
}

export function buildPlan(manifest, inventory) {
  const {point: expected, preleveur, connector, serviceAccount} = manifest
  const {points, users, emailIdentity, exploitations, connectors, accounts, zoneIds, pointZones, declarantZones, usage} = inventory
  assert(points.length <= 1, 'POINT_AMBIGUOUS')
  assert(users.length <= 1, 'PRELEVEUR_AMBIGUOUS')
  assert(usage?.code === manifest.exploitation.usageCode, 'USAGE_MISSING')
  assert(usage.kind === 'SUB_USAGE' && usage.parentKind === 'USAGE' && usage.parentCode === '7' && usage.parentId && usage.label, 'USAGE_HIERARCHY_CONFLICT')
  const usageComment = `Usage SANDRE : ${usage.code} — ${usage.label}.`
  assert(zoneIds.length > 0, 'POINT_ZONES_MISSING')
  const point = points[0]
  const user = users[0]
  assertPoint(point, expected, usage.label)
  assertUser(user, preleveur, emailIdentity)
  assert(exploitations.length <= 1, 'EXPLOITATION_AMBIGUOUS')
  const exploitation = exploitations[0]
  if (exploitation) matchingFields(exploitation, {usageId: usage.parentId, status: 'EN_ACTIVITE', endDate: null, comment: usageComment}, 'EXPLOITATION_CONFLICT')
  assert(connectors.length <= 1, 'CONNECTOR_AMBIGUOUS')
  const existingConnector = connectors[0]
  assertConnector(existingConnector, exploitation, connector)
  assert(accounts.length <= 1, 'SERVICE_ACCOUNT_AMBIGUOUS')
  const account = accounts[0]
  if (serviceAccount) {
    assert(account, 'SERVICE_ACCOUNT_MISSING')
    matchingFields(account, {id: serviceAccount.existingId, isActive: true, deletedAt: null}, 'SERVICE_ACCOUNT_CONFLICT')
  }
  const actions = []
  if (!point) actions.push('create-point')
  if (!user) actions.push('create-user')
  if (!user?.declarantUserId) actions.push('create-preleveur-profile')
  if (!exploitation) actions.push('create-exploitation')
  if (!existingConnector) actions.push('create-connector')
  const missingPointZones = zoneIds.filter(id => !pointZones.includes(id))
  const missingDeclarantZones = zoneIds.filter(id => !declarantZones.includes(id))
  if (missingPointZones.length) actions.push('add-point-zones')
  if (missingDeclarantZones.length) actions.push('add-preleveur-zones')
  return {
    actions, missingPointZones, missingDeclarantZones,
    usageResolution: {requestedCode: usage.code, requestedLabel: usage.label, primaryCode: usage.parentCode, primaryId: usage.parentId, comment: usageComment},
    ids: {pointId: entityId(point), userId: entityId(user), exploitationId: entityId(exploitation), connectorId: entityId(existingConnector), serviceAccountId: entityId(account)}
  }
}
