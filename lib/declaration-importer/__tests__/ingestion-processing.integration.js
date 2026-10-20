import process from 'node:process'
import {randomBytes, randomUUID} from 'node:crypto'
import {performance} from 'node:perf_hooks'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {
  markDeclarationIngestionProcessingFailed,
  markDeclarationProcessingStarted
} from '../../services/declaration-processing.js'
import {
  ingestDeclarationSeries,
  prepareDeclarationSourceForIngestion
} from '../importer.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
const logger = {log() {}, warn() {}, error() {}}
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => {
  await prisma.$disconnect()
  await globalThis.pgPool?.end()
})

async function withFixture(run) {
  const owner = await prisma.user.create({
    data: {role: 'DECLARANT', declarant: {create: {preleveurType: 'IRRIGANT'}}}
  })
  try {
    const usage = await prisma.sandreWaterUse.findUniqueOrThrow({where: {code: '2'}})
    const declaration = await prisma.declaration.create({
      data: {
        code: randomBytes(3).toString('hex'),
        declarantUserId: owner.id,
        type: 'aquasys',
        waterWithdrawalType: 'unknown',
        dataSourceType: 'SPREADSHEET',
        processingStatus: 'PROCESSING',
        processingStartedAt: new Date('2026-10-20T08:00:00Z'),
        source: {
          create: {
            type: 'DECLARATION',
            status: 'PENDING',
            metadata: {original: true},
            chunks: {
              create: {
                usageId: usage.id,
                pointPrelevementName: 'Point synthétique avant rejeu',
                minDate: new Date('2026-01-01'),
                maxDate: new Date('2026-01-02'),
                chunkValues: {
                  create: {
                    metricTypeCode: 'volume',
                    frequency: '1 day',
                    unit: 'm³',
                    periodStart: new Date('2026-01-01'),
                    periodEnd: new Date('2026-01-02'),
                    value: 42
                  }
                }
              }
            }
          }
        }
      },
      include: {files: true, source: {include: {chunks: {include: {chunkValues: true}}}}}
    })
    await run({declaration, usageId: usage.id})
  } finally {
    await prisma.chunk.deleteMany({where: {source: {declaration: {declarantUserId: owner.id}}}})
    await prisma.user.delete({where: {id: owner.id}})
  }
}

function withPreparationTransaction(run) {
  return withOverrides(prisma, {
    $transaction(callback, options) {
      return prisma.$transaction(async tx => {
        if (options?.timeout === 30_000) return run(tx, callback)
        return callback(tx)
      }, options)
    }
  })
}

