import {parse} from 'csv-parse/sync'

const CATALOGUE_URL = 'https://www.gesteau.fr/export-ptge/csv'
const DOWNLOADS_URL = 'https://www.gesteau.fr/telecharger/ptge'
const WFS_URL = 'https://maps.oieau.fr/ows/OIEau/gesteau'
const CATALOGUE_FIELDS = ['Code du PTGE', 'Nom du PTGE', "État d'avancement"]
const WGS84_NAMES = new Set(['EPSG:4326', 'urn:ogc:def:crs:EPSG::4326', 'urn:ogc:def:crs:OGC:1.3:CRS84',
  'http://www.opengis.net/def/crs/EPSG/0/4326', 'http://www.opengis.net/def/crs/OGC/1.3/CRS84'])

function readCatalogue(catalogueCsv, catalogueCount) {
  const rows = parse(catalogueCsv, {bom: true, columns: true, delimiter: ';', skip_empty_lines: true})
  if (rows.length !== catalogueCount || !catalogueCount) {
    throw new Error(`Catalogue Gest’eau incomplet : ${rows.length} fiches lues, ${catalogueCount} annoncées.`)
  }

  const records = new Map()
  for (const row of rows) {
    const [code, name, progressStatus] = CATALOGUE_FIELDS.map(field => row[field]?.trim())
    if (!code || !name || !progressStatus || records.has(code)) {
      throw new Error(`Fiche PTGE invalide ou en double : ${code ?? 'code absent'}.`)
    }
    records.set(code, {code, name, progressStatus, geometry: null})
  }
  return records
}

export function preparePtgeSnapshot({catalogueCsv, featureCollection, catalogueCount, perimeterCount}) {
  const records = readCatalogue(catalogueCsv, catalogueCount)
  const features = featureCollection?.features
  if (featureCollection?.type !== 'FeatureCollection' || !Array.isArray(features) || !perimeterCount
    || features.length !== perimeterCount) {
    throw new Error(`Couche PTGE incomplète : ${features?.length ?? 0} périmètres lus, ${perimeterCount} annoncés.`)
  }
  if (featureCollection.crs && !WGS84_NAMES.has(featureCollection.crs.properties?.name)) {
    throw new Error('Projection du GeoJSON Gest’eau différente du WGS 84 demandé.')
  }
  for (const feature of features) {
    const code = feature.properties?.code?.trim()
    const record = records.get(code)
    const geometry = feature.geometry
    if (!record || record.geometry || !['Polygon', 'MultiPolygon'].includes(geometry?.type)) {
      throw new Error(`Périmètre PTGE inconnu, invalide ou en double : ${code ?? 'code absent'}.`)
    }
    record.geometry = geometry
  }

  return [...records.values()]
}

export async function fetchPtgeSnapshot() {
  const request = {service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: 'sa:ptge_etat'}
  const hitsUrl = `${WFS_URL}?${new URLSearchParams({...request, resultType: 'hits'})}`
  const featuresUrl = `${WFS_URL}?${new URLSearchParams({...request, srsName: 'EPSG:4326', outputFormat: 'application/json; subtype=geojson'})}`
  const [catalogueCsv, totals, hits, geojson] = await Promise.all(
    [CATALOGUE_URL, DOWNLOADS_URL, hitsUrl, featuresUrl].map(async url => {
      const response = await fetch(url, {signal: AbortSignal.timeout(60_000)})
      if (!response.ok) throw new Error(`Téléchargement Gest’eau en échec (HTTP ${response.status}) : ${url}.`)
      return response.text()
    })
  )
  const catalogueCount = Number(/class=["']nb_ptge["'][^>]*>\s*(\d+)\s*</.exec(totals)?.[1])
  const perimeterCount = Number(/\bnumberMatched=["'](\d+)["']/.exec(hits)?.[1])
  return preparePtgeSnapshot({catalogueCsv, featureCollection: JSON.parse(geojson), catalogueCount, perimeterCount})
}
