import {getQueue} from './config.js'

export async function addJobProcessDeclaration(declarationId) {
  const queue = getQueue('process-declaration')
  if (!queue) {
    console.log('Queue non disponible (mode test ?), job ignoré')
    return
  }

  await queue.add(
    'process-declaration',
    {declarationId},
    {
      jobId: `declaration-${declarationId}`
    }
  )
}

export async function addJobProcessApiImport(apiImportId) {
  const queue = getQueue('process-api-import')
  if (!queue) {
    console.log('Queue non disponible, job ignoré')
    return
  }

  await queue.add(
    'process-api-import',
    {apiImportId},
    {
      jobId: `api-import-${apiImportId}`
    }
  )
}

export async function addJobReconstructVolumesFromIndexForPoint(pointId, sourceId) {
  const queue = getQueue('reconstruct-volumes-from-index-for-point')
  if (!queue) {
    console.log('Queue non disponible, job ignoré')
    return
  }

  await queue.add(
    'reconstruct-volumes-from-index-for-point',
    {pointId, sourceId},
    {
      jobId: `reconstruct-volumes-point-${pointId}-source-${sourceId}`
    }
  )
}
