import process from 'node:process'
import {Buffer} from 'node:buffer'
import {randomUUID, createHash} from 'node:crypto'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {externalRecordScope, externalCandidates, publicExternalRecord, materializeExternalDeclaration} from '../external-declarations.js'
import {listSeries} from '../../models/series.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

async function createZone(client) {
  const id = randomUUID()
  await client.$executeRaw`INSERT INTO "Zone" (id,code,type,name,coordinates,"createdAt","updatedAt")
    VALUES (${id}::uuid, ${id}, 'SAGE', 'Zone synthétique dossiers',
      ST_Multi(ST_GeomFromText('POLYGON((0 0,0 1,1 1,1 0,0 0))',4326)), CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`
  return id
}

async function fixture(run) {
  const rollback = new Error('ROLLBACK_EXTERNAL_RECORD_TEST')
  try {
    await prisma.$transaction(async tx => {
      let savepointNumber = 0
      // Expose transactional service semantics inside one invisible, rollback-only fixture.
      const client = new Proxy(tx, {get(target, property) {
        if (property !== '$transaction') return Reflect.get(target, property)
        return async callback => {
          const name = `external_part_${++savepointNumber}`
          await tx.$executeRawUnsafe(`SAVEPOINT ${name}`)
          try {
            const result = await callback(tx)
            await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`)
            return result
          } catch (error) {
            await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`)
            throw error
          }
        }
      }})
      const zoneId = await createZone(tx)
      const makeUser = (declarantRole = 'PRELEVEUR') => tx.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: declarantRole === 'PRELEVEUR' ? 'GESTIONNAIRE_AEP' : null, declarantRole}}}})
      const owner = await makeUser(), other = await makeUser(), outsider = await makeUser(), collector = await makeUser('COLLECTEUR')
      await tx.declarantZone.createMany({data: [owner, other, collector].map(user => ({zoneId, declarantUserId: user.id, source: 'MIGRATION'}))})
      const usage = await tx.sandreWaterUse.findUniqueOrThrow({where: {code: '2'}})
      const point = await tx.pointPrelevement.create({data: {name: 'Point synthétique historique', sourceId: `reunion:staging:${randomUUID()}`, waterBodyType: 'SOUTERRAIN', flowType: 'PRELEVEMENT'}})
      await tx.declarantPointPrelevement.create({data: {declarantUserId: owner.id, pointPrelevementId: point.id, usageId: usage.id}})
      const series = (key = 'native-series', day = 1) => ({nativeTemporal: true, seriesKey: key, pointPrelevement: point.sourceId,
        parameter: 'température', unit: 'degrés Celsius', frequency: 'instant', valueType: 'instantaneous', metadata: {timezone: 'Indian/Reunion'},
        data: [{date: `2026-01-0${day}T20:00:00.123Z`, periodStart: `2026-01-0${day}T20:00:00.123Z`, periodEnd: `2026-01-0${day}T20:00:00.123Z`, value: '12.123456789012345', remark: 'Observation originale', metadata: {row: 13, cell: 'C13'}}]})
      const key = randomUUID()
      const files = [{filename: 'original.xlsx', storageKey: `synthetic/${key}/original.xlsx`, type: 'data', checksum: 'a'.repeat(64), available: true},
        {filename: 'annexe.pdf', storageKey: `synthetic/${key}/annexe.pdf`, type: 'attachment', checksum: 'b'.repeat(64), available: true},
        {filename: 'indisponible.xlsx', checksum: 'c'.repeat(64), available: false}]
      const record = await tx.externalDeclarationRecord.create({data: {provider: 'DN', externalId: `synthetic-${key}`, zoneId, sourceStatus: 'accepte', sourceHash: 'd'.repeat(64), files,
        payload: {declarantName: 'Préleveur synthétique', type: 'reunion_multi_param', dateDepot: '2020-06-17T10:42:18.000Z',
          dateTraitement: '2020-06-19T07:11:10.000Z', aotDecreeNumber: 'ARRETE-SYNTHETIQUE', waterWithdrawalType: 'groundwater', comment: 'Commentaire original',
          privateDetails: 'non public', parsedData: {nativeTemporal: true, series: [series()]}}}})
      const materialize = (options = {}) => materializeExternalDeclaration({recordId: record.id, declarantUserId: owner.id, client, ...options})
      await run({client, owner, other, outsider, collector, zoneId, point, record, series, files, materialize})
      throw rollback
    }, {timeout: 30000})
  } catch (error) { if (error !== rollback) throw error }
}

