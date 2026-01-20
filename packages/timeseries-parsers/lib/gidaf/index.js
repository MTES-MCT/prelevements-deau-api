import {pick} from 'lodash-es'

import {readSheet, readAsString, readAsDateString, readAsNumber} from '../xlsx.js'
import {validateNumericValue} from '../validate.js'
import * as XLSX from 'xlsx'

const CADRES_COLUMNS = [
  {key: 'codeInspection', matchers: ['code_inspection']},
  {key: 'pointSurveillance', matchers: ['point_de_surveillance']},
  {key: 'siret', matchers: ['siret']},
  {key: 'raisonSociale', matchers: ['raison_sociale']},
  {key: 'coordonneesX', matchers: ['coordonnees_x', 'coordonnées_x']},
  {key: 'coordonneesY', matchers: ['coordonnees_y', 'coordonnées_y']},
  {key: 'typePoint', matchers: ['type_de_point']},
  {key: 'milieu', matchers: ['milieu']},
  {key: 'precisionMilieu', matchers: ['precision_milieu', 'précision_milieu']},
  {key: 'periodeReference', matchers: ['periode_de_reference_volume_max', 'période_de_référence_volume_max']},
  {key: 'volumeMax', matchers: ['volume_max_autorise_(m3)', 'volume_max_autorisé_(m3)', 'volume_max_autorise', 'volume_max_autorisé']}
]

// Colonnes des mesures (volumes) issues de GIDAF.
// Si on ajoute des index de compteurs un jour, la logique devra :
// - stocker les index bruts (ou convertis) en série séparée
// - calculer les volumes par différence d'index (comme pour Aquasys)
const PRELEVEMENTS_COLUMNS = [
  {key: 'codeInspection', matchers: ['code_inspection']},
  {key: 'pointSurveillance', matchers: ['point_de_surveillance']},
  {key: 'typePoint', matchers: ['type_de_point']},
  {key: 'dateMesure', matchers: ['date_de_mesure']},
  {key: 'volume', matchers: ['volume_(m3)', 'volume_m3', 'volume']}
]

const PERIOD_MULTIPLIERS = {
  journaliere: 365,
  mensuelle: 12,
  annuelle: 1
}

