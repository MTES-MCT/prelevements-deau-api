/* eslint-disable no-await-in-loop */
import {createLogger} from '../util/logger.js'
import {prisma} from '../../db/prisma.js'
import * as Sentry from '@sentry/node'
import moment from 'moment'
import {randomUUID} from 'node:crypto'
import {computeGlobalInstructionStatus} from '../handlers/chunks.js'

async function createChunksFromData(data, sourceId, declarantUserId, autoValidationEnabled, logger) {
  let matchedPoints = 0
  let unmatchedPoints = 0
  let createdChunks = 0
  let createdValues = 0
  let sourceTotalWaterVolumeWithdrawn = 0
  let sourceTotalWaterVolumeDischarged = 0
  const chunkStatuses = []

  for (const chunk of data.series) {
    const pointPrelevementName = (chunk.pointPrelevement ?? '').trim().replaceAll(/\s+/g, ' ')
    const {
      unit,
      parameter,
      granularity,
      minDate,
      maxDate,
      pointId
    } = chunk

    logger.log([
      `Chunk: pointId="${pointId ?? 'n/a'}"`,
      `point="${pointPrelevementName || 'n/a'}"`,
      `metricTypeCode="${parameter}"`,
      `unit="${unit}"`,
      `granularity="${granularity}"`,
      `minDate=${minDate}`,
      `maxDate=${maxDate}`,
      `values=${chunk.data?.length ?? 0}`
    ].join(', '))

    const chunkStart = moment.utc(minDate).toDate()
    const chunkEnd = moment.utc(maxDate).toDate()

    /**
     * Identification du point de prélèvement associé
     *
     * Cas 1 : le point de prélèvement existe et le déclarant a un lien actif sur la période du chunk
     * Cas 2 : le point de prélèvement existe, une exploitation existe mais la période du chunk ne correspond pas
     * Cas 3 : le point de prélèvement existe, mais aucune exploitation n'existe pour le déclarant
     * Cas 4 : le point de prélèvement n'existe pas
     */

    const pointPrelevement = await resolvePointPrelevement(pointId, pointPrelevementName)

    let pointPrelevementId = null
    let parsingInfo = null

    if (pointPrelevement?.id) {
      const pointId = pointPrelevement.id

      const anyLink = await prisma.declarantPointPrelevement.findFirst({
        where: {
          declarantUserId,
          pointPrelevementId: pointId
        },
        select: {id: true}
      })

      // Cas 1 : y a-t-il un lien QUI OVERLAP la fenêtre du chunk ?
      const linkOnWindow = await prisma.declarantPointPrelevement.findFirst({
        where: {
          declarantUserId,
          pointPrelevementId: pointId,
          AND: [
            {OR: [{startDate: null}, {startDate: {lte: chunkEnd}}]},
            {OR: [{endDate: null}, {endDate: {gte: chunkStart}}]}
          ]
        },
        select: {id: true}
      })

      if (linkOnWindow?.id) {
        matchedPoints++
        pointPrelevementId = pointId
        parsingInfo = {
          case: 1,
          reason: 'POINT_FOUND_AND_LINK_ACTIVE_ON_WINDOW'
        }
        logger.log(
          `Point matché (lien déclarant OK sur période chunk): name="${pointPrelevementName}" -> id=${pointPrelevementId}`
        )
      } else if (anyLink?.id) {
        unmatchedPoints++
        parsingInfo = {
          case: 2,
          reason: 'POINT_FOUND_BUT_LINK_OUTSIDE_WINDOW',
          pointPrelevementName,
          pointPrelevementId: pointId,
          declarantUserId,
          otherExploitationId: anyLink.id,
          window: {from: chunkStart.toISOString(), to: chunkEnd.toISOString()},
          matchStrategy: 'PointPrelevement.name'
        }
        logger.warn(
          `Point trouvé mais lien déclarant hors période chunk: name="${pointPrelevementName}" -> id=${pointId}`
        )
      } else {
        unmatchedPoints++
        parsingInfo = {
          case: 3,
          reason: 'POINT_FOUND_BUT_NO_LINK_FOR_DECLARANT',
          pointPrelevementName,
          pointPrelevementId: pointId,
          declarantUserId,
          window: {from: chunkStart.toISOString(), to: chunkEnd.toISOString()},
          matchStrategy: 'PointPrelevement.name'
        }
        logger.warn(
          `Point trouvé mais aucun lien déclarant: name="${pointPrelevementName}" -> id=${pointId}, declarantUserId=${declarantUserId}`
        )
      }
    } else {
      unmatchedPoints++
      parsingInfo = {
        case: 4,
        reason: 'POINT_NOT_FOUND',
        pointPrelevementName,
        window: {from: chunkStart.toISOString(), to: chunkEnd.toISOString()}
      }
      logger.warn(`Point non trouvé: name="${pointPrelevementName}"`)
    }

    const totalWaterVolumeWithdrawn = computeTotalWaterVolume(chunk, 'volume_preleve')
    const totalWaterVolumeDischarged = computeTotalWaterVolume(chunk, 'volume_rejete')

    sourceTotalWaterVolumeWithdrawn += totalWaterVolumeWithdrawn
    sourceTotalWaterVolumeDischarged += totalWaterVolumeDischarged

    const isValidated = parsingInfo.case === 1 && autoValidationEnabled !== false
    const instructionStatus = isValidated ? 'VALIDATED' : 'PENDING'
    chunkStatuses.push(instructionStatus)

    const newChunk = await prisma.chunk.create({
      data: {
        id: randomUUID(),
        instructionStatus,
        sourceId,
        pointPrelevementName,
        pointPrelevementId,
        minDate: chunkStart,
        maxDate: chunkEnd,
        parsingInfo,
        metadata: {
          granularity,
          totalWaterVolumeWithdrawn,
          totalWaterVolumeDischarged
        }
      }
    })

    createdChunks++

    logger.log(
      `Chunk créé: id=${newChunk.id}, pointId=${newChunk.pointPrelevementId ?? 'null'}, parsingInfo=${parsingInfo?.reason ?? 'n/a'}`
    )

    const rows = chunk.data?.length ?? 0
    if (!rows) {
      logger.warn(`Chunk sans valeurs: chunkId=${newChunk.id}`)
      continue
    }

    await prisma.chunkValue.createMany({
      data: chunk.data.map(d => ({
        id: randomUUID(),
        chunkId: newChunk.id,
        metricTypeCode: parameter,
        unit,
        // Temporary compatibility while frequency still exists in Prisma.
        frequency: granularity,
        date: moment.utc(d.date).toDate(),
        value: Number(d.value)
      }))
    })
    createdValues += rows

    logger.log(`Valeurs insérées: chunkId=${newChunk.id}, count=${rows}`)
  }

  await prisma.source.update({
    where: {id: sourceId},
    data: {
      status: 'COMPLETED',
      globalInstructionStatus: computeGlobalInstructionStatus(chunkStatuses),
      metadata: {
        totalWaterVolumeWithdrawn: sourceTotalWaterVolumeWithdrawn,
        totalWaterVolumeDischarged: sourceTotalWaterVolumeDischarged
      }
    }
  })

  logger.log(`Source complétée: id=${sourceId}, status=COMPLETED`)
  logger.log(
    `Résumé: series=${data.series.length}, chunks=${createdChunks}, values=${createdValues}, matchedPoints=${matchedPoints}, unmatchedPoints=${unmatchedPoints}`
  )
}

