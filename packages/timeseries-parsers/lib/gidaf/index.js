import {pick} from 'lodash-es'

import {readSheet} from '../xlsx.js'
import {readAsString, readAsDateString, readAsNumber} from '../xlsx.js'
import {validateNumericValue} from '../validate.js'
import * as XLSX from 'xlsx'

// Définition des colonnes des points de prélèvement (fichier Cadres)
const CADRES_POINT_COLUMNS = [
  {
    key: 'codeInspection',
    outputKey: 'code_aiot',
    matchers: ['code_inspection', 'code_aiot'],
    type: 'string',
    required: true
  },
  {
    key: 'pointSurveillance',
    outputKey: 'id_point_de_prelevement_ou_rejet',
    matchers: ['point_de_surveillance', 'point_surveillance'],
    type: 'string',
    required: true
  },
  {
    key: 'coordonneesX',
    outputKey: 'x_lambert93',
    matchers: ['coordonnées_x', 'coordonnees_x', 'x_lambert93', 'x_lambert'],
    type: 'number'
  },
  {
    key: 'coordonneesY',
    outputKey: 'y_lambert93',
    matchers: ['coordonnées_y', 'coordonnees_y', 'y_lambert93', 'y_lambert'],
    type: 'number'
  },
  {
    key: 'commune',
    outputKey: 'commune',
    matchers: ['commune'],
    type: 'string'
  },
  {
    key: 'typePoint',
    outputKey: 'type_de_point',
    matchers: ['type_de_point', 'type_point'],
    type: 'string'
  },
  {
    key: 'milieu',
    outputKey: 'milieu',
    matchers: ['milieu'],
    type: 'string'
  },
  {
    key: 'precisionMilieu',
    outputKey: 'précision_milieu',
    matchers: ['précision_milieu', 'precision_milieu'],
    type: 'string'
  },
  {
    key: 'volumeMaxAutorise',
    outputKey: 'volume_max_autorisé_m3',
    matchers: ['volume_max_autorisé_(m3)', 'volume_max_autorise_m3', 'volume_max_autorisé', 'volume_max_autorise'],
    type: 'number'
  },
  {
    key: 'periodeReferenceVolumeMax',
    outputKey: 'période_de_référence_volume_max',
    matchers: ['période_de_référence_volume_max', 'periode_de_reference_volume_max'],
    type: 'string'
  }
]

// Définition des colonnes des préleveurs (fichier Cadres)
const CADRES_PRELEVEUR_COLUMNS = [
  {
    key: 'siret',
    outputKey: 'siret',
    matchers: ['siret', 'siret_preleveur'],
    type: 'string',
    required: true
  },
  {
    key: 'raisonSociale',
    outputKey: 'raison_sociale',
    matchers: ['raison_sociale'],
    type: 'string'
  }
]

// Définition des colonnes des données dynamiques (fichier Prelevements)
const PRELEVEMENTS_COLUMNS = {
  codeInspection: {
    key: 'codeInspection',
    outputKey: 'code_aiot',
    matchers: ['code_inspection', 'code_aiot'],
    type: 'string',
    required: true
  },
  pointSurveillance: {
    key: 'pointSurveillance',
    outputKey: 'id_point_de_prelevement_ou_rejet',
    matchers: ['point_de_surveillance', 'point_surveillance'],
    type: 'string',
    required: true
  },
  typePoint: {
    key: 'typePoint',
    outputKey: 'type_de_point',
    matchers: ['type_de_point', 'point_de_surveillance', 'type_point'],
    type: 'string'
  },
  dateMesure: {
    key: 'dateMesure',
    outputKey: 'date_de_mesure',
    matchers: ['date_de_mesure', 'date_mesure'],
    type: 'string',
    required: true
  },
  volume: {
    key: 'volume',
    outputKey: 'volume_m3',
    matchers: ['volume_(m3)', 'volume_m3', 'volume'],
    type: 'number',
    required: true
  }
}

// Mapping des fréquences vers multiplicateurs annuels
const FREQUENCY_TO_MULTIPLIER = {
  'journalière': 365,
  'mensuelle': 12,
  'annuelle': 1
}