function normalizeHeader(value) {
  return String(value ?? '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
}

function stripDiacritics(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function isPrelevementType(typePoint) {
  const normalized = stripDiacritics(typePoint).toLowerCase()
  return normalized.includes('alimentation')
}

function computeAnnualLimit(volumeMax, periode) {
  if (volumeMax === null || volumeMax === undefined || Number.isNaN(volumeMax)) {
    return null
  }

  const normalized = stripDiacritics(periode).toLowerCase()
  const multiplier = PERIOD_MULTIPLIERS[normalized]
  return multiplier ? volumeMax * multiplier : null
}

function extractCodeMeso(precisionMilieu) {
  if (!precisionMilieu || typeof precisionMilieu !== 'string') {
    return null
  }

  const match = precisionMilieu.match(/\(([^)]+)\)/)
  return match ? match[1].trim() : null
}

function findHeaderRow(sheet, range, requiredHeaders, errors, sheetLabel) {
  for (let r = 0; r <= Math.min(10, range.e.r); r++) {
    const rowValues = []
    for (let c = 0; c <= range.e.c; c++) {
      const cellValue = readAsString(sheet, r, c) || ''
      rowValues.push(normalizeHeader(cellValue))
    }

    const hasAll = requiredHeaders.every(header =>
      rowValues.some(value => value === header || value.includes(header))
    )

    if (hasAll) {
      return r
    }
  }

  errors.push({
    message: `Impossible de trouver la ligne d'en-tête dans le fichier "${sheetLabel}".`,
    severity: 'error'
  })

  return -1
}

function mapColumns(sheet, headerRow, range, columnDefs) {
  const columnMap = {}
  for (let c = 0; c <= range.e.c; c++) {
    const headerValue = readAsString(sheet, headerRow, c) || ''
    const normalized = normalizeHeader(headerValue)
    for (const def of columnDefs) {
      if (columnMap[def.key] !== undefined) {
        continue
      }

      if (def.matchers.some(matcher => normalized === matcher || normalized.includes(matcher))) {
        columnMap[def.key] = c
      }
    }
  }

  return columnMap
}

function readValue(sheet, rowIndex, columnMap, key, type = 'string') {
  if (columnMap[key] === undefined) {
    return null
  }

  switch (type) {
    case 'number': {
      const value = readAsNumber(sheet, rowIndex, columnMap[key])
      return value === undefined ? null : value
    }
    case 'date': {
      const value = readAsDateString(sheet, rowIndex, columnMap[key])
      return value === undefined ? null : value
    }
    case 'string':
    default: {
      const value = readAsString(sheet, rowIndex, columnMap[key])
      return value === undefined ? null : value
    }
  }
}

function pushError(errors, message) {
  errors.push({message, severity: 'error'})
}

function extractCadresData(sheet) {
  const data = {pointsPrelevement: [], preleveurs: []}
  const errors = []

  if (!sheet['!ref']) {
    pushError(errors, 'La feuille du fichier "Cadres" est vide.')
    return {data, errors}
  }

  const range = XLSX.utils.decode_range(sheet['!ref'])
  const headerRow = findHeaderRow(sheet, range, ['code_inspection', 'point_de_surveillance'], errors, 'Cadres')
  if (headerRow === -1) {
    return {data, errors}
  }

  const columnMap = mapColumns(sheet, headerRow, range, CADRES_COLUMNS)
  const seenPointIds = new Set()
  const preleveursMap = new Map()

  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const pointSurveillance = readValue(sheet, r, columnMap, 'pointSurveillance')
    const codeInspection = readValue(sheet, r, columnMap, 'codeInspection')

    if (!pointSurveillance && !codeInspection) {
      continue
    }

    const pointId = String(pointSurveillance || codeInspection).trim()
    if (!pointId || seenPointIds.has(pointId)) {
      continue
    }

    seenPointIds.add(pointId)

    const siretRaw = readValue(sheet, r, columnMap, 'siret')
    const siret = siretRaw ? String(siretRaw).trim().replace(/\s+/g, '') : null
    const raisonSociale = readValue(sheet, r, columnMap, 'raisonSociale')
    const typePoint = readValue(sheet, r, columnMap, 'typePoint')
    const milieu = readValue(sheet, r, columnMap, 'milieu')
    const precisionMilieu = readValue(sheet, r, columnMap, 'precisionMilieu')
    const coordX = readValue(sheet, r, columnMap, 'coordonneesX', 'number')
    const coordY = readValue(sheet, r, columnMap, 'coordonneesY', 'number')
    const periodeReference = readValue(sheet, r, columnMap, 'periodeReference')
    const volumeMax = readValue(sheet, r, columnMap, 'volumeMax', 'number')

    const point = {
      id_point_de_prelevement_ou_rejet: pointId,
      code_aiot: codeInspection ? String(codeInspection).trim() : undefined,
      siret: siret || null,
      raison_sociale: raisonSociale ? String(raisonSociale).trim() : undefined,
      type_de_point: typePoint ? String(typePoint).trim() : undefined,
      milieu: milieu ? String(milieu).trim() : undefined,
      précision_milieu: precisionMilieu ? String(precisionMilieu).trim() : undefined
    }

    if (coordX !== null && coordX !== undefined && !Number.isNaN(coordX)) {
      point.x_lambert93 = coordX
    }
    if (coordY !== null && coordY !== undefined && !Number.isNaN(coordY)) {
      point.y_lambert93 = coordY
    }

    if (precisionMilieu) {
      const codeMeso = extractCodeMeso(precisionMilieu)
      if (codeMeso) {
        point.code_meso = codeMeso
      }
    }

    if (volumeMax !== null && volumeMax !== undefined && !Number.isNaN(volumeMax)) {
      point.volume_max_autorisé_m3 = volumeMax
      const volumeLimite = computeAnnualLimit(volumeMax, periodeReference)
      if (volumeLimite !== null) {
        point.volume_limite_m3 = volumeLimite
      }
    }

    if (typePoint) {
      point.prelevement_ou_rejet = isPrelevementType(typePoint) ? 1 : 2
      point.usage = isPrelevementType(typePoint) ? 'prelevement ICPE' : 'rejet'
    }

    data.pointsPrelevement.push(point)

    if (siret && siret.length === 14 && !preleveursMap.has(siret)) {
      preleveursMap.set(siret, {
        siret,
        raison_sociale: raisonSociale ? String(raisonSociale).trim() : undefined
      })
    }
  }

  data.preleveurs = [...preleveursMap.values()]
  return {data, errors}
}

