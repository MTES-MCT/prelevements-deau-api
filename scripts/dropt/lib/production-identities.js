import {assertConnectedProdAdminDatabase} from '../../network/prod-database-target.js'
import {SCOPE} from './epidropt.js'

export async function assertDroptProdIdentityAnchors(client, manifest) {
  const references = await client.externalReference.findMany({where: {scope: SCOPE},
    select: {kind: true, provider: true, externalId: true, pointPrelevementId: true, declarantUserId: true, compteurId: true}})
  const collisions = []
  for (const [key, model, kind, idField, referenceField] of [
    ['points', 'pointPrelevement', 'POINT', 'id', 'pointPrelevementId'],
    ['declarants', 'declarant', 'DECLARANT', 'userId', 'declarantUserId'],
    ['meters', 'compteur', 'METER', 'id', 'compteurId'],
    ['exploitations', 'declarantPointPrelevement', 'EXPLOITATION', 'id', null]
  ]) {
    const records = new Map(manifest[key].map(record => [record.id, record]))
    const serials = new Map(kind === 'METER' ? manifest.meters.map(record => [record.serial, record]) : [])
    const where = kind === 'METER' ? {OR: [{id: {in: [...records.keys()]}}, {serialNumber: {in: [...serials.keys()]}}]}
      : {[idField]: {in: [...records.keys()]}}
    const existing = await client[model].findMany({where, select: {[idField]: true, ...(kind === 'METER' ? {serialNumber: true} : {sourceId: true})}})
    for (const row of existing) {
      const id = row[idField]
      const record = records.get(id) ?? serials.get(row.serialNumber)
      const sourceMatches = record.sourceId && row.sourceId === record.sourceId
      const referenceMatches = referenceField && references.some(reference => reference.kind === kind && reference[referenceField] === id
        && record.references?.some(expected => expected.provider === reference.provider && expected.externalId === reference.externalId))
      if (!sourceMatches && !referenceMatches) collisions.push({kind, id,
        code: id === record.id ? 'UUID_PRODUCTION_SANS_ANCRAGE' : 'NUMERO_COMPTEUR_PRODUCTION_SANS_ANCRAGE'})
    }
  }
  if (collisions.length) throw Object.assign(new Error('UUID_PRODUCTION_SANS_ANCRAGE : rapprochement explicite requis avant import.'),
    {manifestHash: manifest.manifestHash, identityCollisions: collisions})
}

export function guardedDroptProdClient(client, manifest) {
  return new Proxy(client, {get(target, property) {
    if (property === '$transaction') return (execute, options) => target.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('dropt-referential'), hashtext(${SCOPE}))`
      await assertConnectedProdAdminDatabase(tx)
      await assertDroptProdIdentityAnchors(tx, manifest)
      return execute(tx)
    }, {...options, isolationLevel: 'Serializable'})
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  }})
}

export async function getDroptOperationClient(client, manifest, {target, operation}) {
  if (target !== 'prod') return client
  if (operation === 'verify') await assertDroptProdIdentityAnchors(client, manifest)
  return guardedDroptProdClient(client, manifest)
}
