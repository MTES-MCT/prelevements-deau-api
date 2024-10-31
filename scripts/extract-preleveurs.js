import fs from 'fs'
import path from 'path'

import {deburr, upperCase, startCase} from 'lodash-es'

// Helper to normalize and clean up strings
const normalizeString = str => deburr(str).toLowerCase().trim()

// Format phone numbers to a standard format
const formatPhoneNumber = phone =>
  phone.replaceAll(/\D/g, '').replace(/(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, '$1 $2 $3 $4 $5')

// Format names: last names in uppercase and first names with first letter capitalized
const formatLastName = name => upperCase(normalizeString(name))
const formatFirstName = firstName => startCase(normalizeString(firstName))

const extractOATNumber = (champs, dossierId) => {
  const str = champs['Numéro de votre arrêté d\'AOT'] || champs['Numéro de votre arrêté d\'AOT (ATTENTION : modification du format à partir de septembre 2024)']
  if (str) {
    // The regex extracts the AOT number by matching a four-digit year, a code number, and optional administration and service sections, ensuring the format YYYY-XXX/<administration>/<service>.
    const regex = /\b(?:[n°º]\s*)?(?:aot\s*(?:[n°º]\s*)?)?\s*(\d{4})[ -](\d+)(?:[ /-](\w+))?(?:[ /-]([\w ]+))?/i
    const match = str.match(regex)
    if (match) {
      const year = match[1]
      const code = match[2]
      const administration = match[3] || ''
      const service = match[4] || ''

      let aotNumber = `${year}-${code}`
      if (administration) {
        aotNumber += `/${administration}`
      }

      if (service) {
        aotNumber += `/${service}`
      }

      return aotNumber.trim()
    }

    return str
  }

  console.log('No AOT number found in dossier:', dossierId)

  return ''
}

// Function to extract and process data
const extractDossierData = filePath => {
  const rawData = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  const processedData = []
  const uniqueIdentifiers = new Set()

  for (const dossier of rawData) {
    const demandeur = dossier.demandeur || {}
    const champs = dossier.champs.reduce((acc, champ) => {
      acc[champ.label] = champ.stringValue?.trim() || ''
      return acc
    }, {})

    const lastName = formatLastName(demandeur.nom || '')
    const firstName = formatFirstName(demandeur.prenom || '')

    // Create a unique identifier based on normalized nom+prenom
    const uniqueId = normalizeString(lastName + firstName)

    // Only process unique entries
    if (!uniqueIdentifiers.has(uniqueId)) {
      uniqueIdentifiers.add(uniqueId)

      // Extract and format email addresses
      const entry = {
        Civilité: demandeur.civilite || '',
        Nom: lastName,
        Prénom: firstName,
        email: champs['Adresse électronique'] || '',
        'Numéro de téléphone': formatPhoneNumber(champs['Numéro de téléphone'] || ''),
        'Raison sociale de votre structure': champs['Raison sociale de votre structure'] || '',
        'Type de préleveur': champs['Vous formulez cette déclaration en tant que :'] || '',
        AOT: extractOATNumber(champs, dossier.id)
      }

      processedData.push(entry)
    }
  }

  // Sort data alphabetically by Nom
  processedData.sort((a, b) => a.Nom.localeCompare(b.Nom))

  return processedData
}

// Function to save extracted data as CSV
const saveToCsv = (data, outputPath) => {
  const headers = [
    'Civilité',
    'AOT',
    'Nom',
    'Prénom',
    'email',
    'Numéro de téléphone',
    'Raison sociale de votre structure',
    'Type de préleveur'
  ]
  const csvRows = data.map(row => headers.map(header => `"${row[header] || ''}"`).join(','))
  const csvContent = [headers.join(','), ...csvRows].join('\n')

  fs.mkdirSync(path.dirname(outputPath), {recursive: true})
  fs.writeFileSync(outputPath, csvContent, 'utf-8')
  console.log(`Data saved to ${outputPath}`)
}

// Define file paths
const inputFilePath = path.resolve('data/all_dossiers.json')
const outputCsvPath = path.resolve('data/preleveurs.csv')

// Run the extraction and save to CSV
const extractedData = extractDossierData(inputFilePath)
saveToCsv(extractedData, outputCsvPath)