/**
 * Calcule le volume annuel maximum à partir du volume limite et de la période de référence
 * @param {number|null} volumeLimite - Volume limite en m³
 * @param {string|null} periodeReference - Période de référence (Journalière, Mensuelle, Annuelle)
 * @returns {number|null}
 */
function computeMaxAnnualVolume(volumeLimite, periodeReference) {
  if (volumeLimite === null || volumeLimite === undefined || Number.isNaN(volumeLimite)) {
    return null
  }

  if (!periodeReference || typeof periodeReference !== 'string') {
    return null
  }

  const normalized = periodeReference.toLowerCase().trim()
  const multiplier = FREQUENCY_TO_MULTIPLIER[normalized]
  
  if (!multiplier) {
    return null
  }

  return multiplier * volumeLimite
}

/**
 * Extrait le code meso depuis la colonne précision_milieu
 * Format attendu: "Alluvions de la Plaine de Bièvre-Valloire (FRDG303)" -> "FRDG303"
 * @param {string|null} precisionMilieu - Valeur de la colonne précision_milieu
 * @returns {string|null}
 */
function extractCodeMeso(precisionMilieu) {
  if (!precisionMilieu || typeof precisionMilieu !== 'string') {
    return null
  }

  const match = precisionMilieu.match(/\(([^)]+)\)/)
  return match ? match[1].trim() : null
}

/**
 * Normalise le nom de colonne pour la comparaison
 * @param {string} headerValue - Valeur de l'en-tête
 * @returns {string}
 */
function normalizeColumnName(headerValue) {
  return headerValue.toLowerCase().trim().replace(/\s+/g, '_')
}

/**
 * Extrait les données GIDAF depuis deux fichiers Excel
 * @param {Buffer|Object} cadresBufferOrOptions - Buffer du fichier Cadres ou objet avec {cadresBuffer, prelevementsBuffer}
 * @param {Buffer} [prelevementsBuffer] - Buffer du fichier Prelevements (si premier paramètre est un buffer)
 * @returns {Promise<{errors: Array, data: {series: Array, metadata: Object}}>}
 */
