import process from 'node:process'
import pg from 'pg'

const {POSTGRES_USER, POSTGRES_HOST, POSTGRES_DB} = process.env

const {Pool} = pg

const client = new Pool({
  user: POSTGRES_USER,
  host: POSTGRES_HOST,
  port: 5432,
  database: POSTGRES_DB
})

export {client}
