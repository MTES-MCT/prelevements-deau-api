import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {promisify} from 'node:util'
import test from 'ava'
import {ZONE_PERMISSION_CATALOG, ZONE_PERMISSION_CODES, READ_ONLY_ZONE_PERMISSIONS} from '../../../lib/constants/zone-permissions.js'
import {loadAccessSource, parseAccessRows} from '../lib/access-source.js'

const runFile = promisify(execFile)
const source = {sha256: '1'.repeat(64), name: 'synthetic-access.ods'}
const effectiveDate = '2026-10-05'
const headers = ['territoire', 'profil', 'structure', 'service', 'prénom', 'nom', 'mail', 'fonction', 'statut', 'date_ouverture_droits', 'date_fermeture_droits', 'remarque', 'envoi_mail_info', 'rôle Partageons l’eau', 'Détail']
const readCodes = [
  'zone.detail.read', 'zone.geometry.read', 'zone.dashboard.read', 'zone.resource.list',
  'zone.declaration.settings.read', 'declaration.list', 'declaration.detail.read',
  'declaration.file.download', 'declaration.followup.read', 'pp.list', 'pp.map.read',
  'pp.export', 'pp.detail.read', 'pp.volumes.read', 'exploitation.list',
  'exploitation.export', 'exploitation.detail.read', 'declarant.list', 'declarant.export',
  'declarant.detail.read', 'declarant.volumes.read', 'declarant.rule.read',
  'declarant.document.read', 'zone.agent.list', 'zone.agent.detail.read', 'export.volumes'
]
const permissionRows = [
  {row: 1, cells: ['Thématique', 'Agent lecture seule']},
  ...readCodes.map((code, index) => ({row: index + 2, cells: ['', ZONE_PERMISSION_CATALOG.find(item => item.code === code).label]}))
]
const options = {source, effectiveDate, permissionRows}

function rows(...overrides) {
  return [
    {row: 1, cells: headers},
    ...overrides.map((override, index) => {
      const values = {
        territoire: 'La Réunion', profil: 'observateur', structure: 'Organisme exemple',
        prénom: 'Alex', nom: 'Exemple', mail: `contact${index}@example.test`, fonction: 'Chargé de suivi',
        statut: 'accès ouvert', date_ouverture_droits: '15/12/25',
        'rôle Partageons l’eau': 'agent', Détail: 'lecture seule', ...override
      }
      return {row: index + 2, cells: headers.map(header => values[header] ?? '')}
    })
  ]
}

test('applies the explicit target role and the 26 source permissions including exports', t => {
  const result = parseAccessRows(rows(
    {profil: 'instructeur'},
    {profil: 'observateur', 'rôle Partageons l’eau': 'déclarant', Détail: ''},
    {profil: 'préleveur'},
    {profil: 'observateur', Détail: 'lecture et écriture'}
  ), options)
  t.deepEqual(result.readPermissions, readCodes)
  t.deepEqual(result.entries.map(entry => entry.role), ['INSTRUCTOR', 'DECLARANT', 'INSTRUCTOR', 'INSTRUCTOR'])
  t.deepEqual(result.entries[0].permissions, readCodes)
  t.deepEqual(result.entries[1].permissions, [])
  t.deepEqual(result.entries[3].permissions, ZONE_PERMISSION_CODES)
  t.true(result.entries.every(entry => entry.isAdmin === false))
  t.deepEqual(result.readPermissions.filter(code => !READ_ONLY_ZONE_PERMISSIONS.includes(code)), ['pp.export', 'exploitation.export', 'declarant.export', 'export.volumes'])
  t.deepEqual(READ_ONLY_ZONE_PERMISSIONS.filter(code => !result.readPermissions.includes(code)), ['exploitation.volumes.read', 'declarant.declaration-type.read', 'declarant.email-alias.read'])
  t.is(result.summary.open, 4)
  t.is(result.summary.readOnlyAgents, 2)
  t.is(result.summary.writeAgents, 1)
  t.is(result.summary.declarants, 1)
})

