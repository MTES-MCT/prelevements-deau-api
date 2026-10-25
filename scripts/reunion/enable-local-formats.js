#!/usr/bin/env node
import process from 'node:process'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {readManifestContent} from './lib/core.js'
import {loadEnv, createTargetPrisma, attestTargetDatabase, verifyManifestChecksum} from './lib/runtime.js'
import {accessConnectionOptions} from './lib/access-cli.js'

const FORMATS = [
  {code: 'reunion_camion_citerne', name: 'Réunion — camion citerne'},
  {code: 'reunion_multi_param', name: 'Réunion — suivi des prélèvements'}
]
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

export function localFormatScope(content) {
  const {header, records} = readManifestContent(content)
  if (header.territory !== 'DEP-974') throw new Error('Référentiel hors Réunion')
  const ids = records.filter(row => row.kind === 'declarant').map(row => row.data.id_preleveur)
  if (ids.length !== 244 || new Set(ids).size !== 244 || ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('Périmètre attendu de 244 préleveurs absent')
  return ids.map(id => `reunion:DEP-974:declarant:${id}`).sort()
}

export async function enableLocalFormats({archive, targetEnv, effectiveDate, reportFile, apply = false}) {
  process.umask(0o077)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) throw new Error('Date d’effet obligatoire')
  const date = new Date(`${effectiveDate}T00:00:00Z`)
  if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== effectiveDate) throw new Error('Date d’effet invalide')
  const root = path.resolve(archive)
  if (!path.resolve(reportFile).startsWith(`${root}/`)) throw new Error('Rapport privé dans archive obligatoire')
  const {content: bytes} = await verifyManifestChecksum(path.join(root, 'reference/manifest.jsonl'))
  const sourceIds = localFormatScope(bytes)
  const configuration = await loadEnv(targetEnv)
  accessConnectionOptions(configuration, {target: 'local'})
  const {prisma, close} = await createTargetPrisma(configuration.DATABASE_URL)
  try {
    await attestTargetDatabase(prisma, 'local')
    const run = async tx => {
      const accounts = await tx.declarant.findMany({where: {sourceId: {in: sourceIds}, user: {deletedAt: null, role: 'DECLARANT'}}, select: {userId: true, sourceId: true}})
      if (accounts.length !== 244) throw new Error('Les 244 préleveurs actifs ne sont pas tous présents')
      const ids = accounts.map(item => item.userId)
      const outsideWhere = {OR: [{declarantUserId: {notIn: ids}}, {declarationType: {code: {notIn: FORMATS.map(format => format.code)}}}]}
      const beforeOther = await tx.declarantDeclarationType.findMany({where: outsideWhere, orderBy: {id: 'asc'}})
      const activeWhere = {declarantUserId: {in: ids}, declarationType: {code: {in: FORMATS.map(format => format.code)}},
        AND: [{OR: [{startDate: null}, {startDate: {lte: date}}]}, {OR: [{endDate: null}, {endDate: {gte: date}}]}]}
      const existing = await tx.declarantDeclarationType.findMany({where: activeWhere, include: {declarationType: true}})
      if (existing.some(link => !link.declarationType.isAvailable)) throw new Error('Format existant indisponible')
      const seen = new Set()
      for (const link of existing) {
        const key = `${link.declarantUserId}/${link.declarationType.code}`
        if (seen.has(key)) throw new Error('Doublon actif de format existant')
        seen.add(key)
      }
      const additions = accounts.flatMap(account => FORMATS.filter(format => !seen.has(`${account.userId}/${format.code}`))
        .map(format => ({sourceId: account.sourceId, declarantUserId: account.userId, code: format.code})))
      if (apply) {
        for (const format of FORMATS) {
          const type = await tx.declarationType.upsert({where: {code: format.code}, create: format, update: {}})
          if (!type.isAvailable) throw new Error('Format existant indisponible')
          for (const addition of additions.filter(item => item.code === format.code)) {
            await tx.declarantDeclarationType.create({data: {declarantUserId: addition.declarantUserId, declarationTypeId: type.id, startDate: date}})
          }
        }
        if (await tx.declarantDeclarationType.count({where: activeWhere}) !== 488) throw new Error('488 liens actifs attendus')
        const afterOther = await tx.declarantDeclarationType.findMany({where: outsideWhere, orderBy: {id: 'asc'}})
        if (digest(JSON.stringify(beforeOther)) !== digest(JSON.stringify(afterOther))) throw new Error('Autres formats modifiés')
      }
      return {preleveurs: accounts.length, activeBefore: existing.length, additions, activeAfter: apply ? 488 : existing.length + additions.length,
        unrelatedFormatsSha256: digest(JSON.stringify(beforeOther)), verified: apply}
    }
    const result = apply ? await prisma.$transaction(run, {timeout: 120000}) : await run(prisma)
    const report = {createdAt: new Date().toISOString(), target: 'local', apply, effectiveDate, referenceSha256: digest(bytes), ...result}
    await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx', mode: 0o600})
    console.log(JSON.stringify({stage: 'reunion-formats', apply, preleveurs: result.preleveurs, changes: result.additions.length, activeAfter: result.activeAfter, verified: result.verified}))
    return report
  } finally { await close() }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const {values} = parseArgs({options: {archive: {type: 'string'}, 'target-env': {type: 'string'}, 'effective-date': {type: 'string'}, report: {type: 'string'}, apply: {type: 'boolean', default: false}}})
  enableLocalFormats({archive: values.archive, targetEnv: values['target-env'], effectiveDate: values['effective-date'], reportFile: values.report, apply: values.apply})
    .catch(error => { console.error(JSON.stringify({stage: 'reunion-formats-failed', error: error.name, code: error.code ?? null, message: error.message})); process.exitCode = 1 })
}