export async function extractGidaf(cadresBufferOrOptions, prelevementsBuffer) {
  const errors = []
  const data = {}

  // Gérer les deux formats d'appel:
  // 1. extractGidaf({cadresBuffer, prelevementsBuffer})
  // 2. extractGidaf(cadresBuffer, prelevementsBuffer)
  let cadresBuffer
  let prelevementsBufferFinal

  // Vérifier si c'est un objet avec les propriétés cadresBuffer et prelevementsBuffer
  // (mais pas un ArrayBuffer, TypedArray, ou autre type de buffer natif)
  const isArrayBuffer = cadresBufferOrOptions instanceof ArrayBuffer
  const isTypedArray = cadresBufferOrOptions && typeof cadresBufferOrOptions === 'object' && ArrayBuffer.isView && ArrayBuffer.isView(cadresBufferOrOptions)
  const hasBufferProperties = cadresBufferOrOptions && typeof cadresBufferOrOptions === 'object' && ('cadresBuffer' in cadresBufferOrOptions || 'prelevementsBuffer' in cadresBufferOrOptions)
  
  const isOptionsObject = !isArrayBuffer && !isTypedArray && hasBufferProperties

  if (isOptionsObject) {
    // Format objet
    cadresBuffer = cadresBufferOrOptions.cadresBuffer
    prelevementsBufferFinal = cadresBufferOrOptions.prelevementsBuffer
  } else {
    // Format deux paramètres
    cadresBuffer = cadresBufferOrOptions
    prelevementsBufferFinal = prelevementsBuffer
  }

  // Valider que les deux buffers sont fournis
  // Vérifier aussi qu'ils ne sont pas vides (byteLength > 0)
  if (!cadresBuffer) {
    console.error('GIDAF: cadresBuffer est null/undefined', {
      cadresBufferOrOptions,
      isOptionsObject,
      cadresBuffer
    })
    return {
      errors: [{message: 'Le fichier "Cadres" est requis.', severity: 'error'}],
      data: {series: []}
    }
  }

  if (cadresBuffer.byteLength !== undefined && cadresBuffer.byteLength === 0) {
    console.error('GIDAF: cadresBuffer est vide', {cadresBuffer})
    return {
      errors: [{message: 'Le fichier "Cadres" est vide.', severity: 'error'}],
      data: {series: []}
    }
  }

  if (!prelevementsBufferFinal) {
    console.error('GIDAF: prelevementsBufferFinal est null/undefined', {
      prelevementsBuffer,
      prelevementsBufferFinal
    })
    return {
      errors: [{message: 'Le fichier "Prelevements" est requis.', severity: 'error'}],
      data: {series: []}
    }
  }

  if (prelevementsBufferFinal.byteLength !== undefined && prelevementsBufferFinal.byteLength === 0) {
    console.error('GIDAF: prelevementsBufferFinal est vide', {prelevementsBufferFinal})
    return {
      errors: [{message: 'Le fichier "Prelevements" est vide.', severity: 'error'}],
      data: {series: []}
    }
  }

  // Traiter le fichier Cadres (métadonnées)
  let cadresWorkbook
  try {
    cadresWorkbook = await readSheet(cadresBuffer)
  } catch (error) {
    return {
      errors: [formatError(error)],
      data: {series: []}
    }
  }

  if (!cadresWorkbook.SheetNames || cadresWorkbook.SheetNames.length === 0) {
    return {
      errors: [{message: 'Le fichier "Cadres" est vide ou ne contient pas de feuille.', severity: 'error'}],
      data: {series: []}
    }
  }

  // Prendre la première feuille du fichier Cadres
  const cadresSheet = cadresWorkbook.Sheets[cadresWorkbook.SheetNames[0]]
  const cadresResult = validateAndExtractCadres(cadresSheet)
  errors.push(...cadresResult.errors)
  data.metadata = cadresResult.data

  // Traiter le fichier Prelevements (données dynamiques)
  let prelevementsWorkbook
  try {
    prelevementsWorkbook = await readSheet(prelevementsBufferFinal)
  } catch (error) {
    errors.push(formatError(error))
    return {
      errors: errors.map(e => formatError(e)),
      data: {series: []}
    }
  }

  if (!prelevementsWorkbook.SheetNames || prelevementsWorkbook.SheetNames.length === 0) {
    errors.push({
      message: 'Le fichier "Prelevements" est vide ou ne contient pas de feuille.',
      severity: 'error'
    })
    return {
      errors: errors.map(e => formatError(e)),
      data: {series: []}
    }
  }

  // Prendre la première feuille du fichier Prelevements
  const prelevementsSheet = prelevementsWorkbook.Sheets[prelevementsWorkbook.SheetNames[0]]
  const prelevementsResult = validateAndExtractPrelevements(prelevementsSheet, errors)
  errors.push(...prelevementsResult.errors)
  data.volumeData = prelevementsResult.data

  // Consolider les données en séries
  let consolidatedData
  try {
    consolidatedData = consolidateData(data)
  } catch (error) {
    errors.push({message: error.message, severity: 'error'})
    consolidatedData = {series: []}
  }

  const result = {
    rawData: data,
    data: consolidatedData,
    errors: errors.map(e => formatError(e))
  }

  return result
}

function validateAndExtractCadres(sheet) {
  const data = {
    pointsPrelevement: [],
    preleveurs: []
  }
  const errors = []

  if (!sheet['!ref']) {
    errors.push({
      message: 'La feuille du fichier "Cadres" est vide.',
      severity: 'error'
    })
    return {data, errors}
  }

  const range = XLSX.utils.decode_range(sheet['!ref'])
  
  // Trouver la ligne d'en-tête
  const headerRow = findCadresHeaderRow(sheet, range, errors)
  if (headerRow === -1) {
    return {data, errors}
  }

  // Mapper les colonnes
  const columnMap = mapCadresColumns(sheet, headerRow, range, errors)
  if (Object.keys(columnMap).length === 0) {
    return {data, errors}
  }

  // Extraire les points de prélèvement
  const pointsData = extractCadresPoints(sheet, headerRow, range, columnMap, errors)
  data.pointsPrelevement = pointsData.points

  // Extraire les préleveurs
  const preleveursData = extractCadresPreleveurs(sheet, headerRow, range, columnMap, errors)
  data.preleveurs = preleveursData.preleveurs

  return {data, errors}
}