integration('staging : candidats territoriaux, affectation unique, originaux et date historique conservés au rejeu', async t => {
  await fixture(async ({client, owner, other, outsider, collector, zoneId, record, files, materialize}) => {
    const candidates = await externalCandidates(zoneId, client)
    t.deepEqual(candidates.map(candidate => candidate.id).sort(), [owner.id, other.id].sort())
    t.false(candidates.some(candidate => candidate.id === collector.id))
    t.is((await t.throwsAsync(() => materialize({declarantUserId: outsider.id}))).status, 403)
    t.is((await client.externalDeclarationRecord.findUnique({where: {id: record.id}})).declarationId, null)
    const first = await materialize()
    const declaration = await client.declaration.findUnique({where: {id: first.declarationId}, include: {files: true, source: {include: {chunks: {include: {chunkValues: true}}}}}})
    t.is(declaration.createdAt.toISOString(), record.payload.dateDepot)
    t.like(declaration, {declarantUserId: owner.id, importSourceId: `reunion:DN:${record.externalId}`, comment: 'Commentaire original', aotDecreeNumber: 'ARRETE-SYNTHETIQUE', waterWithdrawalType: 'groundwater'})
    t.deepEqual(declaration.files.map(file => file.storageKey).sort(), files.filter(file => file.available).map(file => file.storageKey).sort())
    t.like(declaration.source.metadata, {provenance: 'DN', historicalAccepted: true, historicalDecisionAt: record.payload.dateTraitement})
    t.is(declaration.source.chunks[0].instructionStatus, 'VALIDATED')
    t.is(declaration.source.chunks[0].chunkValues[0].value.toString(), '12.123456789012345')
    t.is(declaration.source.chunks[0].chunkValues[0].remark, 'Observation originale')
    t.deepEqual(await materialize(), first)
    const after = await client.declaration.findUnique({where: {id: first.declarationId}, include: {files: true, source: {include: {chunks: {include: {chunkValues: true}}}}}})
    t.is(after.files.length, 2)
    t.is(after.source.chunks[0].chunkValues[0].id, declaration.source.chunks[0].chunkValues[0].id)
    t.is((await t.throwsAsync(() => materialize({declarantUserId: other.id}))).status, 409)
    t.is((await client.externalDeclarationRecord.findUnique({where: {id: record.id}})).materializationStatus, 'COMPLETED')
  })
})

integration('staging : un échec de normalisation annule ensemble affectation, déclaration et pièces', async t => {
  await fixture(async ({client, record, files, series, materialize}) => {
    const invalid = series(); delete invalid.seriesKey
    await client.externalDeclarationRecord.update({where: {id: record.id}, data: {payload: {...record.payload, parsedData: {nativeTemporal: true, series: [invalid]}}}})
    t.is((await t.throwsAsync(() => materialize())).status, 400)
    const after = await client.externalDeclarationRecord.findUnique({where: {id: record.id}})
    t.is(after.declarationId, null)
    t.is(after.materializationStatus, 'UNASSIGNED')
    t.is(await client.declaration.count({where: {importSourceId: `reunion:DN:${record.externalId}`}}), 0)
    t.is(await client.declarationFile.count({where: {storageKey: {in: files.filter(file => file.available).map(file => file.storageKey)}}}), 0)
  })
})

integration('staging : date de dépôt invalide refusée sans créer de déclaration contemporaine', async t => {
  await fixture(async ({client, record, materialize}) => {
    await client.externalDeclarationRecord.update({where: {id: record.id}, data: {payload: {...record.payload, dateDepot: 'invalide'}}})
    t.is((await t.throwsAsync(() => materialize())).status, 409)
    t.is(await client.declaration.count({where: {importSourceId: `reunion:DN:${record.externalId}`}}), 0)
  })
})