test('removed and closed statuses override stale roles and require precise dates', t => {
  const result = parseAccessRows(rows(
    {statut: 'ACCES A SUPPRIMER', Détail: 'inconnu'},
    {statut: 'accès supprimé', date_fermeture_droits: '03/02/26'}
  ), options)
  t.deepEqual(result.entries.map(({status, role, permissions, endDate}) => ({status, role, permissions, endDate})), [
    {status: 'REMOVE', role: null, permissions: [], endDate: effectiveDate},
    {status: 'CLOSED', role: null, permissions: [], endDate: '2026-02-03'}
  ])
  t.throws(() => parseAccessRows(rows({statut: 'accès supprimé'}), options), {message: /fermeture/u})
  t.throws(() => parseAccessRows(rows({date_fermeture_droits: '2026-02-03'}), options), {message: /Accès ouvert/u})
  t.throws(() => parseAccessRows(rows({statut: 'accès supprimé', date_fermeture_droits: '03/02/24'}), options), {message: /antérieure/u})
})

test('preserves blank identities and separate generic mailboxes without inventing names', t => {
  const result = parseAccessRows(rows(
    {prénom: '', nom: '', mail: ' Named.Contact@EXAMPLE.test ', date_ouverture_droits: ''},
    {mail: 'personal@example.test'},
    {mail: 'secretariat@example.test', territoire: ''}
  ), options)
  t.like(result.entries[0], {email: 'named.contact@example.test', firstName: '', lastName: '', startDate: effectiveDate})
  t.is(result.entries.length, 3)
  t.is(result.entries[2].sourceTerritory, '')
  t.is(result.territory, 'DEP-974')
  t.deepEqual(result.summary.warnings, [
    {code: 'MISSING_OPENING_DATE', row: 2},
    {code: 'INCOMPLETE_IDENTITY', row: 2},
    {code: 'MISSING_TERRITORY_IN_REUNION_SOURCE', row: 4},
    {code: 'SHARED_NAME_DIFFERENT_EMAILS', rows: [3, 4]}
  ])
})

test('fails closed for ambiguous territories, duplicate emails, roles and malformed dates', t => {
  t.throws(() => parseAccessRows(rows({territoire: ''}), options), {message: /exclusivement/u})
  t.throws(() => parseAccessRows(rows({}, {territoire: 'Autre territoire'}), options), {message: /exclusivement/u})
  t.throws(() => parseAccessRows(rows({mail: 'SAME@example.test'}, {mail: ' same@example.test '}), options), {message: /répétée/u})
  t.throws(() => parseAccessRows(rows({mail: 'one@example.test;two@example.test'}), options), {message: /email invalide/u})
  t.throws(() => parseAccessRows(rows({'rôle Partageons l’eau': ''}), options), {message: /Rôle cible/u})
  t.throws(() => parseAccessRows(rows({Détail: ''}), options), {message: /Droits agent/u})
  t.throws(() => parseAccessRows(rows({statut: 'en attente'}), options), {message: /Statut inconnu/u})
  t.throws(() => parseAccessRows(rows({date_ouverture_droits: '31/02/26'}), options), {message: /Date invalide/u})
  t.throws(() => parseAccessRows(rows({}), {...options, effectiveDate: undefined}), {message: /effective obligatoire/u})
})

test('requires complete unique source permission labels and binds source and permissions hashes', t => {
  const original = parseAccessRows(rows({}), options)
  t.deepEqual(parseAccessRows(rows({}), options), original)
  t.not(parseAccessRows(rows({}), {...options, effectiveDate: '2026-10-06'}).sourceHash, original.sourceHash)
  t.not(parseAccessRows(rows({}), {...options, source: {...source, sha256: '2'.repeat(64)}}).sourceHash, original.sourceHash)
  t.regex(original.permissionsHash, /^[a-f\d]{64}$/u)
  t.throws(() => parseAccessRows(rows({}), {...options, permissionRows: permissionRows.slice(0, -1)}), {message: /26 droits/u})
  t.throws(() => parseAccessRows(rows({}), {...options, permissionRows: [...permissionRows, permissionRows[1]]}), {message: /Permission inconnue ou répétée/u})
  t.throws(() => parseAccessRows(rows({}), {...options, permissionRows: [permissionRows[0], {row: 2, cells: ['', 'Permission non reconnue']}]}), {message: /Permission inconnue/u})
})

