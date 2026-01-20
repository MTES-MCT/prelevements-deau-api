import {pick} from 'lodash-es'

import {readSheet} from '../xlsx.js'
import {readAsString, readAsDateString, readAsNumber} from '../xlsx.js'
import {validateNumericValue} from '../validate.js'
import {dedupe} from '../dedupe.js'
import * as XLSX from 'xlsx'

// Définition des colonnes des points de prélèvement
const POINT_COLUMNS = [
  {
    key: 'pointId',
    outputKey: 'id_point_de_prelevement_ou_rejet',
    matchers: ['id_point_de_prelevement', 'id_point_de_prelevement_ou_rejet'],
    type: 'string',
    required: true
  },
  {
    key: 'xLambert',
    outputKey: 'x_lambert93',
    matchers: ['x_lambert93', 'x_lambert'],
    type: 'number'
  },
  {
    key: 'yLambert',
    outputKey: 'y_lambert93',
    matchers: ['y_lambert93', 'y_lambert'],
    type: 'number'
  },
  {
    key: 'codeCommune',
    outputKey: 'code_INSEE',
    matchers: ['code_insee', 'code_commune'],
    type: 'string',
    transform: (val) => String(val).replace(/\.0$/, '').trim().padStart(5, '0')
  },
  {
    key: 'codeMasseEau',
    outputKey: 'code_masse_eau_européen',
    matchers: ['code_masse_eau_européen', 'code_masse_eau_europeen', 'code_masse_eau'],
    type: 'string'
  },
  {
    key: 'codeBSS',
    outputKey: 'code_BSS',
    matchers: ['code_bss'],
    type: 'string'
  },
  {
    key: 'naturePrelevement',
    outputKey: 'nature_prelevement_ou_rejet',
    matchers: ['nature_prelevement_ou_rejet', 'nature_prelevement'],
    type: 'string'
  },
  {
    key: 'typePointPrelevement',
    outputKey: 'type_point_prelevement_ou_rejet',
    matchers: ['type_point_prelevement_ou_rejet', 'type_point_prelevement'],
    type: 'string'
  },
  {
    key: 'idCompteur',
    outputKey: 'id_compteur',
    matchers: ['id_compteur'],
    type: 'string'
  },
  {
    key: 'coefficientLecture',
    outputKey: 'coefficient_de_lecture',
    matchers: ['coefficient_de_lecture', 'coefficient_lecture'],
    type: 'number'
  },
  {
    key: 'codeOPR',
    outputKey: 'code_OPR',
    matchers: ['code_opr'],
    type: 'string'
  },
  {
    key: 'codePTP',
    outputKey: 'code_PTP',
    matchers: ['code_ptp'],
    type: 'string'
  },
  {
    key: 'codeBDLISA',
    outputKey: 'code_BDLISA',
    matchers: ['code_bdlisa'],
    type: 'string'
  },
  {
    key: 'codeBDTopage',
    outputKey: 'code_BDTopage',
    matchers: ['code_bdtopage'],
    type: 'string'
  },
  {
    key: 'codeBDCarthage',
    outputKey: 'code_BDCarthage',
    matchers: ['code_bdcarthage'],
    type: 'string'
  },
  {
    key: 'codeAiot',
    outputKey: 'code_aiot',
    matchers: ['code_aiot'],
    type: 'string'
  },
  {
    key: 'codeSispea',
    outputKey: 'code_sispea',
    matchers: ['code_sispea'],
    type: 'string'
  }
]

// Définition des colonnes des préleveurs
const PRELEVEUR_COLUMNS = [
  {
    key: 'siret',
    outputKey: 'siret',
    matchers: ['siret_preleveur', 'siret'],
    type: 'string',
    required: true
  },
  {
    key: 'raisonSociale',
    outputKey: 'raison_sociale',
    matchers: ['raison_sociale_preleveur', 'raison_sociale'],
    type: 'string'
  }
]