function findCadresHeaderRow(sheet, range, errors) {
  const possibleHeaders = [
    'code_inspection',
    'code_aiot',
    'coordonnées_x',
    'coordonnees_x',
    'type_de_point',
    'siret'
  ]

  for (let r = 0; r <= Math.min(10, range.e.r); r++) {
    const rowValues = []
    for (let c = 0; c <= range.e.c; c++) {
      const cellValue = readAsString(sheet, r, c) || ''
      rowValues.push(normalizeColumnName(cellValue))
    }

    const hasHeader = possibleHeaders.some(header => {
      return rowValues.some(val => val === header || val.includes(header))
    })

    if (hasHeader) {
      return r
    }
  }

  errors.push({
    message: 'Impossible de trouver la ligne d\'en-tête dans le fichier "Cadres".',
    severity: 'error'
  })

  return -1
}

function mapCadresColumns(sheet, headerRow, range, errors) {
  const columnMap = {}

  for (let c = 0; c <= range.e.c; c++) {
    const headerValue = readAsString(sheet, headerRow, c) || ''
    const normalized = normalizeColumnName(headerValue)

    // Mapper les colonnes des points de prélèvement
    for (const colDef of CADRES_POINT_COLUMNS) {
      if (columnMap[colDef.key] === undefined) {
        const matches = colDef.matchers.some(matcher =>
          normalized === matcher || normalized.includes(matcher)
        )
        if (matches) {
          columnMap[colDef.key] = c
        }
      }
    }

    // Mapper les colonnes des préleveurs
    for (const colDef of CADRES_PRELEVEUR_COLUMNS) {
      if (columnMap[colDef.key] === undefined) {
        const matches = colDef.matchers.some(matcher =>
          normalized === matcher || normalized.includes(matcher)
        )
        if (matches) {
          columnMap[colDef.key] = c
        }
      }
    }
  }

  return columnMap
}

function extractCadresPoints(sheet, headerRow, range, columnMap, errors) {
  const points = []
  const seenPointIds = new Set()

  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const codeInspectionCol = CADRES_POINT_COLUMNS.find(col => col.key === 'codeInspection')
    const pointSurveillanceCol = CADRES_POINT_COLUMNS.find(col => col.key === 'pointSurveillance')
    const codeInspection = columnMap.codeInspection !== undefined
      ? readAsString(sheet, r, columnMap.codeInspection)
      : null
    const pointSurveillance = columnMap.pointSurveillance !== undefined
      ? readAsString(sheet, r, columnMap.pointSurveillance)
      : null

    const pointIdValue = pointSurveillance || codeInspection
    if (!pointIdValue) {
      continue
    }

    const pointIdStr = String(pointIdValue).trim()
    if (!pointIdStr || seenPointIds.has(pointIdStr)) {
      continue
    }

    seenPointIds.add(pointIdStr)

    const point = {
      [codeInspectionCol.outputKey]: codeInspection ? String(codeInspection).trim() : undefined,
      [pointSurveillanceCol.outputKey]: pointIdStr
    }

    // Extraire toutes les colonnes des points de prélèvement
    for (const colDef of CADRES_POINT_COLUMNS) {
      if (colDef.key === 'codeInspection') {
        continue // Déjà traité
      }

      if (columnMap[colDef.key] === undefined) {
        continue
      }

      let value
      if (colDef.type === 'number') {
        value = readAsNumber(sheet, r, columnMap[colDef.key])
        if (value === null || value === undefined || Number.isNaN(value)) {
          continue
        }
      } else {
        value = readAsString(sheet, r, columnMap[colDef.key])
        if (!value) {
          continue
        }
        value = String(value).trim()
      }

      if (colDef.transform) {
        value = colDef.transform(value)
      }

      point[colDef.outputKey] = value
    }

    // Calculer le volume limite annuel si nécessaire
    if (point.volume_max_autorisé_m3 && point.période_de_référence_volume_max) {
      const volumeAnnuel = computeMaxAnnualVolume(
        point.volume_max_autorisé_m3,
        point.période_de_référence_volume_max
      )
      if (volumeAnnuel !== null) {
        point.volume_limite_m3 = volumeAnnuel
      }
    }

    // Extraire le code meso depuis précision_milieu
    if (point.précision_milieu) {
      const codeMeso = extractCodeMeso(point.précision_milieu)
      if (codeMeso) {
        point.code_meso = codeMeso
      }
    }

    // Déterminer si c'est un prélèvement ou un rejet
    if (point.type_de_point) {
      const typePointLower = String(point.type_de_point).toLowerCase()
      if (typePointLower.includes('alimentation')) {
        point.prelevement_ou_rejet = 1
        point.usage = 'prelevement ICPE'
      } else {
        point.prelevement_ou_rejet = 2
        point.usage = 'rejet'
      }
    }

    points.push(point)
  }

  return {points}
}