integration('staging : les pièces préparées reprennent après une panne sans publier un dossier partiel', async t => {
  await fixture(async ({client, record, point, series, materialize}) => {
    const firstBytes = Buffer.from(JSON.stringify({data: {nativeTemporal: true, series: [series('first')]}, errors: []}))
    const secondBytes = Buffer.from(JSON.stringify({data: {nativeTemporal: true, series: [series('second', 4)]}, errors: []}))
    const parsedFiles = [firstBytes, secondBytes].map((bytes, index) => ({storageKey: `synthetic/part-${index}.json`, checksum: createHash('sha256').update(bytes).digest('hex')}))
    await client.externalDeclarationRecord.update({where: {id: record.id}, data: {payload: {...record.payload, parsedFiles}}})
    let fail = true
    const storage = {async downloadObject(key) {
      if (key === parsedFiles[0].storageKey) return firstBytes
      if (fail) throw new Error('Panne synthétique de stockage')
      return secondBytes
    }}
    await t.throwsAsync(() => materialize({storage}), {message: 'Panne synthétique de stockage'})
    const failed = await client.externalDeclarationRecord.findUnique({where: {id: record.id}})
    t.is(failed.materializationStatus, 'FAILED')
    t.truthy(failed.declarationId)
    t.is((await client.declarationFile.count({where: {declarationId: failed.declarationId}})), 2)
    const partial = await client.source.findUnique({where: {declarationId: failed.declarationId}, include: {chunks: {include: {chunkValues: true}}}})
    t.is(partial.status, 'FAILED')
    t.is(partial.metadata.nativeBatch.nextIndex, 1)
    t.is(partial.chunks.length, 1)
    t.deepEqual(await listSeries({pointIds: [point.id]}, {client}), [])
    fail = false
    const result = await materialize({storage})
    t.is(result.declarationId, failed.declarationId)
    const completed = await client.source.findUnique({where: {id: result.sourceId}, include: {chunks: {include: {chunkValues: true}}}})
    t.is(completed.status, 'COMPLETED')
    t.is(completed.chunks.length, 2)
    t.is(completed.chunks.find(chunk => chunk.seriesKey === 'first').chunkValues[0].id, partial.chunks[0].chunkValues[0].id)
    t.is((await listSeries({pointIds: [point.id]}, {client})).length, 2)
    t.is((await client.externalDeclarationRecord.findUnique({where: {id: record.id}})).materializationStatus, 'COMPLETED')
  })
})

test('staging : sérialisation publique sans contenu préparé, chemin privé ou identité technique', t => {
  const record = publicExternalRecord({id: 'synthetic', provider: 'DN', externalId: 'synthetic',
    payload: {declarantName: 'Préleveur', type: 'reunion_multi_param', parsedData: {private: true}, token: 'not-a-real-token', privateDetails: 'non public'},
    files: [{filename: 'original.xlsx', available: true, checksum: 'abc', storageKey: 'private/original.xlsx', url: 'private-url'}]})
  t.deepEqual(record.payload, {declarantName: 'Préleveur', type: 'reunion_multi_param'})
  t.deepEqual(record.files, [{filename: 'original.xlsx', available: true, checksum: 'abc'}])
})

integration('staging : périmètre agent limité aux zones actives portant le droit demandé', async t => {
  let user
  const zoneIds = []
  try {
    user = await prisma.user.create({data: {role: 'INSTRUCTOR', instructor: {create: {}}}})
    const active = await createZone(prisma); zoneIds.push(active)
    const expired = await createZone(prisma); zoneIds.push(expired)
    const otherPermission = await createZone(prisma); zoneIds.push(otherPermission)
    await prisma.instructorZone.create({data: {instructorUserId: user.id, zoneId: active, startDate: new Date('2000-01-01'), permissions: {create: [{permission: 'declaration.detail.read'}, {permission: 'declaration.list'}]}}})
    await prisma.instructorZone.create({data: {instructorUserId: user.id, zoneId: expired, startDate: new Date('2000-01-01'), endDate: new Date('2001-01-01'), permissions: {create: [{permission: 'declaration.detail.read'}]}}})
    await prisma.instructorZone.create({data: {instructorUserId: user.id, zoneId: otherPermission, startDate: new Date('2000-01-01'), permissions: {create: [{permission: 'pp.list'}]}}})
    t.deepEqual(await externalRecordScope(user), {zoneId: {in: [active]}})
    t.deepEqual(await externalRecordScope(user, 'declaration.instruct'), {zoneId: {in: []}})
    t.deepEqual(await externalRecordScope({role: 'ADMIN'}), {})
    t.is((await t.throwsAsync(() => externalRecordScope({role: 'DECLARANT'}))).status, 403)
  } finally {
    if (user) await prisma.user.delete({where: {id: user.id}})
    await prisma.zone.deleteMany({where: {id: {in: zoneIds}}})
  }
})