export async function extractTemplateFile(buffer) {
  let workbook

  // Vérifie si les feuilles declaration_de_volume et point_de_prelevement sont présentes
  try {
    workbook = await readSheet(buffer)
    validateStructure(workbook)
  } catch (error) {
    return {
      errors: [formatError(error)],
      data: {series: [], metadata: {pointsPrelevement: [], preleveurs: []}}
    }
  }

  const data = {
    metadata: {pointsPrelevement: [], preleveurs: []}
  }
  const errors = []

  // Traiter la feuille de métadonnées (point_de_prelevement)
  // Cette feuille contient :
  // - Les points de prélèvement : id_point_de_prelevement_ou_rejet, x_lambert93, y_lambert93, code_INSEE,
  //   code_masse_eau_européen, code_BSS, nature_prelevement_ou_rejet, type_point_prelevement_ou_rejet,
  //   id_compteur, coefficient_de_lecture, code_OPR, code_PTP, code_BDLISA, code_BDTopage,
  //   code_BDCarthage, code_aiot, code_sispea
  // - Les préleveurs : siret_preleveur, raison_sociale_preleveur (généralement un seul par fichier)
  const metadataSheet = workbook.Sheets['point_de_prelevement']
  if (metadataSheet) {
    const metadataResult = validateAndExtractMetadata(metadataSheet)
    errors.push(...metadataResult.errors)
    data.metadata = metadataResult.data
    // Structure de data.metadata :
    // {
    //   pointsPrelevement: [{
    //     id_point_de_prelevement_ou_rejet,
    //     x_lambert93?, y_lambert93?, code_INSEE?, code_masse_eau_européen?, code_BSS?,
    //     nature_prelevement_ou_rejet?, type_point_prelevement_ou_rejet?, id_compteur?,
    //     coefficient_de_lecture?, code_OPR?, code_PTP?, code_BDLISA?, code_BDTopage?,
    //     code_BDCarthage?, code_aiot?, code_sispea?
    //   }],
    //   preleveurs: [{siret, raison_sociale?}]
    // }
  } else {
    errors.push({
      message: 'La feuille "point_de_prelevement" est optionnelle mais recommandée pour les métadonnées des points de prélèvement.',
      severity: 'warning'
    })
  }

  // Traiter la feuille de données (declaration_de_volume)
  const dataSheet = workbook.Sheets['declaration_de_volume']
  if (!dataSheet) {
    errors.push({
      message: 'La feuille "declaration_de_volume" est requise.',
      severity: 'error'
    })
    return {
      errors,
      data: {series: [], metadata: data.metadata}
    }
  }

  const dataResult = validateAndExtractData(dataSheet, errors)
  errors.push(...dataResult.errors)
  data.volumeData = dataResult.data

  // Consolider les données en séries
  let consolidatedData
  try {
    consolidatedData = consolidateData(data)
  } catch (error) {
    errors.push({message: error.message, severity: 'error'})
    consolidatedData = {series: []}
  }

  consolidatedData.metadata = data.metadata

  const result = {
    rawData: data,
    data: consolidatedData,
    errors: errors.map(e => formatError(e))
  }

  return dedupe(result)
}

function validateStructure(workbook) {
  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new Error('Le fichier est vide ou ne contient pas de feuille.')
  }

  const requiredSheets = ['declaration_de_volume', 'point_de_prelevement']
  const foundSheets = []
  const missingSheets = []

  requiredSheets.forEach(required => {
    const found = workbook.SheetNames.some(name => name.toLowerCase().trim() === required)
    if (found) {
      foundSheets.push(required)
    } else {
      missingSheets.push(required)
    }
  })

  if (missingSheets.length > 0) {
    throw new Error(
      `Feuille${missingSheets.length > 1 ? 's' : ''} ${missingSheets.map(s => `"${s}"`).join(', ')} introuvable${missingSheets.length > 1 ? 's' : ''} dans le fichier. ` +
      `Feuilles trouvées : ${foundSheets.map(s => `"${s}"`).join(', ') || 'aucune'}. ` +
      `Feuilles disponibles dans le fichier : ${workbook.SheetNames.join(', ')}.`
    )
  }
  
}

