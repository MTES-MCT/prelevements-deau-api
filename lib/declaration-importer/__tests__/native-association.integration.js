import process from 'node:process'
import {randomBytes, randomInt} from 'node:crypto'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {ingestDeclarationSeries} from '../importer.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
const logger = {log() {}, warn() {}, error() {}}
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

async function fixture(run) {
  const rollback = new Error('ROLLBACK_NATIVE_ASSOCIATION')
  try {
    await prisma.$transaction(async client => {
      const owner = await client.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT'}}}})
      const usage = await client.sandreWaterUse.findUniqueOrThrow({where: {code: '2'}})
      const point = await client.pointPrelevement.create({data: {name: 'Point camion synthétique', sourceId: `reunion:DEP-974:point:${randomInt(100000, 999999999)}`,
        waterBodyType: 'SUPERFICIELLE', flowType: 'PRELEVEMENT'}})
      const exploitation = await client.declarantPointPrelevement.create({data: {declarantUserId: owner.id, pointPrelevementId: point.id, usageId: usage.id}})
      const createDeclaration = (declarantUserId = owner.id) => client.declaration.create({data: {code: randomBytes(3).toString('hex'), type: 'reunion_camion_citerne',
        declarantUserId, waterWithdrawalType: 'unknown', dataSourceType: 'SPREADSHEET'}})
      const declaration = await createDeclaration()
      const series = {nativeTemporal: true, seriesKey: 'file:volumes:point', pointPrelevement: point.sourceId,
        parameter: 'volume', unit: 'm³', frequency: '1 day', valueType: 'cumulative', metadata: {timezone: 'Indian/Reunion'},
        data: [{date: '2026-01-01T20:00:00.000Z', periodStart: '2026-01-01T20:00:00.000Z', periodEnd: '2026-01-02T20:00:00.000Z',
          value: '12.12345678901234567890123456789', remark: 'Valeur synthétique', metadata: {row: 4, cell: 'B4'}}]}
      const ingest = (item = series, {declarationId = declaration.id, batch} = {}) => ingestDeclarationSeries({declarationId,
        data: {nativeTemporal: true, conflictPolicy: 'SKIP_NEW_CHUNK', series: Array.isArray(item) ? item : [item], ...(batch ? {batch} : {})},
        processingMetadata: {provenance: 'DN', historicalAccepted: true}, logger, client})
      const get = (declarationId = declaration.id) => client.source.findUnique({where: {declarationId}, include: {chunks: {orderBy: {seriesKey: 'asc'}, include: {chunkValues: {orderBy: {id: 'asc'}}}}}})
      await run({client, owner, usage, point, exploitation, declaration, series, ingest, get, createDeclaration})
      throw rollback
    }, {timeout: 30000})
  } catch (error) { if (error !== rollback) throw error }
}

integration('référence PP absente : les valeurs exactes restent conservées sans association inventée', async t => {
  await fixture(async ({client, point, series, ingest, get}) => {
    await client.pointPrelevement.update({where: {id: point.id}, data: {sourceId: null}})
    await ingest()
    const source = await get(), chunk = source.chunks[0]
    t.is(chunk.pointPrelevementId, null)
    t.is(chunk.exploitationId, null)
    t.is(chunk.instructionStatus, 'PENDING')
    t.true(source.metadata.parsingErrors.some(issue => issue.code === 'UNMATCHED_POINT'))
    t.is(chunk.chunkValues.length, 1)
    t.is(chunk.chunkValues[0].value.toString(), series.data[0].value)
    t.is(await client.declarantPointPrelevement.count({where: {pointPrelevementId: point.id}}), 1)
  })
})

