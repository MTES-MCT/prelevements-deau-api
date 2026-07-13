import '../lib/config/env.js'

import {prisma} from '../db/prisma.js'

const shouldApply = process.argv.includes('--apply')
const sourceZoneKey = {type: 'SAGE', code: 'sage-SAGE06030'}
const targetZoneKey = {type: 'SAGE', code: 'sage-SAGE06028'}
const piezometers = [
  {stationCode: '10971X0198/LAFAR', label: 'Ortaffa'},
  {stationCode: '10972X0137/PONT', label: 'Argelès-sur-Mer - Pont du Tech'},
  {stationCode: '10975X0032/SABIRO', label: 'Sabirou'}
]

async function getZone(key) {
  const zone = await prisma.zone.findUnique({
    where: {type_code: key},
    select: {id: true, code: true, name: true}
  })

  if (!zone) {
    throw new Error(`Zone absente : ${key.type}/${key.code}`)
  }

  return zone
}

async function getCurrentState(sourceZone, targetZone) {
  return prisma.monitoringStation.findMany({
    where: {
      type: 'PIEZOMETER',
      stationCode: {in: piezometers.map(({stationCode}) => stationCode)}
    },
    select: {
      id: true,
      stationCode: true,
      zones: {
        where: {zoneId: {in: [sourceZone.id, targetZone.id]}},
        select: {zoneId: true, label: true, enabled: true}
      }
    },
    orderBy: {stationCode: 'asc'}
  })
}

function assertAllStationsFound(stations) {
  const foundCodes = new Set(stations.map(({stationCode}) => stationCode))
  const missingCodes = piezometers
    .map(({stationCode}) => stationCode)
    .filter(stationCode => !foundCodes.has(stationCode))

  if (missingCodes.length > 0) {
    throw new Error(`Piézomètres absents : ${missingCodes.join(', ')}`)
  }
}

function printState(title, stations, sourceZone, targetZone) {
  console.log(`\n${title}`)

  for (const station of stations) {
    const sourceAssociation = station.zones.find(({zoneId}) => zoneId === sourceZone.id)
    const targetAssociation = station.zones.find(({zoneId}) => zoneId === targetZone.id)

    console.log(
      `- ${station.stationCode} : ${sourceZone.code}=${sourceAssociation ? 'oui' : 'non'}, `
      + `${targetZone.code}=${targetAssociation ? 'oui' : 'non'}`
    )
  }
}

async function main() {
  const [sourceZone, targetZone] = await Promise.all([
    getZone(sourceZoneKey),
    getZone(targetZoneKey)
  ])
  const currentStations = await getCurrentState(sourceZone, targetZone)

  assertAllStationsFound(currentStations)
  printState('État actuel', currentStations, sourceZone, targetZone)

  if (!shouldApply) {
    console.log('\nSimulation uniquement. Relancer avec --apply pour déplacer les rattachements.')
    return
  }

  const fixtureByCode = new Map(piezometers.map(station => [station.stationCode, station]))

  await prisma.$transaction(async transaction => {
    for (const station of currentStations) {
      const fixture = fixtureByCode.get(station.stationCode)
      const sourceAssociation = station.zones.find(({zoneId}) => zoneId === sourceZone.id)
      const targetAssociation = station.zones.find(({zoneId}) => zoneId === targetZone.id)

      await transaction.zoneMonitoringStation.upsert({
        where: {
          zoneId_monitoringStationId: {
            zoneId: targetZone.id,
            monitoringStationId: station.id
          }
        },
        create: {
          zoneId: targetZone.id,
          monitoringStationId: station.id,
          label: fixture.label,
          enabled: sourceAssociation?.enabled ?? targetAssociation?.enabled ?? true
        },
        update: {
          label: fixture.label,
          enabled: sourceAssociation?.enabled ?? targetAssociation?.enabled ?? true
        }
      })

      await transaction.zoneMonitoringStation.deleteMany({
        where: {
          zoneId: sourceZone.id,
          monitoringStationId: station.id
        }
      })
    }
  })

  const updatedStations = await getCurrentState(sourceZone, targetZone)
  printState('État après correction', updatedStations, sourceZone, targetZone)

  const invalidStations = updatedStations.filter(station => {
    const zoneIds = new Set(station.zones.map(({zoneId}) => zoneId))
    return zoneIds.has(sourceZone.id) || !zoneIds.has(targetZone.id)
  })

  if (invalidStations.length > 0) {
    throw new Error(`Correction incomplète : ${invalidStations.map(({stationCode}) => stationCode).join(', ')}`)
  }
}

try {
  await main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await prisma.$disconnect()
}
