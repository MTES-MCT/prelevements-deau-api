import {execFile} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {startCase, toLower, uniqBy} from 'lodash-es'

const __filename = fileURLToPath(import.meta.url)
const projectRoot = path.resolve(path.dirname(__filename), '..')
const filesDirectory = path.join(projectRoot, 'data/files')
const dossiersPath = path.join(projectRoot, 'data/dossiers.json')
const outputCsvPath = path.join(projectRoot, 'data/points-prelevement.csv')

const communes = [
  'saint-denis',
  'saint-pierre',
  'bras-panon',
  'cilaos',
  'entre-deux',
  'la possession',
  'le port',
  'les avirons',
  'les trois-bassins',
  'etang-salé',
  'la petite île',
  'le tampon',
  'la plaine des palmistes',
  'salazie',
  'saint-leu',
  'sainte-marie',
  'sainte-rose',
  'saint-andre',
  'sainte-suzanne',
  'saint-philippe',
  'saint-louis',
  'saint-paul',
  'saint-benoît',
  'saint-joseph'
].map(c => c.normalize('NFD').replaceAll(/[\u0300-\u036F]/g, '').toLowerCase())

// Fonction pour extraire les points de prélèvement du JSON
function extractFromJSON() {
  console.log('Début de l\'extraction des points de prélèvement depuis dossiers.json...')
  const jsonData = JSON.parse(fs.readFileSync(dossiersPath, 'utf8'))
  const points = []

  for (const dossier of jsonData) {
    for (const champ of dossier.champs) {
      if (champ.label === 'Nom du point de prélèvement concerné par la déclaration' && champ.stringValue) {
        const parsedPoint = parsePoint(champ.stringValue)
        points.push(parsedPoint)
      }
    }
  }

  console.log('Extraction terminée pour dossiers.json.')
  return points
}

// Fonction pour lire un fichier Excel avec timeout
function readExcelWithTimeout(filePath, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const child = execFile('node', ['-e', `
            const xlsx = require('xlsx')
            const workbook = xlsx.readFile('${filePath}', { cellStyles: false })
            const worksheet = workbook.Sheets['A LIRE']
            if (worksheet && worksheet['B3']) {
                console.log(worksheet['B3'].v)
            } else {
                throw new Error('Cell B3 non trouvée')
            }
        `], {timeout}, (error, stdout) => {
      if (error) {
        reject(error)
      } else {
        resolve(stdout.trim())
      }
    })

    child.on('error', () => child.kill('SIGTERM'))
  })
}

// Fonction pour extraire les points de prélèvement des fichiers Excel
async function extractFromExcel() {
  console.log('Début de l\'extraction des points de prélèvement depuis les fichiers Excel...')
  const points = []

  const files = fs.readdirSync(filesDirectory)
  for (const file of files) {
    if (path.extname(file) === '.xlsx') {
      const filePath = path.join(filesDirectory, file)
      console.log(`Lecture du fichier : ${file}`)
      try {
        const pointString = await readExcelWithTimeout(filePath)
        const parsedPoint = parsePoint(pointString)
        points.push(parsedPoint)
      } catch {
        const pointName = path.basename(file, '.xlsx')
        points.push(parsePoint(pointName))
        console.warn(`Lecture échouée ou timeout pour ${file}. Utilisation du nom de fichier comme point de prélèvement.`)
      }
    }
  }

  console.log('Extraction terminée pour les fichiers Excel.')
  return points
}

