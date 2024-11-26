import 'dotenv/config'
import process from 'node:process'
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import pLimit from 'p-limit'
import got from 'got'
import {omit, pick} from 'lodash-es'

import {downloadFile, objectExists, uploadObject} from '../s3.js'
import {createDossier, updateDossier, getDossierByNumber} from '../../models/dossier.js'
import {runFormDataTests, runTests} from './validation.js'

// Lecture de la requête GraphQL depuis le fichier
const __filename = fileURLToPath(import.meta.url)
const projectRoot = path.resolve(path.dirname(__filename), '../../..')
const graphQLQueryPath = path.join(projectRoot, '/lib/util/demarches-simplifies/graphql-queries/get-demarche.graphql')
const query = await fs.readFile(graphQLQueryPath, 'utf8')

export function getFileS3Key(dossierNumber, filename) {
  return `dossiers/${dossierNumber}/${filename}`
}

async function uploadFile(filekey, buffer) {
  // Uploader le fichier sur S3
  const filesExists = await objectExists(filekey)

  if (!filesExists) {
    try {
      console.log(`Upload du fichier ${filekey} sur S3...`)
      await uploadObject(filekey, buffer)
    } catch (error) {
      console.error(`Échec de l'upload du fichier ${filekey} sur S3:`, error)
    }
  }
}

// Fonction pour valider un dossier et ses fichiers
async function validateDossier(dossier, files) {
  console.log(`Dossier ${dossier.number}`)

  // Validation des fichiers
  const fileValidationPromises = files.map(async file => {
    const errors = []

    try {
      const fileErrors = await runTests(file, dossier.champs)
      errors.push(...fileErrors)
    } catch (error) {
      errors.push({
        message: `Erreur lors de la validation du fichier : ${error.message}`,
        destinataire: 'administrateur'
      })
    }

    try {
      const formErrors = runFormDataTests(dossier.champs) || []
      errors.push(...formErrors)
    } catch (error) {
      errors.push({
        message: `Erreur lors de la validation des données du formulaire : ${error.message}`,
        destinataire: 'administrateur'
      })
    }

    return {
      ...pick(file, ['fileType', 'filename', 'checksum']),
      errors
    }
  })

  return Promise.all(fileValidationPromises)
}

export function getFileUrlsFromDossier(data) {
  const result = []

  // CurrentLabel permet d'identifier le fichier comme un "suivi camion citerne" ou "suivi multi paramètres"
  function traverse(node, currentLabel) {
    if (Array.isArray(node)) {
      for (const item of node) {
        traverse(item, currentLabel)
      }
    } else if (typeof node === 'object' && node !== null) {
      // Mettre à jour le label courant si le noeud a une propriété 'label' et n'est pas un 'File'
      if (
        Object.hasOwn(node, 'label')
        && typeof node.label === 'string'
        && node.__typename !== 'File'
      ) {
        currentLabel = node.label
      }

      // Vérifier si le noeud est un 'File'
      if (node.__typename === 'File') {
        const contentType = node.contentType || ''

        // Exclure les fichiers de type 'image/*' et 'application/pdf'
        if (!contentType.startsWith('image/') && contentType !== 'application/pdf') {
          // Cloner l'objet pour éviter de modifier les données originales
          const fileWithLabel = {...omit(node, ['__typename']), fileType: currentLabel}
          result.push(fileWithLabel)
        }
      }

      // Parcourir les propriétés de l'objet
      for (const key of Object.keys(node)) {
        // Ignorer la propriété 'pdf' lors du parcours
        if (key !== 'pdf') {
          traverse(node[key], currentLabel)
        }
      }
    }
  }

  traverse(data, null)
  return result
}

// Fonction pour traiter un dossier individuel
export async function processDossier(dossier) {
  try {
    // 1. Extraire les fichiers du dossier
    const files = getFileUrlsFromDossier(dossier)

    // Définir la limite de concurrence
    const concurrencyLimit = 10
    const limit = pLimit(concurrencyLimit)

    // 2. Télécharger les fichiers avec limite de concurrence
    const fileDownloadPromises = files.map(file => limit(async () => {
      // Vérifier si le fichier existe déjà dans S3
      const fileKey = getFileS3Key(dossier.number, file.filename)
      const fileExists = await objectExists(fileKey)
      if (fileExists) {
        // Télécharger le fichier depuis S3
        // console.log(`Téléchargement du fichier ${file.filename} depuis S3`)
        const buffer = await downloadFile(fileKey)
        return {...file, buffer}
      }

      // Télécharger le fichier depuis l'URL externe
      try {
        const buffer = await got(file.url).buffer()
        return {...file, buffer}
      } catch (error) {
        console.error(`Échec du téléchargement du fichier depuis ${file.url}:`, error)
        return null
      }
    }))

    // Attendre que tous les fichiers soient téléchargés
    const filesResult = (await Promise.all(fileDownloadPromises))
    const downloadedFiles = filesResult.filter(Boolean)

    // 3. Effectuer les tests de validation
    const validatedFiles = await validateDossier(dossier, downloadedFiles)
    const isValid = validatedFiles.every(file => file.errors.length === 0)

    // Uploader les fichiers sur S3 avec limite de concurrence
    const fileUploadPromises = downloadedFiles.map(file => limit(async () => {
      // Vérifier si le fichier existe déjà avant de l'uploader
      const fileKey = getFileS3Key(dossier.number, file.filename)
      await uploadFile(fileKey, file.buffer)
    }))

    await Promise.all(fileUploadPromises)

    // 4. Sauvegarder le résultat dans MongoDB
    const existingDossier = await getDossierByNumber(dossier.number)
    await (existingDossier
      ? updateDossier(existingDossier._id, dossier, validatedFiles, isValid)
      : createDossier(dossier, validatedFiles, isValid))
  } catch (error) {
    console.error(`Erreur lors du traitement du dossier ${dossier.number}:`, error)
  }
}

// Fonction pour exécuter une requête GraphQL avec pagination
export async function fetchDossiers(variables, query, cursor = null) {
  if (cursor) {
    variables.after = cursor
  }

  const response = await fetch(process.env.DS_API_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.DS_API_TOKEN}`
    },
    body: JSON.stringify({
      query,
      variables,
      operationName: 'getDemarche'
    })
  })

  const result = await response.json()
  if (result.errors) {
    console.error('Erreur lors de la requête GraphQL:', result.errors)

    throw new Error('GraphQL Error')
  }

  return result.data
}

// Fonction récursive pour récupérer et traiter tous les dossiers
export async function getAllDossiers(variables, cursor = null) {
  console.log(`Récupération de tous les dossiers pour la démarche ${variables.demarcheNumber}...`)

  const data = await fetchDossiers(variables, query, cursor)
  const dossiersBatch = data?.demarche?.dossiers?.nodes || []

  console.log(`Nombre total de dossiers récupérés: ${dossiersBatch.length}`)
  console.log(`Dossiers récupérés dans cette page: ${dossiersBatch.map(d => d.number).join(', ')}`)

  // Traiter les dossiers du batch actuel
  const processDossiersPromises = dossiersBatch
    .filter(({state}) => ['en_instruction', 'accepte'].includes(state)) // Processus uniquement les dossiers en instruction ou acceptés
    .map(dossier => processDossier(dossier))
  await Promise.all(processDossiersPromises)

  const pageInfo = data?.demarche?.dossiers?.pageInfo || {}

  if (!pageInfo.hasNextPage) {
    console.log('Info: Toutes les pages disponibles ont été chargées.')
    return
  }

  const nextCursor = pageInfo.endCursor
  return getAllDossiers(variables, nextCursor)
}
