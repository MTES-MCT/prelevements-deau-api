import proj from 'proj4'
import wkx from 'wkx'

const unprojectReunion = proj(
  '+proj=utm +zone=40 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:4326'
)

export function extractGeometry(geom) {
  const buffer = Buffer.from(geom, 'hex')
  const geometry = wkx.Geometry.parse(buffer)
  const projectedPoint = geometry.toGeoJSON()
  return {type: 'Point', coordinates: unprojectReunion.forward(projectedPoint.coordinates)}
}