// Extraction des volumes GIDAF.
// Note métier : GIDAF ne fournit pas d'index aujourd'hui, uniquement des volumes.
// On conserve une structure simple pour rester compatible avec un futur ajout d'index.
function extractPrelevementsData(sheet) {
  const data = {rows: []}
  const errors = []

  if (!sheet['!ref']) {
    pushError(errors, 'La feuille du fichier "Prelevements" est vide.')
    return {data, errors}
  }

  const range = XLSX.utils.decode_range(sheet['!ref'])
  const headerRow = findHeaderRow(sheet, range, ['code_inspection', 'point_de_surveillance', 'date_de_mesure', 'volume'], errors, 'Prelevements')
  if (headerRow === -1) {
    return {data, errors}
  }

  const columnMap = mapColumns(sheet, headerRow, range, PRELEVEMENTS_COLUMNS)

  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const pointSurveillance = readValue(sheet, r, columnMap, 'pointSurveillance')
    const typePoint = readValue(sheet, r, columnMap, 'typePoint')
    const dateMesure = readValue(sheet, r, columnMap, 'dateMesure', 'date')
    const volume = readValue(sheet, r, columnMap, 'volume', 'number')

    if (!pointSurveillance && !dateMesure) {
      continue
    }

    if (!pointSurveillance || !dateMesure) {
      pushError(errors, `Ligne ${r + 1}: Point de surveillance ou date de mesure manquant(e).`)
      continue
    }

    if (volume === null || volume === undefined || Number.isNaN(volume)) {
      continue
    }

    let numericVolume
    try {
      numericVolume = validateNumericValue(volume)
    } catch (error) {
      errors.push({
        message: error.message || `Ligne ${r + 1}: Valeur numérique invalide: ${volume}`,
        explanation: error.explanation,
        severity: 'error'
      })
      continue
    }

    if (numericVolume === null || numericVolume === undefined) {
      continue
    }

    const dateFin = dateMesure
    const [year, month] = dateFin.split('-').map(Number)
    const dateDebut = `${year}-${String(month).padStart(2, '0')}-01`

    const pointId = String(pointSurveillance).trim()
    const isPrelevement = isPrelevementType(typePoint)

    data.rows.push({
      pointId,
      dateDebut,
      dateFin,
      volumePreleve: isPrelevement ? numericVolume : 0,
      volumeRejete: isPrelevement ? 0 : numericVolume
    })
  }

  if (data.rows.length === 0) {
    pushError(errors, 'Aucune ligne de données valide trouvée dans le fichier "Prelevements".')
  }

  return {data, errors}
}

