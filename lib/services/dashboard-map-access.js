function selectedZonesHavePermissions(selectedZones, permissions) {
  return selectedZones.length > 0
    && selectedZones.every(zone => permissions.every(permission =>
      zone.permissions?.includes(permission)))
}

export function getDashboardMapCapabilities(user, selectedZones = []) {
  if (user?.role === 'ADMIN' || user?.role === 'DECLARANT') {
    return {
      readPointActors: true,
      readPointDetails: true
    }
  }

  return {
    readPointActors: selectedZonesHavePermissions(selectedZones, [
      'zone.dashboard.read',
      'exploitation.list',
      'declarant.list'
    ]),
    readPointDetails: selectedZonesHavePermissions(selectedZones, [
      'zone.dashboard.read',
      'pp.detail.read'
    ])
  }
}

export function getDashboardMapPointScope(user) {
  if (user?.role !== 'DECLARANT') {
    return {collecteurUserId: null, declarantUserIds: null}
  }

  if (user.declarant?.declarantRole === 'COLLECTEUR') {
    return {collecteurUserId: user.id, declarantUserIds: null}
  }

  return {collecteurUserId: null, declarantUserIds: [user.id]}
}
