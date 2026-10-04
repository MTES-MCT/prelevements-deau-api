import test from 'ava'
import process from 'node:process'
import {randomUUID} from 'node:crypto'
import {prisma} from '../../../../db/prisma.js'
import {requireDisposableDatabase} from '../../../../lib/util/test-helpers/disposable-database.js'
import {assertDroptProdIdentityAnchors} from '../production-identities.js'
import {SCOPE} from '../epidropt.js'

const enabled = process.env.DROPT_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

integration('production identity preflight checks real Prisma references and rejects bare UUIDs and serial numbers', async t => {
  const id = randomUUID()
  const serialNumber = `GUARD-${id}`
  const sourceId = `dropt-epidropt:point:guard-${id}`
  const referenceId = randomUUID()
  const manifest = {points: [{id, sourceId, references: []}], declarants: [], exploitations: [],
    meters: [{id, serial: serialNumber, references: [{provider: 'epidropt', externalId: `guard-${id}`}]}]}
  try {
    await prisma.compteur.create({data: {id, serialNumber}})
    await prisma.pointPrelevement.create({data: {id, name: `Synthetic identity guard ${id}`, waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'}})
    const collision = await t.throwsAsync(assertDroptProdIdentityAnchors(prisma, manifest))
    t.deepEqual(collision.identityCollisions.map(row => row.kind), ['POINT', 'METER'])
    await prisma.pointPrelevement.update({where: {id}, data: {sourceId}})
    manifest.meters[0].id = randomUUID()
    const serialCollision = await t.throwsAsync(assertDroptProdIdentityAnchors(prisma, manifest))
    t.deepEqual(serialCollision.identityCollisions, [{kind: 'METER', id, code: 'NUMERO_COMPTEUR_PRODUCTION_SANS_ANCRAGE'}])
    await prisma.externalReference.create({data: {id: referenceId, kind: 'METER', provider: 'epidropt', scope: SCOPE,
      externalId: `guard-${id}`, compteurId: id}})
    await t.notThrowsAsync(assertDroptProdIdentityAnchors(prisma, manifest))
  } finally {
    await prisma.externalReference.deleteMany({where: {id: referenceId}})
    await prisma.pointPrelevement.deleteMany({where: {id}})
    await prisma.compteur.deleteMany({where: {id}})
  }
})
