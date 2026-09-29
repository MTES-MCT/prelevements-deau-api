import {randomUUID} from 'node:crypto'
import process from 'node:process'
import test from 'ava'

import {prisma} from '../../../db/prisma.js'
import {getPointPrelevement} from '../../models/point-prelevement.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {createPointPrelevement, decoratePointPrelevement, updatePointPrelevement} from '../point-prelevement.js'

const databaseUrl = process.env.PUBLIC_STATS_TEST_DATABASE_URL
const integration = databaseUrl ? test.serial : test.skip
const admin = {role: 'ADMIN'}

test.before(() => {
  if (!databaseUrl) return
  requireDisposableDatabase(databaseUrl)
  requireDisposableDatabase()
  if (databaseUrl !== process.env.DATABASE_URL) {
    throw new Error('Les tests de points exigent DATABASE_URL et PUBLIC_STATS_TEST_DATABASE_URL sur la même base jetable.')
  }
})

test.after.always(async () => {
  await prisma.$disconnect()
  await globalThis.pgPool?.end()
})

async function withPoint(fields, operation) {
  const point = await createPointPrelevement({
    name: `Plan d’eau synthétique ${randomUUID()}`,
    waterBodyType: 'SUPERFICIELLE',
    flowType: 'PRELEVEMENT',
    nature: 'PLAN_EAU',
    coordinates: {type: 'Point', coordinates: [2, 46]},
    ...fields
  }, {user: admin})
  try {
    await operation(point)
  } finally {
    await prisma.pointPrelevement.delete({where: {id: point.id}})
  }
}

integration('les caractéristiques du plan d’eau survivent à l’INSERT SQL et à la sérialisation de la fiche', async t => {
  const fields = {reservoirNominalVolume: 12000.75, waterBodyIdentifier: '00042/Retenue-A'}
  await withPoint(fields, async point => {
    t.like(point, fields)
    const storedPoint = await getPointPrelevement(point.id)
    t.like(storedPoint, fields)
    const decorated = await decoratePointPrelevement(storedPoint, {user: admin})
    t.like(JSON.parse(JSON.stringify(decorated)), fields)

    // Plusieurs points peuvent concerner un même plan d’eau.
    await withPoint(fields, async other => {
      t.not(other.id, point.id)
      t.is(other.waterBodyIdentifier, point.waterBodyIdentifier)
    })
  })
})

integration('un ancien payload reste valide et les nouvelles caractéristiques sont null', async t => {
  await withPoint({}, async point => {
    t.is(point.reservoirNominalVolume, null)
    t.is(point.waterBodyIdentifier, null)
  })
})

integration('les modifications partielles préservent les caractéristiques absentes du patch', async t => {
  await withPoint({
    reservoirNominalVolume: 12000.75,
    waterBodyIdentifier: '00042',
    isWaterBodyConnectedToStream: true,
    isWaterBodyConnectedToGroundwater: false
  }, async point => {
    const unrelated = await updatePointPrelevement(point.id, {comment: 'Observation synthétique'}, {user: admin})
    t.like(unrelated, {reservoirNominalVolume: 12000.75, waterBodyIdentifier: '00042'})

    const volume = await updatePointPrelevement(point.id, {reservoirNominalVolume: 25000.5}, {user: admin})
    t.like(volume, {reservoirNominalVolume: 25000.5, waterBodyIdentifier: '00042'})
    const identifier = await updatePointPrelevement(point.id, {waterBodyIdentifier: '  00043  '}, {user: admin})
    t.like(identifier, {reservoirNominalVolume: 25000.5, waterBodyIdentifier: '00043'})

    const cleared = await updatePointPrelevement(point.id, {reservoirNominalVolume: null}, {user: admin})
    t.like(cleared, {
      reservoirNominalVolume: null,
      waterBodyIdentifier: '00043',
      isWaterBodyConnectedToStream: true,
      isWaterBodyConnectedToGroundwater: false
    })
  })
})

integration('changer l’origine hors plan d’eau efface toutes les caractéristiques associées', async t => {
  await withPoint({
    reservoirNominalVolume: 12000.75,
    waterBodyIdentifier: '00042',
    isWaterBodyConnectedToStream: true,
    isWaterBodyConnectedToGroundwater: false
  }, async point => {
    const updated = await updatePointPrelevement(point.id, {nature: 'COURS_EAU'}, {user: admin})
    t.like(updated, {
      nature: 'COURS_EAU',
      reservoirNominalVolume: null,
      waterBodyIdentifier: null,
      isWaterBodyConnectedToStream: null,
      isWaterBodyConnectedToGroundwater: null
    })
    const restoredOrigin = await updatePointPrelevement(point.id, {nature: 'PLAN_EAU'}, {user: admin})
    t.like(restoredOrigin, {reservoirNominalVolume: null, waterBodyIdentifier: null})
  })
})

integration('un patch sans origine ne renseigne pas les caractéristiques sur un autre type de point', async t => {
  await withPoint({nature: 'NAPPE'}, async point => {
    const volume = await updatePointPrelevement(point.id, {reservoirNominalVolume: 12000.75}, {user: admin})
    t.is(volume.reservoirNominalVolume, null)
    const identifier = await updatePointPrelevement(point.id, {waterBodyIdentifier: '00042'}, {user: admin})
    t.is(identifier.waterBodyIdentifier, null)
  })
})
