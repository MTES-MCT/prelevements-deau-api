import 'dotenv/config'
import process from 'node:process'
import {omit} from 'lodash-es'
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import got from 'got'

import {objectExists, uploadObject} from '../s3.js'
import {createDossier, updateDossier, getDossierByNumber, getFileFromDossier} from '../../models/dossier.js'

// Lecture de la requête GraphQL depuis le fichier
const __filename = fileURLToPath(import.meta.url)
const projectRoot = path.resolve(path.dirname(__filename), '../../..')
const graphQLQueryPath = path.join(projectRoot, '/lib/util/demarches-simplifies/graphql-queries/get-demarche.graphql')
const query = await fs.readFile(graphQLQueryPath, 'utf8')

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
  const report = {}

  const validFormats = ['xls', 'xlsx', 'ods']
  const fileToCheck = files.find(file => file.label === 'Tableau de suivi')

  if (fileToCheck) {
    const fileExtension = fileToCheck.filename.split('.').pop()
    if (!validFormats.includes(fileExtension)) {
      report.invalidFormat = `Le format du fichier ${fileToCheck.filename} n'est pas valide.`
    }
  }

  return report
}

export function getFileUrlsFromDossier(data) {
  const result = []

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
          const fileWithLabel = {...omit(node, ['__typename']), label: currentLabel}
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

    // 2. Télécharger et uploader les fichiers sur S3
    const fileUploadPromises = files.map(async file => {
      // Vérifier si le fichier existe déjà
      const fileExists = await getFileFromDossier(dossier.number, file.checksum)
      if (!fileExists) {
        // Télécharger le fichier
        try {
          console.log(`Téléchargement du fichier ${file.filename}`)
          const fileBuffer = await got(file.url).buffer()

          // Uploader le fichier sur S3
          await uploadFile(`dossiers/${dossier.number}/${file.filename}`, fileBuffer)
        } catch {
          console.error(`Échec du téléchargement du fichier depuis ${file.url}`)
        }
      }

      return file
    })

    // Attendre que tous les fichiers soient uploadés
    const uploadedFiles = await Promise.all(fileUploadPromises)

    // 3. Effectuer les tests de validation
    const validationReport = await validateDossier(dossier, uploadedFiles)

    // 4. Sauvegarder le résultat dans MongoDB
    const existingDossier = await getDossierByNumber(dossier.number)
    await (existingDossier
      ? updateDossier(existingDossier._id, dossier, uploadedFiles, validationReport)
      : createDossier(dossier, uploadedFiles, validationReport)
    )
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
  const processDossiersPromises = dossiersBatch.map(dossier => processDossier(dossier))
  await Promise.all(processDossiersPromises)

  const pageInfo = data?.demarche?.dossiers?.pageInfo || {}

  if (!pageInfo.hasNextPage) {
    console.log('Info: Toutes les pages disponibles ont été chargées.')
    return
  }

  const nextCursor = pageInfo.endCursor
  return getAllDossiers(variables, nextCursor)
}
