import {Buffer} from 'node:buffer'
import test from 'ava'
import {parse} from 'csv-parse/sync'
import {ObjectId} from 'mongodb'
import {getCommune} from '../cog.js'

test('CSV 7 conserve les identifiants, accents, guillemets et champs multiligne des imports', t => {
  const rows = parse(Buffer.from('\uFEFFcode;nom;commentaire\r\n001;"Établissement; Dupont";"ligne 1\nligne ""2"""\r\n'), {
    bom: true, columns: true, delimiter: ';', skip_empty_lines: true
  })
  t.deepEqual(rows, [{code: '001', nom: 'Établissement; Dupont', commentaire: 'ligne 1\nligne "2"'}])
})

test('CSV 7 refuse une ligne incomplète et ne pollue pas les prototypes via les en-têtes', t => {
  t.throws(() => parse('code;nom\n001\n', {columns: true, delimiter: ';'}), {code: 'CSV_RECORD_INCONSISTENT_COLUMNS'})
  const rows = parse('__proto__;code\npollution;001', {columns: true, delimiter: ';'})
  t.is(rows[0].code, '001')
  t.is(Object.getPrototypeOf(rows[0]), Object.prototype)
  t.false(Object.hasOwn(Object.prototype, 'pollution'))
})

test('le référentiel COG 6 conserve les champs utilisés et les codes alphanumériques', t => {
  const vienne = getCommune('38544')
  t.is(vienne.nom, 'Vienne')
  t.is(vienne.departement, '38')
  t.is(vienne.region, '84')
  t.true(vienne.codesPostaux.includes('38200'))
  t.is(getCommune('2A004').departement, '2A')
  t.is(getCommune('inconnu'), undefined)
})

test('MongoDB 7 conserve les identifiants des outils de lecture historiques sans connexion', t => {
  const id = new ObjectId('507f1f77bcf86cd799439011')
  t.is(id.toHexString(), '507f1f77bcf86cd799439011')
  const json = JSON.stringify({id})
  t.deepEqual(JSON.parse(json), {id: '507f1f77bcf86cd799439011'})
  t.false(ObjectId.isValid('invalid-id'))
})