function extractCadresPreleveurs(sheet, headerRow, range, columnMap, errors) {
  const preleveursMap = new Map()
  const siretCol = CADRES_PRELEVEUR_COLUMNS.find(col => col.key === 'siret')

  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const siret = columnMap.siret !== undefined
      ? readAsString(sheet, r, columnMap.siret)
      : null

    if (!siret) {
      continue
    }

    const siretStr = String(siret).trim().replace(/\s+/g, '')
    if (!siretStr || siretStr.length !== 14) {
      continue
    }

    // Si on a déjà ce préleveur, on ne l'ajoute qu'une fois
    if (preleveursMap.has(siretStr)) {
      continue
    }

    const preleveur = {
      [siretCol.outputKey]: siretStr
    }

    // Extraire les autres colonnes des préleveurs
    for (const colDef of CADRES_PRELEVEUR_COLUMNS) {
      if (colDef.key === 'siret') {
        continue // Déjà traité
      }

      if (columnMap[colDef.key] === undefined) {
        continue
      }

      const value = readAsString(sheet, r, columnMap[colDef.key])
      if (!value) {
        continue
      }

      let processedValue = String(value).trim()
      if (colDef.transform) {
        processedValue = colDef.transform(processedValue)
      }

      preleveur[colDef.outputKey] = processedValue
    }

    preleveursMap.set(siretStr, preleveur)
  }

  return {preleveurs: Array.from(preleveursMap.values())}
}

function validateAndExtractPrelevements(sheet, errors) {
  const data = {rows: []}
  const result = {errors: errors, data}

  if (!sheet['!ref']) {
    result.errors.push({
      message: 'La feuille du fichier "Prelevements" est vide.',
      severity: 'error'
    })
    return result
  }

  const range = XLSX.utils.decode_range(sheet['!ref'])
  const headerRow = findPrelevementsHeaderRow(sheet, range, result.errors)

  if (headerRow === -1) {
    return result
  }

  const columnMap = mapPrelevementsColumns(sheet, headerRow, range, result.errors)
  if (Object.keys(columnMap).length < 3) {
    return result
  }

  parsePrelevementsRows(sheet, headerRow, range, columnMap, data.rows, result.errors)

  if (data.rows.length === 0) {
    result.errors.push({
      message: 'Aucune ligne de données valide trouvée dans le fichier "Prelevements".',
      severity: 'error'
    })
  }

  return result
}