function withOverrides(client, overrides) {
  return new Proxy(client, {
    get(target, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key]
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

function payload(usageId) {
  return {
    conflictPolicy: 'REPLACE_EXISTING',
    series: [{
      pointPrelevement: `Point synthétique sans correspondance ${randomBytes(8).toString('hex')}`,
      parameter: 'volume',
      unit: 'm³',
      frequency: '1 day',
      usageId,
      minDate: '2026-01-01',
      maxDate: '2026-01-01',
      data: [{
        date: '2026-01-01',
        periodStart: '2026-01-01T00:00:00Z',
        periodEnd: '2026-01-02T00:00:00Z',
        value: 55
      }]
    }]
  }
}

integration('la préparation accepte un traitement supérieur à cinq secondes sans modifier le délai global', async t => {
  await withFixture(async ({declaration}) => {
    const client = withPreparationTransaction(async (tx, callback) => {
      await tx.$executeRaw`SELECT pg_sleep(5.2)`
      return callback(tx)
    })
    const startedAt = performance.now()
    const source = await prepareDeclarationSourceForIngestion({declaration, client})
    t.true(performance.now() - startedAt >= 5000)
    t.is(source.status, 'PROCESSING')
    t.is(await prisma.chunk.count({where: {sourceId: source.id}}), 0)
    t.is((await prisma.source.findUnique({where: {id: source.id}})).status, 'PROCESSING')
  })
})

integration('un rollback de préparation conserve les valeurs et persiste les deux statuts en échec', async t => {
  await withFixture(async ({declaration, usageId}) => {
    const originalError = new Error('Synthetic preparation rollback')
    const client = withPreparationTransaction(async (tx, callback) => {
      await callback(tx)
      throw originalError
    })
    const error = await t.throwsAsync(ingestDeclarationSeries({
      declarationId: declaration.id,
      data: payload(usageId),
      client,
      logger
    }))
    t.is(error, originalError)
    const actual = await prisma.declaration.findUnique({
      where: {id: declaration.id},
      include: {processingEvents: true, source: {include: {chunks: {include: {chunkValues: true}}}}}
    })
    t.is(actual.processingStatus, 'FAILED')
    t.is(actual.source.status, 'FAILED')
    t.is(actual.source.metadata.processingError, originalError.message)
    t.deepEqual(actual.source.chunks, declaration.source.chunks)
    t.is(actual.processingEvents.length, 1)
    t.is(actual.processingEvents[0].status, 'FAILED')
  })
})

integration('la reprise après échec reste rejouable sans doubler les valeurs', async t => {
  await withFixture(async ({declaration, usageId}) => {
    await markDeclarationIngestionProcessingFailed({
      declarationId: declaration.id,
      expectedProcessingStartedAt: declaration.processingStartedAt,
      error: new Error('Previous failed attempt')
    })
    const data = payload(usageId)
    await markDeclarationProcessingStarted({declarationId: declaration.id})
    await ingestDeclarationSeries({declarationId: declaration.id, data, logger})
    const first = await prisma.chunkValue.findMany({where: {chunk: {sourceId: declaration.source.id}}})
    await markDeclarationProcessingStarted({declarationId: declaration.id})
    await ingestDeclarationSeries({declarationId: declaration.id, data, logger})
    const second = await prisma.chunkValue.findMany({where: {chunk: {sourceId: declaration.source.id}}})
    t.is(first.length, 1)
    t.is(second.length, 1)
    t.is(Number(second[0].value), 55)
    const actual = await prisma.declaration.findUnique({
      where: {id: declaration.id}, include: {source: true}
    })
    t.is(actual.processingStatus, 'COMPLETED')
    t.is(actual.processingError, null)
    t.is(actual.source.status, 'COMPLETED')
    t.falsy(actual.source.metadata.processingError)
  })
})

integration('un ancien échec ne remplace ni une tentative plus récente ni un succès', async t => {
  await withFixture(async ({declaration}) => {
    await prisma.declaration.update({
      where: {id: declaration.id},
      data: {processingStatus: 'QUEUED', processingQueuedAt: new Date()}
    })
    t.false((await markDeclarationIngestionProcessingFailed({
      declarationId: declaration.id,
      expectedProcessingStartedAt: declaration.processingStartedAt,
      expectedProcessingQueuedAt: declaration.processingQueuedAt,
      error: new Error('Error from previous queued attempt')
    })).recorded)
    await markDeclarationProcessingStarted({declarationId: declaration.id})
    t.false((await markDeclarationIngestionProcessingFailed({
      declarationId: declaration.id,
      expectedProcessingStartedAt: declaration.processingStartedAt,
      error: new Error('Stale error')
    })).recorded)
    const current = await prisma.declaration.update({
      where: {id: declaration.id},
      data: {processingStatus: 'COMPLETED'}
    })
    t.false((await markDeclarationIngestionProcessingFailed({
      declarationId: declaration.id,
      expectedProcessingStartedAt: current.processingStartedAt,
      expectedProcessingQueuedAt: current.processingQueuedAt,
      error: new Error('Late error')
    })).recorded)
    t.is((await prisma.declaration.findUnique({where: {id: declaration.id}})).processingStatus, 'COMPLETED')
  })
})

integration('un échec de finalisation laisse la déclaration et la source en échec', async t => {
  await withFixture(async ({declaration, usageId}) => {
    const originalError = new Error('Synthetic completion failure')
    const client = withOverrides(prisma, {
      $transaction(callback, options) {
        return prisma.$transaction(tx => callback(withOverrides(tx, {
          declaration: withOverrides(tx.declaration, {
            update(query) {
              if (query.data.processingStatus === 'COMPLETED') throw originalError
              return tx.declaration.update(query)
            }
          })
        })), options)
      }
    })
    t.is(await t.throwsAsync(ingestDeclarationSeries({
      declarationId: declaration.id,
      data: payload(usageId),
      client,
      logger
    })), originalError)
    const actual = await prisma.declaration.findUnique({
      where: {id: declaration.id}, include: {source: true}
    })
    t.is(actual.processingStatus, 'FAILED')
    t.is(actual.source.status, 'FAILED')
    t.is(actual.processingError, originalError.message)
  })
})

integration('un échec secondaire après finalisation ne provoque ni échec ni nouvel import', async t => {
  await withFixture(async ({declaration, usageId}) => {
    const logged = []
    const client = withOverrides(prisma, {
      chunk: withOverrides(prisma.chunk, {
        findMany(query) {
          if (query.select?.pointPrelevementId) return [{pointPrelevementId: randomUUID()}]
          return prisma.chunk.findMany(query)
        }
      }),
      declarantPointPrelevement: withOverrides(prisma.declarantPointPrelevement, {
        findMany(query) {
          if (query.select?.pointPrelevementId && Object.keys(query.select).length === 2) {
            throw new Error('Synthetic available dates failure')
          }
          return prisma.declarantPointPrelevement.findMany(query)
        }
      })
    })
    const result = await ingestDeclarationSeries({
      declarationId: declaration.id,
      data: payload(usageId),
      client,
      logger: {...logger, error: (...args) => logged.push(args)}
    })
    t.true(result.imported)
    t.is(logged.length, 1)
    t.is(logged[0][1].phase, 'available-dates')
    const actual = await prisma.declaration.findUnique({
      where: {id: declaration.id}, include: {source: true, processingEvents: true}
    })
    t.is(actual.processingStatus, 'COMPLETED')
    t.is(actual.source.status, 'COMPLETED')
    t.false(actual.processingEvents.some(event => event.status === 'FAILED'))
    t.is(await prisma.chunkValue.count({where: {chunk: {sourceId: actual.source.id}}}), 1)
  })
})