function validateAndExtractMetadata(metadataSheet) {
  const data = {
    pointsPrelevement: [],
    preleveurs: []
  }
  const errors = []

  if (!metadataSheet['!ref']) {
    errors.push({
      message: 'La feuille "point_de_prelevement" est vide.',
      severity: 'warning'
    })
    return {data, errors}
  }

  const range = XLSX.utils.decode_range(metadataSheet['!ref'])
  
  // Trouver la ligne d'en-tête
  const headerRow = findMetadataHeaderRow(metadataSheet, range, errors)
  if (headerRow === -1) {
    return {data, errors}
  }

  // Mapper les colonnes
  const columnMap = mapMetadataColumns(metadataSheet, headerRow, range, errors)
  if (Object.keys(columnMap).length === 0) {
    return {data, errors}
  }

  // Extraire les points de prélèvement
  const pointsData = extractPointsPrelevement(metadataSheet, headerRow, range, columnMap, errors)
  data.pointsPrelevement = pointsData.points

  // Extraire les préleveurs (généralement un seul, identifié par SIRET)
  const preleveursData = extractPreleveurs(metadataSheet, headerRow, range, columnMap, errors)
  data.preleveurs = preleveursData.preleveurs

  return {data, errors}
}

function findMetadataHeaderRow(sheet, range, errors) {
  // Chercher dans les 10 premières lignes
  const possibleHeaders = [
    'id_point_de_prelevement',
    'id_point_de_prelevement_ou_rejet',
    'siret_preleveur',
    'raison_sociale_preleveur'
  ]

  for (let r = 0; r <= Math.min(10, range.e.r); r++) {
    const rowValues = []
    for (let c = 0; c <= range.e.c; c++) {
      const cellValue = readAsString(sheet, r, c) || ''
      rowValues.push(cellValue.toLowerCase().trim())
    }

    // Vérifier si on trouve au moins un des headers possibles
    const hasHeader = possibleHeaders.some(header => {
      const normalizedHeader = header.replace(/_/g, ' ')
      return rowValues.some(val => val === header || val === normalizedHeader || val.includes(header))
    })

    if (hasHeader) {
      return r
    }
  }

  errors.push({
    message: 'Impossible de trouver la ligne d\'en-tête dans la feuille "point_de_prelevement".',
    severity: 'warning'
  })

  return -1
}