function findPrelevementsHeaderRow(sheet, range, errors) {
  const requiredKeywords = ['code_inspection', 'point_de_surveillance', 'date_de_mesure', 'volume']

  for (let r = 0; r <= Math.min(10, range.e.r); r++) {
    const rowValues = []
    for (let c = 0; c <= range.e.c; c++) {
      const cellValue = readAsString(sheet, r, c) || ''
      rowValues.push(normalizeColumnName(cellValue))
    }

    const hasAllKeywords = requiredKeywords.every(keyword =>
      rowValues.some(val => val === keyword || val.includes(keyword))
    )

    if (hasAllKeywords) {
      return r
    }
  }

  errors.push({
    message: 'Impossible de trouver la ligne d\'en-tête avec les colonnes requises (code_inspection, date_de_mesure, volume) dans le fichier "Prelevements".',
    severity: 'error'
  })

  return -1
}

function mapPrelevementsColumns(sheet, headerRow, range, errors) {
  const columnMap = {}

  for (let c = 0; c <= range.e.c; c++) {
    const headerValue = readAsString(sheet, headerRow, c) || ''
    const normalized = normalizeColumnName(headerValue)

    if (columnMap.codeInspection === undefined && PRELEVEMENTS_COLUMNS.codeInspection.matchers.some(m => normalized === m || normalized.includes(m))) {
      columnMap.codeInspection = c
    } else if (columnMap.pointSurveillance === undefined && PRELEVEMENTS_COLUMNS.pointSurveillance.matchers.some(m => normalized === m || normalized.includes(m))) {
      columnMap.pointSurveillance = c
    } else if (columnMap.typePoint === undefined && PRELEVEMENTS_COLUMNS.typePoint.matchers.some(m => normalized === m || normalized.includes(m))) {
      columnMap.typePoint = c
    } else if (columnMap.dateMesure === undefined && PRELEVEMENTS_COLUMNS.dateMesure.matchers.some(m => normalized === m || normalized.includes(m))) {
      columnMap.dateMesure = c
    } else if (columnMap.volume === undefined && PRELEVEMENTS_COLUMNS.volume.matchers.some(m => normalized === m || normalized.includes(m))) {
      columnMap.volume = c
    }
  }

  // Valider que les colonnes requises sont présentes
  const missingColumns = []
  if (columnMap.codeInspection === undefined) {
    missingColumns.push('code_inspection')
  }
  if (columnMap.pointSurveillance === undefined) {
    missingColumns.push('point_de_surveillance')
  }
  if (columnMap.dateMesure === undefined) {
    missingColumns.push('date_de_mesure')
  }
  if (columnMap.volume === undefined) {
    missingColumns.push('volume')
  }

  if (missingColumns.length > 0) {
    errors.push({
      message: `Colonnes requises manquantes dans le fichier "Prelevements": ${missingColumns.join(', ')}.`,
      severity: 'error'
    })
  }

  return columnMap
}

function parsePrelevementsRows(sheet, headerRow, range, columnMap, rows, errors) {
  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const codeInspection = readAsString(sheet, r, columnMap.codeInspection)
    const pointSurveillance = columnMap.pointSurveillance !== undefined
      ? readAsString(sheet, r, columnMap.pointSurveillance)
      : null
    const typePoint = columnMap.typePoint !== undefined
      ? readAsString(sheet, r, columnMap.typePoint)
      : null
    const dateMesure = readAsString(sheet, r, columnMap.dateMesure)
    const volume = readAsNumber(sheet, r, columnMap.volume)

    if (!codeInspection && !pointSurveillance && !dateMesure) {
      continue
    }

    if (!codeInspection) {
      errors.push({
        message: `Ligne ${r + 1}: Code inspection manquant.`,
        severity: 'error'
      })
      continue
    }
    if (!pointSurveillance) {
      errors.push({
        message: `Ligne ${r + 1}: Point de surveillance manquant.`,
        severity: 'error'
      })
      continue
    }

    // Lire la date de mesure (peut être au format date Excel ou texte)
    const dateMesureValue = readAsDateString(sheet, r, columnMap.dateMesure)
    if (!dateMesureValue) {
      errors.push({
        message: `Ligne ${r + 1}: Date de mesure manquante ou invalide.`,
        severity: 'error'
      })
      continue
    }

    // Pour les données mensuelles, on utilise la date comme date de fin
    // et on calcule la date de début (premier jour du mois)
    const dateFin = dateMesureValue
    const [year, month] = dateFin.split('-').map(Number)
    const dateDebut = `${year}-${String(month).padStart(2, '0')}-01`

    if (volume === null || volume === undefined || Number.isNaN(volume)) {
      continue
    }

    let numericVolume
    try {
      numericVolume = validateNumericValue(volume)
      if (numericVolume === undefined || numericVolume === null) {
        continue
      }
    } catch (error) {
      errors.push({
        message: error.message || `Ligne ${r + 1}: Valeur numérique invalide: ${volume}`,
        explanation: error.explanation,
        severity: 'error'
      })
      continue
    }

    // Déterminer si c'est un prélèvement ou un rejet
    const typePointLower = typePoint ? String(typePoint).toLowerCase() : ''
    const isPrelevement = typePointLower.includes('alimentation')
    
    const pointIdStr = String(pointSurveillance).trim()

    rows.push({
      pointId: pointIdStr,
      dateDebut,
      dateFin,
      volumePreleve: isPrelevement ? numericVolume : 0,
      volumeRejete: !isPrelevement ? numericVolume : 0
    })
  }
}