for (const [scenario, code] of [['absente', 'EXPLOITATION_NOT_FOUND'], ['partielle', 'EXPLOITATION_PERIOD_NOT_COVERED'], ['ambiguë', 'EXPLOITATION_AMBIGUOUS']]) {
  integration(`PP identifié avec exploitation ${scenario} : association du PP sans inventer ni étendre une exploitation`, async t => {
    await fixture(async ({client, owner, usage, point, exploitation, series, ingest, get}) => {
      series.data.push({...series.data[0], date: '2026-01-02T20:00:00.000Z', periodStart: '2026-01-02T20:00:00.000Z', periodEnd: '2026-01-03T20:00:00.000Z'})
      if (scenario === 'absente') await client.declarantPointPrelevement.delete({where: {id: exploitation.id}})
      if (scenario === 'partielle') await client.declarantPointPrelevement.update({where: {id: exploitation.id}, data: {endDate: new Date('2026-01-02')}})
      if (scenario === 'ambiguë') {
        await client.declarantPointPrelevement.update({where: {id: exploitation.id}, data: {countingCode: 'SYNTHETIC_A'}})
        await client.declarantPointPrelevement.create({data: {declarantUserId: owner.id, pointPrelevementId: point.id, usageId: usage.id, countingCode: 'SYNTHETIC_B'}})
      }
      const identities = () => client.declarantPointPrelevement.findMany({where: {pointPrelevementId: point.id}, orderBy: {id: 'asc'},
        select: {id: true, declarantUserId: true, pointPrelevementId: true, startDate: true, endDate: true, usageId: true, countingCode: true}})
      const before = await identities()
      await ingest()
      const source = await get(), chunk = source.chunks[0]
      t.is(chunk.pointPrelevementId, point.id)
      t.is(chunk.exploitationId, null)
      t.is(chunk.preleveurUserId, owner.id)
      t.is(chunk.instructionStatus, 'PENDING')
      t.is(chunk.flowType, point.flowType)
      t.is(chunk.chunkValues.length, 2)
      t.is(chunk.chunkValues[0].value.toString(), series.data[0].value)
      t.true(chunk.parsingInfo.issues.some(issue => issue.code === code))
      t.true(source.metadata.parsingErrors.some(issue => issue.code === code))
      t.false(source.metadata.parsingErrors.some(issue => issue.code === 'UNMATCHED_POINT'))
      t.deepEqual(await identities(), before)
    })
  })
}

