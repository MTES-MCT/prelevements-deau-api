

export async function extractAquasys(buffer) {
  
  }

  // Vérifier les colonnes requises
  const requiredColumns = AQUASYS_COLUMNS.filter(col => col.required)
  const missingColumns = requiredColumns.filter(col => columnMap[col.key] === undefined)

  if (missingColumns.length > 0) {
    errors.push({
      message: `Colonnes requises manquantes : ${missingColumns.map(col => col.key).join(', ')}.`,
      severity: 'error'
    })
  }

  return columnMap
}

function parseDynamicSheet(sheet, errors) {
  const range = XLSX.utils.decode_range(sheet['!ref'])
  const rows = []

  // Trouver la ligne d'en-tête
  const headerRow = findHeaderRow(sheet, range, errors)
  if (headerRow === -1) {
    return {rows: []}
  }

  // Mapper les colonnes
  const columnMap = mapColumns(sheet, headerRow, range, errors)
  if (errors.some(e => e.severity === 'error')) {
    return {rows: []}
  }

  // Lire les données
  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const row = extractRow(sheet, r, columnMap, errors)
    if (row) {
      rows.push(row)
    }
  }

  return {rows}
}

function extractRow(sheet, rowIndex, columnMap, errors) {
  // Extraire les valeurs selon les définitions de colonnes
  const values = {}
  let hasRequiredData = false

  for (const colDef of AQUASYS_COLUMNS) {
    if (columnMap[colDef.key] === undefined) {
      if (colDef.defaultValue !== undefined) {
        values[colDef.key] = colDef.defaultValue
      }
      continue
    }

    let value
    if (colDef.type === 'date') {
      value = readAsDateString(sheet, rowIndex, columnMap[colDef.key])
    } else if (colDef.type === 'number') {
      value = readAsNumber(sheet, rowIndex, columnMap[colDef.key])
      if (value === null || value === undefined || Number.isNaN(value)) {
        if (colDef.defaultValue !== undefined) {
          value = colDef.defaultValue
        } else {
          continue
        }
      }
    } else {
      value = readAsString(sheet, rowIndex, columnMap[colDef.key])
      if (value) {
        value = String(value).trim()
      }
    }

    values[colDef.key] = value

    if (colDef.required && value) {
      hasRequiredData = true
    }
  }

  // Vérifier les données requises
  if (!values.pointId && !values.dateMesure) {
    return null // Ligne vide
  }

  if (!values.pointId) {
    errors.push({
      message: `Ligne ${rowIndex + 1}: Point de prélèvement manquant.`,
      severity: 'error'
    })
    return null
  }

  if (!values.dateMesure) {
    errors.push({
      message: `Ligne ${rowIndex + 1}: Date de mesure manquante ou invalide.`,
      severity: 'error'
    })
    return null
  }

  if (values.mesure === null || values.mesure === undefined) {
    return null // Mesure manquante
  }

  const validation = validateNumericValue(values.mesure, `Ligne ${rowIndex + 1}`)
  if (!validation.valid) {
    errors.push({
      message: validation.message,
      severity: 'error'
    })
    return null
  }

  // Calculer le volume selon le type (Index ou Volume)
  let volume = null
  const indexOuVolume = values.indexOuVolume || ''
  if (indexOuVolume.toLowerCase().includes('volume')) {
    volume = validation.value
  } else {
    // Pour les index, on ne peut pas calculer le volume sans l'index précédent
    // On stocke la mesure pour traitement ultérieur
    volume = validation.value * (values.coefficient || 1)
  }

  return {
    pointId: String(values.pointId).trim(),
    dateMesure: values.dateMesure,
    mesure: validation.value,
    volume,
    coefficient: values.coefficient || 1,
    compteur: values.compteur || null,
    isIndex: indexOuVolume.toLowerCase().includes('index')
  }
}

function consolidateData(parsedData, errors) {
  const seriesMap = new Map()

  // Séparer les données par index et volume
  const indexRows = parsedData.rows.filter(r => r.isIndex)
  const volumeRows = parsedData.rows.filter(r => !r.isIndex)

  // Traiter les volumes directs
  for (const row of volumeRows) {
    const key = `${row.pointId}_${row.compteur || 'default'}`
    if (!seriesMap.has(key)) {
      seriesMap.set(key, {
        pointPrelevement: row.pointId,
        parameter: 'Volume prélevé',
        unit: 'm³',
        frequency: '1 day',
        valueType: 'cumulative',
        data: [],
        minDate: null,
        maxDate: null
      })
    }

    const serie = seriesMap.get(key)
    serie.data.push({
      date: row.dateMesure,
      value: row.volume
    })

    if (!serie.minDate || row.dateMesure < serie.minDate) {
      serie.minDate = row.dateMesure
    }
    if (!serie.maxDate || row.dateMesure > serie.maxDate) {
      serie.maxDate = row.dateMesure
    }
  }

  // Traiter les index (calculer les différences)
  const indexByKey = new Map()
  for (const row of indexRows) {
    const key = `${row.pointId}_${row.compteur || 'default'}`
    
    if (!indexByKey.has(key)) {
      indexByKey.set(key, [])
    }
    indexByKey.get(key).push(row)
  }

  for (const [key, rows] of indexByKey.entries()) {
    // Trier par date
    rows.sort((a, b) => a.dateMesure.localeCompare(b.dateMesure))

    if (!seriesMap.has(key)) {
      const firstRow = rows[0]
      seriesMap.set(key, {
        pointPrelevement: firstRow.pointId,
        parameter: 'Volume prélevé',
        unit: 'm³',
        frequency: '1 day',
        valueType: 'cumulative',
        data: [],
        minDate: null,
        maxDate: null
      })
    }

    const serie = seriesMap.get(key)

    // Calculer les volumes à partir des différences d'index
    for (let i = 0; i < rows.length; i++) {
      const currentRow = rows[i]
      let volume = null

      if (i === 0) {
        // Premier index : on ne peut pas calculer de volume
        continue
      }

      const previousRow = rows[i - 1]
      const diff = currentRow.mesure - previousRow.mesure

      if (diff >= 0) {
        volume = diff * currentRow.coefficient
      } else {
        // Remise à zéro du compteur
        volume = currentRow.mesure * currentRow.coefficient
      }

      if (volume !== null && volume >= 0) {
        serie.data.push({
          date: currentRow.dateMesure,
          value: volume
        })

        if (!serie.minDate || currentRow.dateMesure < serie.minDate) {
          serie.minDate = currentRow.dateMesure
        }
        if (!serie.maxDate || currentRow.dateMesure > serie.maxDate) {
          serie.maxDate = currentRow.dateMesure
        }
      }
    }
  }

  // Trier les données par date pour chaque série
  for (const serie of seriesMap.values()) {
    serie.data.sort((a, b) => a.date.localeCompare(b.date))
  }

  return {
    series: Array.from(seriesMap.values())
  }
}

