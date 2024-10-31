import fs from 'fs/promises'
import path from 'path'
import {fileURLToPath} from 'url'
import 'dotenv/config'

// URL de l'API GraphQL de Démarches Simplifiées
const ENDPOINT = 'https://www.demarches-simplifiees.fr/api/v2/graphql'

// Lecture de la requête GraphQL depuis le fichier
const __filename = fileURLToPath(import.meta.url)
const projectRoot = path.resolve(path.dirname(__filename), '..')
const outputDir = path.join(projectRoot, 'data/dossiers.json')
const graphQLQueryPath = path.join(projectRoot, 'src/getDemarche.all.graphql')
const query = await fs.readFile(graphQLQueryPath, 'utf8')

// Fonction pour exécuter une requête GraphQL avec pagination
async function fetchDossiers(demarcheNumber, cursor = null) {
  const variables = {
    demarcheNumber,
    first: 100,
    includeDossiers: true,
    includeChamps: true
  }

  if (cursor) {
    variables.after = cursor
  }

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.API_TOKEN}`
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

// Fonction récursive pour récupérer tous les dossiers
async function getAllDossiers(demarcheNumber, cursor = null, allDossiers = []) {
  const data = await fetchDossiers(demarcheNumber, cursor)
  const dossiersBatch = data?.demarche?.dossiers?.nodes || []
  const newAllDossiers = [...allDossiers, ...dossiersBatch]

  const pageInfo = data?.demarche?.dossiers?.pageInfo || {}

  console.log(`Nombre total de dossiers récupérés: ${newAllDossiers.length}`)
  console.log(`Dossiers récupérés dans cette page: ${dossiersBatch.map(d => d.number).join(', ')}`)

  if (!pageInfo.hasNextPage) {
    console.log('Info: Toutes les pages disponibles ont été chargées.')
    return newAllDossiers
  }

  const nextCursor = pageInfo.endCursor
  return getAllDossiers(demarcheNumber, nextCursor, newAllDossiers)
}

// Exécution principale du script avec top-level await
const demarcheNumber = Number.parseInt(process.env.DEMARCHE_NUMBER, 10)
if (Number.isNaN(demarcheNumber)) {
  console.error('Veuillez définir DEMARCHE_NUMBER dans les variables d’environnement.')
} else {
  // Pas besoin de récupérer le curseur depuis un fichier, on commence avec null
  const allDossiers = await getAllDossiers(demarcheNumber)
  console.log(`Nombre total de dossiers récupérés: ${allDossiers.length}`)
  await fs.writeFile(outputDir, JSON.stringify(allDossiers, null, 2))
  console.log(`Tous les dossiers ont été enregistrés dans ${outputDir}`)
}
