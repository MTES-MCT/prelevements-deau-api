import 'dotenv/config'

import process from 'node:process'

import got from 'got'
import {difference, pick} from 'lodash-es'
import pMap from 'p-map'

import {downloadFile, objectExists, uploadObject} from '../util/s3.js'
import {createDossier, updateDossier, getDossierByNumber} from '../models/dossier.js'

import {validateFile} from './validation.js'

import {fetchData} from './graphql/request.js'

const demarcheNumber = Number.parseInt(process.env.DS_DEMARCHE_NUMBER, 10)

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
          const fileWithLabel = {
            ...pick(node, ['url', 'filename', 'contentType', 'checksum', 'byteSize']),
            fileType: currentLabel
          }
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
  console.log(`Traitement du dossier ${dossier.number}:`)
  const existingDossier = await getDossierByNumber(dossier.number)

  let processedFiles = [] // Liste des fichiers traités

  try {
    // Extraire les fichiers du dossier
    const files = getFileUrlsFromDossier(dossier)

    // Vérifier si le dossier existe déjà et si les fichiers sont identiques
    const hasNewFiles = !existingDossier || !difference(files.map(f => f.checksum), existingDossier.files.map(f => f.checksum))
    if (files.length > 0 && hasNewFiles) {
      // Traitement séquentiellement des fichiers
      processedFiles = await pMap(files, async file => {
        let buffer
        const fileKey = getFileS3Key(dossier.number, file.filename)
        const fileExists = await objectExists(fileKey)

        // Étape 1 : Télécharger le fichier
        if (fileExists) {
          console.log(`Téléchargement du fichier ${file.filename} depuis S3...`)
          buffer = await downloadFile(fileKey)
        } else {
          try {
            console.log(`Téléchargement du fichier ${file.filename} depuis l'URL externe...`)
            buffer = await got(file.url).buffer()
          } catch (error) {
            console.error(`Échec du téléchargement du fichier ${file.url}:`, error)
            return {
              ...pick(file, ['filename', 'fileType', 'checksum', 'byteSize']),
              errors: [{message: `Erreur de téléchargement : ${error.message}`, destinataire: 'administrateur'}]
            }
          }
        }

        // Étape 2 : Valider le fichier
        const errors = await validateFile(file.fileType, buffer, dossier.champs)

        // Étape 3 : Uploader le fichier, même en cas d'erreur
        try {
          console.log(`Upload du fichier ${file.filename} sur S3...`)
          await uploadFile(fileKey, buffer)
        } catch (error) {
          console.error(`Échec de l'upload du fichier ${file.filename} sur S3:`, error)
          errors.push({message: `Erreur d'upload : ${error.message}`, destinataire: 'administrateur'})
        }

        // Libérer le buffer
        buffer = undefined

        return {
          ...pick(file, ['filename', 'fileType', 'checksum', 'byteSize']),
          errors
        }
      }, {concurrency: 1})
    }

    // Vérifier si le dossier est valide
    const isValid = processedFiles.length > 0
      ? processedFiles.every(file => file.errors.length === 0)
      : (existingDossier?.isValid ?? true)

    // Sauvegarder le résultat du dossier
    await (existingDossier
      ? updateDossier(existingDossier._id, dossier, hasNewFiles ? processedFiles : existingDossier.files, isValid)
      : createDossier(dossier, processedFiles, isValid)
    )
  } catch (error) {
    console.error(`Erreur lors du traitement du dossier ${dossier.number}:`, error)
  }
}

export async function * fetchDossiersGenerator({includeChamps = true, cursor = null} = {}) {
  const variables = {
    demarcheNumber,
    first: 100,
    includeDossiers: true,
    includeChamps
  }

  if (cursor) {
    variables.after = cursor
  }

  const {demarche: {dossiers}} = await fetchData('getDemarche', variables)

  for (const dossier of dossiers.nodes) {
    yield dossier
  }

  if (dossiers.pageInfo.hasNextPage) {
    yield * fetchDossiersGenerator({includeChamps, cursor: dossiers.pageInfo.endCursor})
  }
}

export async function processAllDossiers() {
  console.log(`Traitement des dossiers pour la démarche ${demarcheNumber}...`)

  for await (const dossier of fetchDossiersGenerator({includeChamps: true})) {
    if (['en_instruction', 'accepte'].includes(dossier.state)) {
      await processDossier(dossier)
      console.log(`Dossier ${dossier.number} traité.`)
    }
  }
}
