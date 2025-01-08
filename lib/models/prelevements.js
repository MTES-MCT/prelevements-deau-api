import {client} from '../util/postgresql.js'

export async function getPointsPrelevement() {
  const {rows} = await client.query(`
    SELECT
      *,
      ST_AsGeoJSON(ST_Transform(geom, 4326))::json AS position
    FROM prelevement.point_prelevement
  `)

  return rows
}