// Fonction pour analyser et structurer les données de chaque point
function parsePoint(rawPoint) {
  // Prétraitement du nom brut
  const raw = rawPoint.normalize('NFD').replaceAll(/[\u0300-\u036F]/g, '').toLowerCase().trim()

  const patterns = [
    // Motif G: code | nom (commune)
    {
      regex: /^(\d+)\s*\|\s*(.+?)\s*\((.+?)\)(?:\.xlsx)?$/i,
      extract: match => ({
        numero: match[1],
        nom: match[2],
        commune: match[3]
      })
    },
    // Motif A: BILAN_DEAL_<code>_<nom>_<mois>_<année>.xlsx
    {
      regex: /^bilan_deal_(\d+)_([a-z\d]+)_([a-z]+)_(\d{2})(?:\.xlsx)?$/i,
      extract: match => ({
        numero: match[1],
        nom: match[2],
        commune: '' // La commune n'est pas présente dans ce motif
      })
    },
    // Motif B: <code>_<commune>_<nom>.xlsx
    {
      regex: /^(\d+)_([a-z ]+)_([a-z\d \-']+)(?:\.xlsx)?$/i,
      extract: match => ({
        numero: match[1],
        nom: match[3],
        commune: match[2]
      })
    },
    // Motif C: modele_saisie_donnees_prelevement_v<version> <nom>.xlsx
    {
      regex: /^modele_saisie_donnees_prelevement_v[\d.]+ (.+?)(?:\.xlsx)?$/i,
      extract: match => ({
        numero: '',
        nom: match[1],
        commune: ''
      })
    },
    // Motif D: PRELEVEMENT \d+ <nom>.xlsx
    {
      regex: /^prelevement \d+ ([a-z\d ]+)(?:\.xlsx)?$/i,
      extract: match => ({
        numero: '',
        nom: match[1],
        commune: ''
      })
    },
    // Motif E: Suivi-prelevements_camion-citerne
    {
      regex: /^suivi-prelevements_camion-citerne.*(?:\.xlsx)?$/i,
      extract: () => ({
        numero: '',
        nom: 'Suivi-prelevements camion-citerne',
        commune: ''
      })
    },
    // Motif F: Tentative d'extraction de la commune à partir du nom
    {
      regex: /^(.*?)(?:\.xlsx)?$/i,
      extract(match) {
        const name = match[1]
        // Recherche de la commune dans le nom
        const commune = communes.find(c => name.includes(c))
        const nomSansCommune = commune ? name.replace(commune, '').trim() : name.trim()
        return {
          numero: '',
          nom: nomSansCommune,
          commune: commune || ''
        }
      }
    },
    // Motif H: code suivi du nom et éventuellement de la commune
    {
      regex: /^(\d+)\s+(.+?)$/i,
      extract(match) {
        const code = match[1]
        const rest = match[2]
        // Recherche de la commune dans le reste de la chaîne
        const commune = communes.find(c => rest.includes(c))
        const nomSansCommune = commune ? rest.replace(commune, '').trim() : rest.trim()
        return {
          numero: code,
          nom: nomSansCommune,
          commune: commune ? startCase(toLower(commune.trim())) : ''
        }
      }
    }
  ]

  // Parcours des motifs pour trouver une correspondance
  for (const pattern of patterns) {
    const match = raw.match(pattern.regex)
    if (match) {
      const data = pattern.extract(match)
      // Nettoyage des données avec lodash
      data.nom = data.nom ? startCase(toLower(data.nom.trim())) : ''
      data.commune = data.commune ? startCase(toLower(data.commune.trim())) : ''
      data.numero = data.numero || ''
      return data
    }
  }

  // Si aucun motif ne correspond, utiliser le nom brut
  return {
    numero: '',
    nom: startCase(toLower(rawPoint.trim())),
    commune: ''
  }
}

// Fonction pour dédupliquer et fusionner les résultats
function unifyPoints(pointsArray) {
  const pointsMap = {}

  for (const point of pointsArray) {
    const key = point.numero || point.nom.toLowerCase()
    if (pointsMap[key]) {
      // Fusionner les informations partielles
      pointsMap[key] = {
        numero: point.numero || pointsMap[key].numero,
        nom: point.nom || pointsMap[key].nom,
        commune: point.commune || pointsMap[key].commune
      }
    } else {
      pointsMap[key] = point
    }
  }

  // Retourner un tableau des valeurs
  return Object.values(pointsMap)
}

// Fonction pour dédupliquer et sauvegarder les résultats dans un fichier CSV
function saveToCSV(points) {
  const csvData = ['Numero,Nom,Commune', ...points.map(point => `${point.numero},${point.nom},${point.commune}`)].join('\n')

  fs.writeFileSync(outputCsvPath, csvData)
  console.log(`Résultats sauvegardés dans ${outputCsvPath}`)
}

// Exécution et affichage des résultats
(async () => {
  console.log('Démarrage de l\'extraction des points de prélèvement...')
  const jsonPoints = extractFromJSON()
  const excelPoints = await extractFromExcel()
  const allPointsRaw = jsonPoints.concat(excelPoints)

  // Unifier les points
  const allPoints = unifyPoints(allPointsRaw)

  // Sauvegarde des points de prélèvement dans le fichier CSV
  saveToCSV(allPoints)
})()
