import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import got from 'got'

// Configure les chemins et le répertoire de stockage
const __filename = fileURLToPath(import.meta.url)
const projectRoot = path.resolve(path.dirname(__filename), '..')

const filesDir = path.join(projectRoot, 'data/files')
const dossiersPath = path.join(projectRoot, 'data/dossiers.json')

if (!fs.existsSync(filesDir)) {
  fs.mkdirSync(filesDir)
}

// Importe les données JSON
const data = JSON.parse(fs.readFileSync(dossiersPath, 'utf8'))

// Fonction de téléchargement de fichier
const downloadFile = async (url, filename) => {
  const filePath = path.join(filesDir, filename)

  try {
    const fileContent = await got(url).buffer()
    await fs.promises.writeFile(filePath, fileContent)
    console.log(`Téléchargement terminé: ${filename}`)
  } catch (error) {
    console.error(`Échec du téléchargement de ${filename}:`, error.message)
    await fs.promises.unlink(filePath).catch(() => {}) // Supprime le fichier partiellement téléchargé en cas d'erreur
  }
}

// Fonction récursive pour trouver tous les champs 'files' en profondeur
const findAllFiles = obj => {
  let files = []
  if (Array.isArray(obj)) {
    for (const item of obj) {
      files = [...files, ...findAllFiles(item)]
    }
  } else if (typeof obj === 'object' && obj !== null) {
    for (const key in obj) {
      files = key === 'files' && Array.isArray(obj[key]) ? [...files, ...obj[key]] : [...files, ...findAllFiles(obj[key])]
    }
  }

  return files
}

// Téléchargement séquentiel de tous les fichiers 'files' trouvés
async function downloadAllFiles() {
  const allFiles = findAllFiles(data)

  for (const file of allFiles) {
    if (file.url && file.filename) {
      console.log(`Téléchargement du fichier ${file.filename}...`)
      await downloadFile(file.url, file.filename) // eslint-disable-line no-await-in-loop
    }
  }

  console.log('Tous les fichiers ont été téléchargés.')
}

// Lance le processus de téléchargement
await downloadAllFiles()