// Consolidation des séries :
// - on agrège par point et par paramètre
// - la sortie est compatible avec un futur ajout d'une série d'index
//   (qui viendrait s'ajouter à `series` sans casser l'existant).
function consolidateData(rawData) {
  const series = []
  const volumeRows = rawData.volumeData?.rows || []

  if (volumeRows.length === 0) {
    return {series}
  }

  const rowsByPoint = new Map()
  for (const row of volumeRows) {
    if (!rowsByPoint.has(row.pointId)) {
      rowsByPoint.set(row.pointId, [])
    }
    rowsByPoint.get(row.pointId).push(row)
  }

  for (const [pointId, rows] of rowsByPoint.entries()) {
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
        prelevementByDate.set(row.dateFin, (prelevementByDate.get(row.dateFin) || 0) + row.volumePreleve)
      }
      if (row.volumeRejete > 0) {
        rejetByDate.set(row.dateFin, (rejetByDate.get(row.dateFin) || 0) + row.volumeRejete)
      }
    }

    const prelevementEntries = [...prelevementByDate.entries()]
      .map(([date, value]) => ({date, value}))
      .sort((a, b) => a.date.localeCompare(b.date))

    const rejetEntries = [...rejetByDate.entries()]
      .map(([date, value]) => ({date, value}))
      .sort((a, b) => a.date.localeCompare(b.date))

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

export async function extractGidaf(cadresBufferOrOptions, prelevementsBuffer) {
  let cadresBuffer
  let prelevementsBufferFinal

  const hasBufferProperties = cadresBufferOrOptions
    && typeof cadresBufferOrOptions === 'object'
    && ('cadresBuffer' in cadresBufferOrOptions || 'prelevementsBuffer' in cadresBufferOrOptions)

  if (hasBufferProperties) {
    cadresBuffer = cadresBufferOrOptions.cadresBuffer
    prelevementsBufferFinal = cadresBufferOrOptions.prelevementsBuffer
  } else {
    cadresBuffer = cadresBufferOrOptions
    prelevementsBufferFinal = prelevementsBuffer
  }

  if (!cadresBuffer) {
    return {
      errors: [{message: 'Le fichier "Cadres" est requis.', severity: 'error'}],
      data: {series: [], metadata: {pointsPrelevement: [], preleveurs: []}}
    }
  }

  if (!prelevementsBufferFinal) {
    return {
      errors: [{message: 'Le fichier "Prelevements" est requis.', severity: 'error'}],
      data: {series: [], metadata: {pointsPrelevement: [], preleveurs: []}}
    }
  }

  let cadresWorkbook
  try {
    cadresWorkbook = await readSheet(cadresBuffer)
  } catch (error) {
    return {errors: [formatError(error)], data: {series: [], metadata: {pointsPrelevement: [], preleveurs: []}}}
  }

  if (!cadresWorkbook.SheetNames || cadresWorkbook.SheetNames.length === 0) {
    return {
      errors: [{message: 'Le fichier "Cadres" est vide ou ne contient pas de feuille.', severity: 'error'}],
      data: {series: [], metadata: {pointsPrelevement: [], preleveurs: []}}
    }
  }

  let prelevementsWorkbook
  try {
    prelevementsWorkbook = await readSheet(prelevementsBufferFinal)
  } catch (error) {
    return {errors: [formatError(error)], data: {series: [], metadata: {pointsPrelevement: [], preleveurs: []}}}
  }

  if (!prelevementsWorkbook.SheetNames || prelevementsWorkbook.SheetNames.length === 0) {
    return {
      errors: [{message: 'Le fichier "Prelevements" est vide ou ne contient pas de feuille.', severity: 'error'}],
      data: {series: [], metadata: {pointsPrelevement: [], preleveurs: []}}
    }
  }

  const cadresSheet = cadresWorkbook.Sheets[cadresWorkbook.SheetNames[0]]
  const prelevementsSheet = prelevementsWorkbook.Sheets[prelevementsWorkbook.SheetNames[0]]

  const errors = []
  const cadresResult = extractCadresData(cadresSheet)
  errors.push(...cadresResult.errors)

  const prelevementsResult = extractPrelevementsData(prelevementsSheet)
  errors.push(...prelevementsResult.errors)

  const rawData = {
    metadata: cadresResult.data,
    volumeData: prelevementsResult.data
  }

  const consolidated = consolidateData(rawData)

  return {
    rawData,
    data: {
      ...consolidated,
      metadata: rawData.metadata
    },
    errors: errors.map(formatError)
  }
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

