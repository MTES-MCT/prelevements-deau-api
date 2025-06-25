import proj from 'proj4'
import wkx from 'wkx'

export function parseDate(value) {
  const simpleDateRegex = /^\d{4}-\d{2}-\d{2}$/
  const customDateTimeRegex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}$/

  if (simpleDateRegex.test(value)) {
    return value
  }

  if (customDateTimeRegex.test(value)) {
    return (new Date(value)).toISOString()
  }

  if (value) {
    console.warn(`Unknown date format: ${value}`)
  }
}

export function parseNomenclature(value, nomenclature) {
  if (value && !nomenclature[value]) {
    console.warn(`Valeur inconnue dans la nomenclature: ${value || 'VIDE'}`)
  }

  return nomenclature[value]
}

export function parseString(value) {
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

export function parseNumber(value) {
  return value === '' ? undefined : Number(value)
}

export function parseBoolean(value) {
  switch (value.toLowerCase()) {
    case 't': {
      return true
    }

    case 'f': {
      return false
    }

    case '': {
      return undefined
    }

    default: {
      console.warn('Valeur booléenne inconnue', value)
    }
  }
}

const unprojectReunion = proj(
  '+proj=utm +zone=40 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:4326'
)

export function parseGeometry(geom) {
  if (!geom) {
    return
  }

  let projectedPoint

  try {
    const buffer = Buffer.from(geom, 'hex')
    const geometry = wkx.Geometry.parse(buffer)
    projectedPoint = geometry.toGeoJSON()
  } catch (error) {
    throw new Error(`Erreur de parsing de la géométrie : ${error.message}`)
  }

  return {type: 'Point', coordinates: unprojectReunion.forward(projectedPoint.coordinates)}
}
