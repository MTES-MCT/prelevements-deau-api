import 'dotenv/config'
import mongo from '../lib/util/mongo.js'
import pMap from 'p-map'

import {downloadFile, objectExists} from '../lib/util/s3.js'
import {updateDossier} from '../lib/models/dossier.js'
import {validateFile} from '../lib/demarches-simplifiees/validation.js'
import {getFileS3Key} from '../lib/demarches-simplifiees/index.js'

// Connect to MongoDB
await mongo.connect()

// Fonction pour traiter un dossier individuel
export async function validDossier(dossier) {
  console.log(`Traitement du dossier ${dossier.number}...`)
  let processedFiles = [] // Liste des fichiers traités

  try {
    // Traitement séquentiellement des fichiers
    processedFiles = await pMap(dossier.files, async file => {
      let buffer
      const fileKey = getFileS3Key(dossier.number, file.filename)

      // Étape 1 : Télécharger le fichier
      if (await objectExists(fileKey)) {
        console.log(`Téléchargement du fichier ${file.filename} depuis S3...`)
        buffer = await downloadFile(fileKey)
      } else {
        throw new Error(`Le fichier ${file.filename} n'existe pas sur S3`)
      }

      // Étape 2 : Valider le fichier
      console.log(`Validation du fichier ${file.filename}...`)
      const errors = await validateFile(file.fileType, buffer, dossier.champs)

      // Libérer le buffer
      buffer = undefined

      return {
        ...file,
        errors
      }
    }, {concurrency: 1})

    // Sauvegarder le résultat du dossier
    const isValid = processedFiles.every(file => file.errors.length === 0)

    await updateDossier(dossier._id, {}, processedFiles, isValid)
  } catch (error) {
    console.error(`Erreur lors du traitement du dossier ${dossier.number}:`, error)
  }
}

async function main() {
  const dossiersWithFiles = await mongo.db.collection('dossiers').find({
    'files.0': {$exists: true}
  }).toArray()

  await pMap(dossiersWithFiles, dossier => validDossier(dossier), {concurrency: 1})
}

// Call the main function and ensure MongoDB is disconnected afterwards
try {
  await main()
} finally {
  // Disconnect from MongoDB
  await mongo.disconnect()
}
