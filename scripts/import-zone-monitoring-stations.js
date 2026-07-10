import '../lib/config/env.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {prisma} from '../db/prisma.js'
import {closeQueues} from '../lib/queues/config.js'
import {addJobSyncMonitoringStation} from '../lib/queues/jobs.js'
import {closeRedis} from '../lib/queues/redis.js'
import {
  resolveMonitoringStationMetadata,
  upsertMonitoringStationMetadata
} from '../lib/services/monitoring-stations.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixturePath = path.resolve(__dirname, '../prisma/fixtures/zone-monitoring-stations.json')
const fixtures = JSON.parse(await fs.readFile(fixturePath, 'utf8'))

async function main() {
  const resolvedFixtures = []

  for (const fixture of fixtures) {
    const zone = await prisma.zone.findUnique({
      where: {
        type_code: fixture.zone
      },
      select: {id: true, code: true, name: true}
    })

    if (!zone) {
      throw new Error(`Zone absente : ${fixture.zone.type}/${fixture.zone.code}`)
    }

    for (const station of fixture.stations) {
      console.log(`[monitoring-fixtures] Vérification ${station.type} ${station.stationCode}`)
      const metadata = await resolveMonitoringStationMetadata(station.type, station.stationCode)

      if (station.bssId && metadata.bssId !== station.bssId) {
        throw new Error(
          `Identifiant BSS inattendu pour ${station.stationCode} : ${metadata.bssId || 'absent'}`
        )
      }

      resolvedFixtures.push({zone, station, metadata})
    }
  }

  const monitoringStationIds = await prisma.$transaction(async transaction => {
    const stationIds = new Set()

    for (const {zone, station, metadata} of resolvedFixtures) {
      const monitoringStation = await upsertMonitoringStationMetadata(transaction, metadata)
      stationIds.add(monitoringStation.id)

      await transaction.zoneMonitoringStation.upsert({
        where: {
          zoneId_monitoringStationId: {
            zoneId: zone.id,
            monitoringStationId: monitoringStation.id
          }
        },
        create: {
          zoneId: zone.id,
          monitoringStationId: monitoringStation.id,
          label: station.label,
          enabled: station.enabled
        },
        update: {
          label: station.label,
          enabled: station.enabled
        }
      })
    }

    return [...stationIds]
  })

  await Promise.all(monitoringStationIds.flatMap(stationId => [
    addJobSyncMonitoringStation(stationId, 'full'),
    addJobSyncMonitoringStation(stationId, 'realtime')
  ]))

  console.log(`[monitoring-fixtures] ${resolvedFixtures.length} stations configurées et synchronisations programmées.`)
}

try {
  await main()
} catch (error) {
  console.error(error)
  throw error
} finally {
  await closeQueues()
  await closeRedis()
  await prisma.$disconnect()
}