function consolidateData(rawData) {
  const series = []
  const volumeRows = rawData.volumeData?.rows || []

  if (volumeRows.length === 0) {
    return {series}
  }

  // Grouper par point de prélèvement
  const rowsByPoint = new Map()
  for (const row of volumeRows) {
    const pointId = row.pointId
    if (!rowsByPoint.has(pointId)) {
      rowsByPoint.set(pointId, [])
    }
    rowsByPoint.get(pointId).push(row)
  }

  // Créer une série par point de prélèvement
  for (const [pointId, rows] of rowsByPoint.entries()) {
    // Agréger par date de fin : plusieurs lignes peuvent exister pour un même point et mois
    const prelevementByDate = new Map()
    const rejetByDate = new Map()

    let minDate = null
    let maxDate = null

    for (const row of rows) {
      if (!minDate || row.dateDebut < minDate) {
        minDate = row.dateDebut
      }
      if (!maxDate || row.dateFin > maxDate) {
        maxDate = row.dateFin
      }

      if (row.volumePreleve > 0) {
        const current = prelevementByDate.get(row.dateFin) || 0
        prelevementByDate.set(row.dateFin, current + row.volumePreleve)
      }

      if (row.volumeRejete > 0) {
        const current = rejetByDate.get(row.dateFin) || 0
        rejetByDate.set(row.dateFin, current + row.volumeRejete)
      }
    }

    const prelevementEntries = [...prelevementByDate.entries()]
      .map(([date, value]) => ({date, value}))
      .sort((a, b) => a.date.localeCompare(b.date))

    const rejetEntries = [...rejetByDate.entries()]
      .map(([date, value]) => ({date, value}))
      .sort((a, b) => a.date.localeCompare(b.date))

    // Créer la série pour les volumes prélevés
    if (prelevementEntries.length > 0) {
      series.push({
        pointPrelevement: pointId,
        parameter: 'Volume prélevé',
        unit: 'm³',
        frequency: '1 month',
        valueType: 'cumulative',
        minDate,
        maxDate,
        data: prelevementEntries
      })
    }

    // Créer la série pour les volumes rejetés
    if (rejetEntries.length > 0) {
      series.push({
        pointPrelevement: pointId,
        parameter: 'Volume rejeté',
        unit: 'm³',
        frequency: '1 month',
        valueType: 'cumulative',
        minDate,
        maxDate,
        data: rejetEntries
      })
    }
  }

  return {series}
}

function formatError(error) {
  const errorObj = pick(error, [
    'message',
    'explanation',
    'internalMessage',
    'severity'
  ])

  if (!errorObj.message) {
    errorObj.message = errorObj.explanation || errorObj.internalMessage || 'Erreur non spécifiée'
  }

  if (!errorObj.severity) {
    errorObj.severity = 'error'
  }

  return errorObj
}