function mapMetadataColumns(sheet, headerRow, range, errors) {
  const columnMap = {}

  for (let c = 0; c <= range.e.c; c++) {
    const headerValue = readAsString(sheet, headerRow, c) || ''
    const normalized = normalizeColumnName(headerValue)

    // Mapper les colonnes des points de prélèvement
    for (const colDef of POINT_COLUMNS) {
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
    for (const colDef of PRELEVEUR_COLUMNS) {
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

function extractPointsPrelevement(sheet, headerRow, range, columnMap, errors) {
  const points = []
  const seenPointIds = new Set()
  const siretCol = PRELEVEUR_COLUMNS.find(col => col.key === 'siret')

  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const pointIdCol = POINT_COLUMNS.find(col => col.key === 'pointId')
    const pointId = columnMap.pointId !== undefined
      ? readAsString(sheet, r, columnMap.pointId)
      : null

    if (!pointId) {
      continue
    }

    const pointIdStr = String(pointId).trim()
    if (!pointIdStr || seenPointIds.has(pointIdStr)) {
      continue
    }

    seenPointIds.add(pointIdStr)

    const point = {
      [pointIdCol.outputKey]: pointIdStr
    }

    // Si la colonne SIRET est présente, rattacher le point au préleveur
    if (columnMap.siret !== undefined) {
      const siretValue = readAsString(sheet, r, columnMap.siret)
      if (siretValue) {
        const siretStr = String(siretValue).trim().replace(/\s+/g, '')
        if (siretStr.length === 14) {
          point[siretCol.outputKey] = siretStr
        }
      }
    }

    // Extraire toutes les colonnes des points de prélèvement
    for (const colDef of POINT_COLUMNS) {
      if (colDef.key === 'pointId') {
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

      // Appliquer la transformation si définie
      if (colDef.transform) {
        value = colDef.transform(value)
      }

      point[colDef.outputKey] = value
    }

    points.push(point)
  }

  return {points}
}

function extractPreleveurs(sheet, headerRow, range, columnMap, errors) {
  const preleveursMap = new Map()
  const siretCol = PRELEVEUR_COLUMNS.find(col => col.key === 'siret')

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
    for (const colDef of PRELEVEUR_COLUMNS) {
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

function validateAndExtractData(dataSheet, errors) {
  const data = {rows: []}
  const result = {errors: errors, data}

  if (!dataSheet['!ref']) {
    result.errors.push({
      message: 'La feuille "declaration_de_volume" est vide.',
      severity: 'error'
    })
    return result
  }

  const range = XLSX.utils.decode_range(dataSheet['!ref'])
  const headerRow = findHeaderRow(dataSheet, range, result.errors)

  if (headerRow === -1) {
    return result
  }

  const columnMap = mapColumns(dataSheet, headerRow, range, result.errors)
  if (Object.keys(columnMap).length !== 4) {
    return result
  }

  parseDataRows(dataSheet, headerRow, range, columnMap, data.rows, result.errors)

  if (data.rows.length === 0) {
    result.errors.push({
      message: 'Aucune ligne de données valide trouvée dans la feuille. Vérifiez que les colonnes id_point_de_prelevement, date_debut, date_fin et volume_preleve_m3 sont remplies.',
      severity: 'error'
    })
  }

  return result
}

function findHeaderRow(sheet, range, errors) {
  const requiredKeywords = ['id_point', 'date_debut', 'date_fin', 'volume_preleve']

  for (let r = 0; r <= Math.min(10, range.e.r); r++) {
    const rowValues = []
    for (let c = 0; c <= range.e.c; c++) {
      const cellValue = readAsString(sheet, r, c) || ''
      rowValues.push(cellValue.toLowerCase().trim())
    }

    const hasAllKeywords = requiredKeywords.every(keyword =>
      rowValues.some(val => val.includes(keyword))
    )

    if (hasAllKeywords) {
      return r
    }
  }

  const sampleHeaders = getSampleHeaders(sheet, range)
  errors.push({
    message: `Impossible de trouver la ligne d'en-tête avec les colonnes requises (id_point_de_prelevement, date_debut, date_fin, volume_preleve_m3). ${sampleHeaders.length > 0 ? `Premières lignes: ${sampleHeaders.join('; ')}` : ''}`,
    severity: 'error'
  })

  return -1
}

function getSampleHeaders(sheet, range) {
  const sampleHeaders = []
  for (let r = 0; r <= Math.min(3, range.e.r); r++) {
    const rowValues = []
    for (let c = 0; c <= Math.min(5, range.e.c); c++) {
      const cellValue = readAsString(sheet, r, c) || ''
      if (cellValue) rowValues.push(cellValue)
    }
    if (rowValues.length > 0) {
      sampleHeaders.push(`Ligne ${r + 1}: ${rowValues.join(', ')}`)
    }
  }
  return sampleHeaders
}

function mapColumns(sheet, headerRow, range, errors) {
  const columnMap = {}
  const foundColumns = []

  for (let c = 0; c <= range.e.c; c++) {
    const headerValue = readAsString(sheet, headerRow, c) || ''
    const normalized = normalizeColumnName(headerValue)
    foundColumns.push(headerValue || '(vide)')

    if (columnMap.pointId === undefined && matchesPointIdColumn(normalized)) {
      columnMap.pointId = c
    } else if (columnMap.dateDebut === undefined && matchesDateDebutColumn(normalized)) {
      columnMap.dateDebut = c
    } else if (columnMap.dateFin === undefined && matchesDateFinColumn(normalized)) {
      columnMap.dateFin = c
    } else if (columnMap.volume === undefined && matchesVolumeColumn(normalized)) {
      columnMap.volume = c
    }
  }

  validateColumnMapping(columnMap, foundColumns, headerRow, errors)

  return columnMap
}

function normalizeColumnName(headerValue) {
  return headerValue.toLowerCase().trim().replace(/\s+/g, '_')
}

function matchesPointIdColumn(normalized) {
  return normalized === 'id_point_de_prelevement' ||
         normalized === 'id_point_de_prelevement_ou_rejet' ||
         normalized.includes('id_point_de_prelevement_ou_rejet') ||
         (normalized.includes('id_point') && normalized.includes('prelevement'))
}

function matchesDateDebutColumn(normalized) {
  return normalized === 'date_debut' ||
         normalized === 'date_de_but' ||
         (normalized.includes('date') && normalized.includes('debut'))
}

function matchesDateFinColumn(normalized) {
  return normalized === 'date_fin' ||
         (normalized.includes('date') && normalized.includes('fin'))
}

function matchesVolumeColumn(normalized) {
  return normalized.includes('volume_preleve_m3') ||
         (normalized.includes('volume') && normalized.includes('preleve') && !normalized.includes('rejete'))
}

function validateColumnMapping(columnMap, foundColumns, headerRow, errors) {
  const missingColumns = []
  if (columnMap.pointId === undefined) {
    missingColumns.push('id_point_de_prelevement (ou id_point_de_prelevement_ou_rejet)')
  }
  if (columnMap.dateDebut === undefined) missingColumns.push('date_debut')
  if (columnMap.dateFin === undefined) missingColumns.push('date_fin')
  if (columnMap.volume === undefined) missingColumns.push('volume_preleve_m3')

  if (missingColumns.length > 0) {
    const foundColumnsList = foundColumns.filter(c => c !== '(vide)')
    const errorMessage = foundColumnsList.length > 0
      ? `Colonnes requises manquantes : ${missingColumns.join(', ')}. Colonnes trouvées dans la ligne ${headerRow + 1} : ${foundColumnsList.join(', ')}.`
      : `Colonnes requises manquantes : ${missingColumns.join(', ')}. Aucune colonne trouvée dans la ligne ${headerRow + 1}.`

    errors.push({
      message: errorMessage,
      severity: 'error'
    })
  }
}

function parseDataRows(sheet, headerRow, range, columnMap, rows, errors) {
  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const pointId = readAsString(sheet, r, columnMap.pointId)
    const dateDebut = readAsDateString(sheet, r, columnMap.dateDebut)
    const dateFin = readAsDateString(sheet, r, columnMap.dateFin)
    const volume = readAsNumber(sheet, r, columnMap.volume)

    if (!pointId && !dateDebut) {
      continue
    }

    if (!pointId) {
      errors.push({
        message: `Ligne ${r + 1}: Point de prélèvement manquant.`,
        severity: 'error'
      })
      continue
    }

    if (!dateDebut) {
      errors.push({
        message: `Ligne ${r + 1}: Date de début manquante ou invalide.`,
        severity: 'error'
      })
      continue
    }

    if (!dateFin) {
      errors.push({
        message: `Ligne ${r + 1}: Date de fin manquante ou invalide.`,
        severity: 'error'
      })
      continue
    }

    if (volume === null || volume === undefined) {
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

    // Gérer les points de prélèvement séparés par une virgule
    // Si plusieurs points partagent le volume, on divise le volume entre eux
    const pointIdStr = String(pointId).trim()
    const pointIds = pointIdStr.split(',').map(p => p.trim()).filter(Boolean)

    if (pointIds.length === 0) {
      errors.push({
        message: `Ligne ${r + 1}: Point de prélèvement manquant.`,
        severity: 'error'
      })
      continue
    }

    // Si plusieurs points, diviser le volume entre eux
    const volumePerPoint = pointIds.length > 1 ? numericVolume / pointIds.length : numericVolume

    // Créer une entrée par point de prélèvement
    for (const singlePointId of pointIds) {
      rows.push({
        pointId: singlePointId,
        dateDebut,
        dateFin,
        volume: volumePerPoint
      })
    }
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
  // Pour template-file, on garde les données telles qu'elles sont (mensuelles)
  // sans créer d'entrées quotidiennes artificielles
  for (const [pointId, rows] of rowsByPoint.entries()) {
    const dataEntries = []
    let minDate = null
    let maxDate = null

    for (const row of rows) {
      // Pour template-file, on crée une entrée par ligne avec la date de fin
      // (plus logique pour des données mensuelles : le volume est prélevé jusqu'à cette date)
      const entry = {
        date: row.dateFin,
        value: row.volume
      }
      dataEntries.push(entry)

      if (!minDate || row.dateDebut < minDate) {
        minDate = row.dateDebut
      }
      if (!maxDate || row.dateFin > maxDate) {
        maxDate = row.dateFin
      }
    }

    if (dataEntries.length === 0) {
      continue
    }

    // Trier par date
    dataEntries.sort((a, b) => a.date.localeCompare(b.date))

    series.push({
      pointPrelevement: pointId,
      parameter: 'Volume prélevé',
      unit: 'm³',
      frequency: '1 day',
      valueType: 'cumulative',
      minDate,
      maxDate,
      data: dataEntries
    })
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
