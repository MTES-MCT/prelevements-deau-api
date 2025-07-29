// Migration : reset-processed-camion-citerne-files.js
// Date : 29/07/2025
// Objectif : remettre `processed` à false pour les pièces jointes liées aux dossiers
// camion-citerne, avec journalisation détaillée pour le suivi.

import 'dotenv/config'
import mongo from '../lib/util/mongo.js'

try {
  await mongo.connect()

  // 1. Récupération des numéros de dossier concernés
  const dossiers = await mongo.db.collection('dossiers')
    .find({typePrelevement: 'camion-citerne'}, {_id: 0, number: 1})
    .toArray()

  const nums = dossiers.map(d => d.number)
  console.log(`[data] ${nums.length} dossier(s) sélectionné(s)`)

  if (nums.length === 0) {
    console.warn('[migration] Aucun dossier correspondant — rien à modifier')
  } else {
    // 2. Mise à jour des attachements
    console.time('[step] update-attachments')
    const {matchedCount, modifiedCount} = await mongo.db.collection('dossier_attachments').updateMany(
      {dossierNumber: {$in: nums}, processed: true},
      {$set: {processed: false}}
    )

    console.log(`[result] matched : ${matchedCount}, modified : ${modifiedCount}`)

    if (modifiedCount !== matchedCount) {
      console.warn('[result] Certains documents ont correspondu sans être modifiés — vérifier la requête.')
    }
  }
} catch (error) {
  console.error('[migration] Échec :', error)
  throw error
} finally {
  await mongo.disconnect()
}