export async function processAPIDeclaration(apiDeclarationId, logger = createLogger()) {
  logger.log(`Traitement de la déclaration API ${apiDeclarationId}`)

  const apiDeclaration = await getApiDeclaration(apiDeclarationId)
  if (!apiDeclaration) {
    logger.error(`Déclaration API ${apiDeclarationId} introuvable`)
    Sentry.captureException(new Error(`Déclaration API ${apiDeclarationId} introuvable`))
    return
  }

  const data = normalizeApiDeclaration(apiDeclaration)
  if (!data?.series?.length) {
    logger.log('Aucune série à importer')
    return
  }

  logger.log(`Séries extraites: ${data.series.length}`)

  const payloadSourceMetadata = apiDeclaration.data?.source_metadata ?? {}
  const newSource = await prisma.$transaction(
    async tx => tx.source.create({
      data: {
        type: 'API',
        status: 'PENDING',
        metadata: {
          connector: apiDeclaration.connector,
          serviceAccount: apiDeclaration.serviceAccount,
          pointId: apiDeclaration.pointId ?? apiDeclaration.metadata?.point_id ?? null,
          lastRunAt: apiDeclaration.lastRunAt ?? apiDeclaration.metadata?.last_run_at ?? null,
          sourceType: apiDeclaration.data?.source_type ?? null,
          provider: payloadSourceMetadata.provider ?? null,
          endpoint: payloadSourceMetadata.endpoint ?? null,
          resolution: payloadSourceMetadata.resolution ?? null,
          stationId: payloadSourceMetadata.station_id ?? null
        }
      }
    })
  )

  const declarantUserId = apiDeclaration.metadata?.declarant_id ?? null
  logger.log(`Source créée: id=${newSource.id}, type=${newSource.type}, status=PENDING`)

  await createChunksFromData(data, newSource.id, declarantUserId, true, logger)
}

// ---------------------------------------------------------------------------
// Lecture déclaration et fichier
// ---------------------------------------------------------------------------

