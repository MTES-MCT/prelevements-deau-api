import {normalizeManifest} from '../manifest.js'

export const manifestInput = {
  schemaVersion: 1,
  point: {
    name: 'Forage synthétique', sourceId: 'DDT99:SYNTHETIC', identifiers: {DDT: 'SYNTHETIC'},
    coordinatesLambert93: {x: 700000, y: 6600000}, waterBodyType: 'SOUTERRAIN',
    flowType: 'PRELEVEMENT', pointKind: 'PHYSIQUE', nature: 'NAPPE', withdrawalType: 'SOUTERRAIN', isZre: false
  },
  preleveur: {companyName: 'Société synthétique', email: 'synthetic@example.test', siret: '00000000000000', firstName: 'Camille', lastName: 'Exemple', type: 'PM'},
  exploitation: {usageCode: '7E', status: 'EN_ACTIVITE'},
  connector: {type: 'eveler', sourcePointId: 'synthetic-meter', sourceMeterId: '000000000000000000000001', sourceStartDate: '2025-01-02T03:00:00Z', rate: 100}
}

export function fixture() {
  const manifest = normalizeManifest(manifestInput)
  const inventory = {
    points: [], users: [], emailIdentity: null, usage: {id: 'usage-id', code: '7E', kind: 'SUB_USAGE', label: 'Canon à neige', parentId: 'root-usage-id', parentCode: '7', parentKind: 'USAGE'},
    zones: [], zoneIds: ['zone-id'], exploitations: [], connectors: [], pointZones: [], declarantZones: [], accounts: []
  }
  return {manifest, inventory}
}

export function existingFixture() {
  const {manifest, inventory} = fixture()
  inventory.points = [{...manifest.point, id: 'point-id', coordinateDistance: 0, deletedAt: null, usageName: 'Canon à neige'}]
  inventory.users = [{id: 'user-id', declarantUserId: 'user-id', email: manifest.preleveur.email,
    firstName: manifest.preleveur.firstName, lastName: manifest.preleveur.lastName, role: 'DECLARANT', deletedAt: null,
    socialReason: manifest.preleveur.companyName, siret: manifest.preleveur.siret, declarantType: 'LEGAL_PERSON', declarantRole: 'PRELEVEUR'}]
  inventory.emailIdentity = {primaryUserId: 'user-id', aliasUserId: null, verificationUserId: null}
  inventory.exploitations = [{id: 'exploitation-id', usageId: 'root-usage-id', status: 'EN_ACTIVITE', startDate: null, endDate: null, comment: 'Usage SANDRE : 7E — Canon à neige.'}]
  inventory.connectors = [{id: 'connector-id', declarantPointPrelevementId: 'exploitation-id', connectorType: 'eveler', rate: 100,
    connectorParameters: {sourcePointId: manifest.connector.sourcePointId, sourceMeterId: manifest.connector.sourceMeterId, sourceStartDate: manifest.connector.sourceStartDate}}]
  inventory.pointZones = ['zone-id']
  inventory.declarantZones = ['zone-id']
  return {manifest, inventory}
}
