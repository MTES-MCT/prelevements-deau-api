#!/usr/bin/env node
import 'dotenv/config'
import process from 'node:process'

import mongo from '../lib/util/mongo.js'
import {closeConnection} from '../lib/queues/config.js'
import {deleteAllIntegrations} from '../lib/models/integration-journaliere.js'
import {resetAllIntegratedDays} from '../lib/models/series.js'

// Vérification du flag --force
if (process.argv[2] !== '--force') {
  console.error('⚠️  ATTENTION : Cette opération va supprimer TOUTES les intégrations journalières.')
  console.error('⚠️  Les données suivantes seront réinitialisées :')
  console.error('   • Collection integrations_journalieres (vidée)')
  console.error('   • Champ computed.integratedDays des séries (réinitialisé à [])')
  console.error('')
  console.error('Pour confirmer cette opération destructive, utilisez : --force')
  process.exit(1)
}

// Connect to MongoDB
await mongo.connect()

async function main() {
  console.log('🗑️  Réinitialisation des intégrations...\n')

  // 1. Supprimer toutes les intégrations journalières
  console.log('1️⃣  Suppression des intégrations journalières...')
  const {deletedCount} = await deleteAllIntegrations()
  console.log(`   ✓ ${deletedCount} intégrations supprimées\n`)

  // 2. Réinitialiser les jours intégrés des séries
  console.log('2️⃣  Réinitialisation des jours intégrés des séries...')
  const {matched: seriesMatched, modified: seriesModified} = await resetAllIntegratedDays()
  console.log(`   ✓ ${seriesModified} séries modifiées (${seriesMatched} trouvées)\n`)

  // Message final
  console.log('✅ Réinitialisation terminée avec succès !')
  console.log('')
  console.log('💡 Pour reconsolider les dossiers, lancez :')
  console.log('   npm run reconsolidate-all-dossiers')
}

// Call the main function and ensure MongoDB is disconnected afterwards
try {
  await main()
} finally {
  // Disconnect from MongoDB and Redis
  await mongo.disconnect()
  await closeConnection()
}