async function getApiDeclaration(apiDeclarationId) {
  const apiDeclarations = [
    {
      connector: 'willie',
      serviceAccount: 'service_account_primaire',
      lastRunAt: '2026-04-23T16:09:28.613Z',
      data: {
        id_point_de_prelevement: 'aedd02ee-6876-4afc-91bc-b2a9a142b79f',
        source_type: 'API',
        source_metadata: {
          provider: 'willie',
          endpoint: 'https://api.meetwillie.com/v1/stations/consumption',
          resolution: 'hour',
          station_id: 'aedd02ee-6876-4afc-91bc-b2a9a142b79f'
        },
        min_date: '2026-04-22T22:00:00.000Z',
        max_date: '2026-04-23T13:00:00.000Z',
        metrics: [
          {
            type: 'volume_preleve',
            granularity: '1 hour',
            values: [
              {
                date: '2026-04-22T22:00:00.000Z',
                value: 9.7
              },
              {
                date: '2026-04-22T23:00:00.000Z',
                value: 4.8
              },
              {
                date: '2026-04-23T00:00:00.000Z',
                value: 4.7
              },
              {
                date: '2026-04-23T01:00:00.000Z',
                value: 4.9
              },
              {
                date: '2026-04-23T02:00:00.000Z',
                value: 38.7
              },
              {
                date: '2026-04-23T03:00:00.000Z',
                value: 138.9
              },
              {
                date: '2026-04-23T04:00:00.000Z',
                value: 128.7
              },
              {
                date: '2026-04-23T05:00:00.000Z',
                value: 68.6
              },
              {
                date: '2026-04-23T06:00:00.000Z',
                value: 97.8
              },
              {
                date: '2026-04-23T07:00:00.000Z',
                value: 65
              },
              {
                date: '2026-04-23T08:00:00.000Z',
                value: 57
              },
              {
                date: '2026-04-23T09:00:00.000Z',
                value: 70.5
              },
              {
                date: '2026-04-23T10:00:00.000Z',
                value: 64.8
              },
              {
                date: '2026-04-23T11:00:00.000Z',
                value: 60.2
              },
              {
                date: '2026-04-23T12:00:00.000Z',
                value: 16.5
              },
              {
                date: '2026-04-23T13:00:00.000Z',
                value: 0
              }
            ],
            unit: 'm3'
          }
        ]
      },
      pointId: '392e70c3-f3ba-456a-952e-697a28f7da9d',
      metadata: {
        point_id: '392e70c3-f3ba-456a-952e-697a28f7da9d',
        declarant_id: 'decl_blv_0',
        context_id: 'willie_blv_0',
        last_run_at: '2026-04-23T16:09:28.613Z'
      }
    }
  ]

  return apiDeclarations.find(d => d.id === apiDeclarationId) ?? apiDeclarations[0]
}

function normalizeApiDeclaration(apiDeclaration) {
  const pointPrelevementId
    = apiDeclaration.pointId
      ?? apiDeclaration.metadata?.point_id
      ?? apiDeclaration.data?.id_point_de_prelevement
  const pointPrelevementName = pointPrelevementId
  const minDate = apiDeclaration.data?.min_date
  const maxDate = apiDeclaration.data?.max_date

  const series = (apiDeclaration.data?.metrics ?? []).map(metric => ({
    pointPrelevement: pointPrelevementName,
    pointId: pointPrelevementId,
    parameter: normalizeMetricTypeCode(metric.type),
    unit: metric.unit ?? null,
    granularity: metric.granularity ?? '15_minutes',
    minDate,
    maxDate,
    data: metric.values ?? []
  }))

  return {series}
}

async function resolvePointPrelevement(pointId, pointPrelevementName) {
  if (pointId) {
    const byId = await prisma.pointPrelevement.findFirst({
      where: {
        id: pointId,
        deletedAt: null
      },
      select: {id: true}
    })
    if (byId?.id) {
      return byId
    }
  }

  if (!pointPrelevementName) {
    return null
  }

  return prisma.pointPrelevement.findFirst({
    where: {
      OR: [
        {
          name: pointPrelevementName
        },
        {
          name: {
            contains: pointPrelevementName,
            mode: 'insensitive'
          }
        }
      ],
      deletedAt: null
    },
    select: {id: true}
  })
}

function normalizeMetricTypeCode(type) {
  const normalized = (type ?? '')
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .replaceAll(' ', '_')
    .toLowerCase()

  if (normalized === 'volume_prelevé') {
    return 'volume_preleve'
  }

  if (normalized === 'volume_rejeté') {
    return 'volume_rejete'
  }

  return normalized
}

function computeTotalWaterVolume(chunk, parameterName) {
  if (chunk.parameter !== parameterName) {
    return 0
  }

  let total = 0
  for (const d of (chunk.data ?? [])) {
    const value = Number(d.value)
    if (!Number.isNaN(value)) {
      total += value
    }
  }

  return total
}
