import {
  READ_ONLY_ZONE_PERMISSIONS,
  serializeZonePermissionCatalog
} from '../constants/zone-permissions.js'

export function getZonePermissionCatalogHandler(_req, res) {
  res.json({
    groups: serializeZonePermissionCatalog(),
    defaults: [...READ_ONLY_ZONE_PERMISSIONS]
  })
}
