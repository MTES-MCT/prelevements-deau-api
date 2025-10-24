#!/usr/bin/env node
/* eslint-disable n/prefer-global/process */
import 'dotenv/config'
import {createInterface} from 'node:readline'
import mongo from '../lib/util/mongo.js'

const COLLECTIONS_TO_DROP = [
  'dossiers',
  'dossier_attachments',
  'series',
  'series_values',
  'integrations_journalieres'
]

async function askConfirmation() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  })

  return new Promise(resolve => {
    rl.question(
      `\u001B[33m⚠️  Êtes-vous sûr de vouloir supprimer les collections suivantes ?\u001B[0m\n  - ${COLLECTIONS_TO_DROP.join('\n  - ')}\n\n\u001B[33mTapez 'oui' pour confirmer : \u001B[0m`,
      answer => {
        rl.close()
        resolve(answer.toLowerCase() === 'oui')
      }
    )
  })
}

async function dropCollections() {
  console.log('\n\u001B[35;1;4m%s\u001B[0m', '=> Suppression des collections dossiers')

  await mongo.connect()

  const confirmed = await askConfirmation()

  if (!confirmed) {
    console.log('\n\u001B[31m❌ Opération annulée\u001B[0m\n')
    await mongo.disconnect()
    process.exit(0)
  }

  console.log('\n\u001B[32m✓ Confirmation reçue, suppression en cours...\u001B[0m\n')

  /* eslint-disable no-await-in-loop */
  for (const collectionName of COLLECTIONS_TO_DROP) {
    try {
      const collections = await mongo.db.listCollections({name: collectionName}).toArray()

      if (collections.length > 0) {
        await mongo.db.collection(collectionName).drop()
        console.log(`\u001B[32m✓ Collection '${collectionName}' supprimée\u001B[0m`)
      } else {
        console.log(`\u001B[90m⊘ Collection '${collectionName}' n'existe pas\u001B[0m`)
      }
    } catch (error) {
      console.error(`\u001B[31m✗ Erreur lors de la suppression de '${collectionName}': ${error.message}\u001B[0m`)
    }
  }
  /* eslint-enable no-await-in-loop */

  console.log('\n\u001B[32;1m%s\u001B[0m', '=> Suppression terminée\n')

  await mongo.disconnect()
}

await dropCollections()
