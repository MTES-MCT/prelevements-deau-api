import {getQueue} from './config.js'

/**
 * Crée un job pour traiter une pièce jointe
 * Utilise jobId pour la déduplication
 */
export async function addJobProcessAttachment(attachmentId) {
  const queue = getQueue('process-attachment')
  if (!queue) {
    console.log('Queue non disponible (mode test ?), job ignoré')
    return
  }

  await queue.add(
    'process-attachment',
    {attachmentId},
    {
      jobId: `attachment-${attachmentId}`,
      delay: 2000 // Debounce 2s
    }
  )
}

/**
 * Crée un job pour consolider un dossier
 * Utilise jobId pour la déduplication
 */
export async function addJobConsolidateDossier(dossierId) {
  const queue = getQueue('consolidate-dossier')
  if (!queue) {
    console.log('Queue non disponible (mode test ?), job ignoré')
    return
  }

  await queue.add(
    'consolidate-dossier',
    {dossierId},
    {
      jobId: `dossier-${dossierId}`,
      delay: 5000 // Debounce 5s
    }
  )
}

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
      jobId: `declaration-${declarationId}`,
    }
  )
}