integration('PP partagé : chaque préleveur garde ses volumes et seul son propre recouvrement est rejeté', async t => {
  await fixture(async ({client, point, owner, usage, series, ingest, get, createDeclaration}) => {
    await ingest()
    const first = await get()
    const otherOwner = await client.user.create({data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT'}}}})
    const otherExploitation = await client.declarantPointPrelevement.create({data: {declarantUserId: otherOwner.id, pointPrelevementId: point.id, usageId: usage.id}})
    const otherDeclaration = await createDeclaration(otherOwner.id)
    await ingest(series, {declarationId: otherDeclaration.id})
    const other = (await get(otherDeclaration.id)).chunks[0]
    t.is(other.pointPrelevementId, point.id)
    t.is(other.exploitationId, otherExploitation.id)
    t.is(other.preleveurUserId, otherOwner.id)
    t.is(other.instructionStatus, 'VALIDATED')
    const duplicateDeclaration = await createDeclaration(owner.id)
    await ingest(series, {declarationId: duplicateDeclaration.id})
    const duplicate = await get(duplicateDeclaration.id)
    t.is(duplicate.chunks[0].instructionStatus, 'REJECTED')
    t.true(duplicate.metadata.parsingErrors.some(issue => issue.code === 'OVERLAPPING_SERIES'))
    t.deepEqual((await get()).chunks[0].chunkValues, first.chunks[0].chunkValues)
    t.is((await get()).chunks[0].instructionStatus, 'VALIDATED')
  })
})

for (const batched of [false, true]) {
  integration(`rejeu ${batched ? 'du même reçu de lot' : 'de la même révision'} : rapprochement réparé sans réécrire les valeurs`, async t => {
    await fixture(async ({client, point, exploitation, series, ingest, get}) => {
      const options = batched ? {batch: {id: 'synthetic-association-replay', index: 0, total: 1}} : {}
      await client.pointPrelevement.update({where: {id: point.id}, data: {sourceId: null}})
      await ingest(series, options)
      const before = await get(), old = before.chunks[0]
      t.is(old.pointPrelevementId, null)
      await client.pointPrelevement.update({where: {id: point.id}, data: {sourceId: point.sourceId}})
      await ingest(series, options)
      const after = await get(), repaired = after.chunks[0]
      t.is(repaired.id, old.id)
      t.is(repaired.contentHash, old.contentHash)
      t.is(repaired.pointPrelevementId, point.id)
      t.is(repaired.exploitationId, exploitation.id)
      t.is(repaired.instructionStatus, 'VALIDATED')
      t.deepEqual(repaired.chunkValues, old.chunkValues)
      t.deepEqual(repaired.metadata.importHistory, old.metadata.importHistory)
      t.false(after.metadata.parsingErrors.some(issue => issue.code === 'UNMATCHED_POINT'))
      t.is(await client.chunkValueReplacement.count({where: {replacedChunkId: old.id}}), 0)
      if (batched) t.deepEqual(after.metadata.nativeBatch, before.metadata.nativeBatch)
      await ingest(series, options)
      t.deepEqual((await get()).chunks[0].chunkValues, old.chunkValues)
      t.is(await client.chunkValueReplacement.count({where: {replacedChunkId: old.id}}), 0)
    })
  })

  integration(`rejeu ${batched ? 'du lot' : 'simple'} : les comptes complets des erreurs de cellules sont conservés`, async t => {
    await fixture(async ({client, point, series, ingest, get}) => {
      const options = batched ? {batch: {id: 'synthetic-association-diagnostics', index: 0, total: 1}} : {}
      series.data.push(...Array.from({length: 150}, (_, row) => ({...series.data[0], value: 'illisible', metadata: {row: row + 5}})))
      await client.pointPrelevement.update({where: {id: point.id}, data: {sourceId: null}})
      await ingest(series, options)
      const before = await get()
      t.is(before.chunks[0].parsingInfo.issueCounts.byCode.INVALID_VALUE, 150)
      t.is(before.metadata.parsingErrorCounts.byCode.INVALID_VALUE, 150)
      await client.pointPrelevement.update({where: {id: point.id}, data: {sourceId: point.sourceId}})
      await ingest(series, options)
      const after = await get(), chunk = after.chunks[0]
      t.is(chunk.pointPrelevementId, point.id)
      t.is(chunk.parsingInfo.issueCounts.total, 150)
      t.deepEqual(chunk.parsingInfo.issueCounts.byCode, {INVALID_VALUE: 150})
      t.deepEqual(chunk.parsingInfo.issueCounts.bySeverity, {error: 150})
      t.true(chunk.parsingInfo.issuesSampled)
      t.is(after.metadata.parsingErrorCounts.total, 150)
      t.deepEqual(after.metadata.parsingErrorCounts.byCode, {INVALID_VALUE: 150})
      t.deepEqual(after.metadata.parsingErrorCounts.bySeverity, {error: 150})
      t.true(after.metadata.parsingErrorsSampled)
      t.false(after.metadata.parsingErrors.some(issue => issue.code === 'UNMATCHED_POINT'))
      t.deepEqual(chunk.chunkValues, before.chunks[0].chunkValues)
    })
  })
}

integration('deux séries sans exploitation sur le même PP et préleveur ne comptent pas deux fois la même période', async t => {
  await fixture(async ({client, point, exploitation, series, ingest, get, createDeclaration}) => {
    await client.declarantPointPrelevement.delete({where: {id: exploitation.id}})
    await ingest()
    const first = (await get()).chunks[0]
    t.is(first.pointPrelevementId, point.id)
    t.is(first.instructionStatus, 'PENDING')
    const duplicateDeclaration = await createDeclaration()
    await ingest(series, {declarationId: duplicateDeclaration.id})
    const duplicate = await get(duplicateDeclaration.id)
    t.is(duplicate.chunks[0].pointPrelevementId, point.id)
    t.is(duplicate.chunks[0].exploitationId, null)
    t.is(duplicate.chunks[0].instructionStatus, 'REJECTED')
    t.true(duplicate.metadata.parsingErrors.some(issue => issue.code === 'OVERLAPPING_SERIES'))
    t.is((await get()).chunks[0].instructionStatus, 'PENDING')
    t.deepEqual((await get()).chunks[0].chunkValues, first.chunkValues)
  })
})

integration('rejeu du lot : un recouvrement désormais identifié est rejeté et l’activité revient au dernier dossier retenu', async t => {
  await fixture(async ({client, owner, point, declaration, series, ingest, get, createDeclaration}) => {
    const retainedAt = new Date('2026-01-10T00:00:00.000Z')
    await client.declaration.update({where: {id: declaration.id}, data: {createdAt: retainedAt}})
    await ingest()
    await client.pointPrelevement.update({where: {id: point.id}, data: {sourceId: null}})
    const duplicateDeclaration = await createDeclaration()
    const duplicateAt = new Date('2026-02-10T00:00:00.000Z')
    await client.declaration.update({where: {id: duplicateDeclaration.id}, data: {createdAt: duplicateAt}})
    const options = {declarationId: duplicateDeclaration.id, batch: {id: 'synthetic-conflict-replay', index: 0, total: 1}}
    await ingest(series, options)
    const before = (await get(duplicateDeclaration.id)).chunks[0]
    t.is(before.instructionStatus, 'PENDING')
    t.deepEqual((await client.declarant.findUnique({where: {userId: owner.id}})).lastDeclarationAt, duplicateAt)
    await client.pointPrelevement.update({where: {id: point.id}, data: {sourceId: point.sourceId}})
    await ingest(series, options)
    const after = (await get(duplicateDeclaration.id)).chunks[0]
    t.is(after.pointPrelevementId, point.id)
    t.is(after.instructionStatus, 'REJECTED')
    t.deepEqual(after.chunkValues, before.chunkValues)
    t.deepEqual((await client.declarant.findUnique({where: {userId: owner.id}})).lastDeclarationAt, retainedAt)
  })
})

integration('réimport modifié : rapprochement réparé et ancienne valeur exacte archivée', async t => {
  await fixture(async ({client, point, series, ingest, get}) => {
    await client.pointPrelevement.update({where: {id: point.id}, data: {sourceId: null}})
    await ingest()
    const before = (await get()).chunks[0]
    await client.pointPrelevement.update({where: {id: point.id}, data: {sourceId: point.sourceId}})
    const modified = structuredClone(series)
    modified.data[0].value = '13.98765432109876543210987654321'
    await ingest(modified)
    const after = (await get()).chunks[0]
    const archived = await client.chunkValueReplacement.findMany({where: {replacedChunkId: before.id}})
    t.is(after.id, before.id)
    t.is(after.pointPrelevementId, point.id)
    t.is(after.instructionStatus, 'VALIDATED')
    t.is(after.chunkValues[0].value.toString(), modified.data[0].value)
    t.not(after.chunkValues[0].id, before.chunkValues[0].id)
    t.is(archived.length, 1)
    t.is(archived[0].value.toString(), series.data[0].value)
    t.is(archived[0].replacedChunkValueId, before.chunkValues[0].id)
    t.is(archived[0].conflictPolicy, 'NATIVE_REIMPORT')
  })
})

integration('deux séries déplacées ensemble ne se heurtent pas aux anciennes périodes remplacées', async t => {
  await fixture(async ({client, series, ingest, get}) => {
    const first = {...structuredClone(series), seriesKey: 'first'}
    const second = {...structuredClone(series), seriesKey: 'second'}
    second.data[0] = {...second.data[0], date: '2026-01-03T20:00:00.000Z', periodStart: '2026-01-03T20:00:00.000Z', periodEnd: '2026-01-04T20:00:00.000Z', value: '25'}
    await ingest([first, second])
    const before = await get()
    first.data[0] = {...first.data[0], date: second.data[0].date, periodStart: second.data[0].periodStart, periodEnd: second.data[0].periodEnd}
    second.data[0] = {...second.data[0], date: '2026-01-05T20:00:00.000Z', periodStart: '2026-01-05T20:00:00.000Z', periodEnd: '2026-01-06T20:00:00.000Z'}
    await ingest([first, second])
    const after = await get()
    t.true(after.chunks.every(chunk => chunk.instructionStatus === 'VALIDATED'))
    t.false(after.metadata.parsingErrors.some(issue => issue.code === 'OVERLAPPING_SERIES'))
    t.deepEqual(after.chunks.map(chunk => chunk.id), before.chunks.map(chunk => chunk.id))
    const replacements = await client.chunkValueReplacement.findMany({where: {replacedChunkId: {in: before.chunks.map(chunk => chunk.id)}}})
    for (const chunk of before.chunks) {
      const archived = replacements.filter(value => value.replacedChunkId === chunk.id)
      t.is(archived.length, 1)
      t.is(archived[0].value.toString(), chunk.chunkValues[0].value.toString())
      t.deepEqual(archived[0].periodStart, chunk.chunkValues[0].periodStart)
      t.deepEqual(archived[0].periodEnd, chunk.chunkValues[0].periodEnd)
    }
  })
})

integration('rejeu identique : une décision explicite existante n’est pas validée de nouveau', async t => {
  await fixture(async ({client, ingest, get}) => {
    await ingest()
    const original = (await get()).chunks[0]
    await client.chunk.update({where: {id: original.id}, data: {instructionStatus: 'REJECTED', instructedAt: new Date('2026-10-01'), instructionComment: 'Décision synthétique conservée'}})
    const before = (await get()).chunks[0]
    await ingest()
    const after = (await get()).chunks[0]
    t.is(after.instructionStatus, 'REJECTED')
    t.deepEqual(after.instructedAt, before.instructedAt)
    t.is(after.instructionComment, before.instructionComment)
    t.deepEqual(after.chunkValues, before.chunkValues)
  })
})