const xmlEscape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const xmlCell = value => `<table:table-cell office:value-type="string"><text:p>${xmlEscape(value)}</text:p></table:table-cell>`
const xmlRows = records => records.map(record => `<table:table-row>${record.cells.map(xmlCell).join('')}</table:table-row>`).join('')

async function createWorkbook(t, {sourceRows = rows({}), customRow, declaration = '', extraMembers = {}} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'reunion-access-test-'))
  t.teardown(() => rm(directory, {recursive: true, force: true}))
  const filename = path.join(directory, 'synthetic.ods')
  const content = `${declaration}<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:spreadsheet><table:table table:name="liste_brute">${customRow ? xmlRows([sourceRows[0]]) + customRow : xmlRows(sourceRows)}<table:table-row table:number-rows-repeated="1000000"><table:table-cell table:number-columns-repeated="65536"/></table:table-row></table:table><table:table table:name="Détail droits agent lecture seule">${xmlRows(permissionRows)}</table:table></office:spreadsheet></office:body></office:document-content>`
  const program = 'import sys, zipfile, json, os\nwith zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as archive:\n archive.writestr("mimetype", "application/vnd.oasis.opendocument.spreadsheet")\n archive.writestr("content.xml", sys.argv[2])\n for name, value in json.loads(sys.argv[3]).items(): archive.writestr(name, value)\nos.chmod(sys.argv[1], 0o600)'
  await runFile('python3', ['-c', program, filename, content, JSON.stringify(extraMembers)])
  return filename
}

test('loads ODS spans, XML whitespace, repeated cells and typed dates without using formatted date text', async t => {
  const cells = rows({})[1].cells
  const customRow = `<table:table-row>${cells.map((value, index) => {
    if (index === 3) {
      return '<table:covered-table-cell/>'
    }

    if (index === 4) {
      return '<table:table-cell><text:p><text:span>Alex</text:span><text:s text:c="2"/><text:span>Camille</text:span><text:tab/>N.</text:p></table:table-cell>'
    }

    if (index === 9) {
      return '<table:table-cell office:value-type="date" office:date-value="2025-12-15T00:00:00"><text:p>incorrect cached text</text:p></table:table-cell>'
    }

    if (index === 10) {
      return '<table:table-cell table:number-columns-repeated="3"/>'
    }

    return [11, 12].includes(index) ? '' : xmlCell(value)
  }).join('')}</table:table-row>`
  const filename = await createWorkbook(t, {customRow})
  const result = await loadAccessSource(filename, {effectiveDate})
  t.is(result.entries.length, 1)
  t.is(result.entries[0].firstName, 'Alex  Camille\tN.')
  t.is(result.entries[0].startDate, '2025-12-15')
  t.is(result.source.sha256, createHash('sha256').update(await readFile(filename)).digest('hex'))
})

test('rejects XML declarations and nonempty repeated rows that exceed the extraction limit', async t => {
  const entityFile = await createWorkbook(t, {declaration: '<!DOCTYPE test [<!ENTITY custom "value">]>'})
  await t.throwsAsync(loadAccessSource(entityFile, {effectiveDate}), {message: /Extraction/u})
  const repeatedFile = await createWorkbook(t, {customRow: '<table:table-row table:number-rows-repeated="10001"><table:table-cell><text:p>value</text:p></table:table-cell></table:table-row>'})
  await t.throwsAsync(loadAccessSource(repeatedFile, {effectiveDate}), {message: /Extraction/u})
  const expandedFile = await createWorkbook(t, {customRow: `<table:table-row table:number-rows-repeated="1000"><table:table-cell><text:p>${'x'.repeat(3000)}</text:p></table:table-cell></table:table-row>`})
  await t.throwsAsync(loadAccessSource(expandedFile, {effectiveDate}), {message: /Extraction/u})
})
