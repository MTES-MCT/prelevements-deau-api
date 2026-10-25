import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'

export const DN_ENDPOINT = 'https://demarche.numerique.gouv.fr/api/v2/graphql'
const QUERY = await readFile(new URL('../graphql/get-demarche.graphql', import.meta.url), 'utf8')

// Historical read-only capture: this client only executes this fixed query.
export async function * fetchHistoricalDossiers({token, fetchImpl = fetch, pageSize = 30}) {
  if (!token) throw new Error('Jeton DN absent')
  let after
  const seen = new Set()
  do {
    let result
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetchImpl(DN_ENDPOINT, {method: 'POST', redirect: 'error',
        headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
        body: JSON.stringify({query: QUERY, variables: {demarcheNumber: 80149, first: pageSize,
          includeDossiers: true, includeChamps: true, includeAnotations: true,
          includeTraitements: true, includeInstructeurs: false, ...(after ? {after} : {})}}),
        signal: AbortSignal.timeout(60_000)})
      if ([429, 502, 503, 504].includes(response.status) && attempt < 3) {
        await new Promise(resolve => { setTimeout(resolve, (attempt + 1) * 1000) })
        continue
      }
      if (!response.ok) throw new Error(`Lecture DN refusée (${response.status})`)
      result = await response.json()
      if (result.errors?.length) throw new Error('Réponse GraphQL DN incomplète')
      break
    }
    const demarche = result?.data?.demarche
    if (demarche?.number !== 80149 || !Array.isArray(demarche.dossiers?.nodes)) throw new Error('Démarche DN inattendue')
    for (const dossier of demarche.dossiers.nodes) {
      if (!Number.isSafeInteger(dossier.number) || seen.has(dossier.number)) throw new Error('Pagination DN incohérente')
      seen.add(dossier.number)
      yield dossier
    }
    const page = demarche.dossiers.pageInfo
    if (!page.hasNextPage) return
    if (!page.endCursor || page.endCursor === after) throw new Error('Curseur DN bloqué')
    after = page.endCursor
  } while (after)
}

export function collectDossierFiles(value, dossierNumber, files = new Map()) {
  if (Array.isArray(value)) return value.map(item => collectDossierFiles(item, dossierNumber, files))
  if (!value || typeof value !== 'object') return value
  if (typeof value.filename === 'string' && typeof value.checksum === 'string' && typeof value.url === 'string') {
    const key = `demarche-80149/dossiers/${dossierNumber}/attachments/${createHash('sha256').update(value.checksum).digest('hex').slice(0, 8)}-${value.filename}`
    files.set(key, {...value, key})
    const {url, ...metadata} = value
    return {...metadata, storageKey: key}
  }
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'url')
    .map(([key, item]) => [key, collectDossierFiles(item, dossierNumber, files)]))
}

export async function fetchDeletedDossiers({token, fetchImpl = fetch, pending = false}) {
  if (!token) throw new Error('Jeton DN absent')
  const connection = pending ? 'pendingDeletedDossiers' : 'deletedDossiers'
  const includeFlag = pending ? 'includePendingDeletedDossiers' : 'includeDeletedDossiers'
  const firstKey = pending ? 'pendingDeletedFirst' : 'deletedFirst'
  const afterKey = pending ? 'pendingDeletedAfter' : 'deletedAfter'
  const result = []
  let after
  do {
    const response = await fetchImpl(DN_ENDPOINT, {method: 'POST', redirect: 'error',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
      body: JSON.stringify({query: QUERY, variables: {demarcheNumber: 80149, [includeFlag]: true, [firstKey]: 100,
        ...(after ? {[afterKey]: after} : {})}}), signal: AbortSignal.timeout(60000)})
    if (!response.ok) throw new Error(`Inventaire suppressions DN refusé (${response.status})`)
    const page = await response.json()
    const dossiers = page.data?.demarche?.[connection]
    if (page.errors?.length || !dossiers?.nodes) throw new Error('Inventaire suppressions DN incomplet')
    result.push(...dossiers.nodes)
    if (!dossiers.pageInfo.hasNextPage) return result
    if (!dossiers.pageInfo.endCursor || dossiers.pageInfo.endCursor === after) throw new Error('Curseur suppressions DN bloqué')
    after = dossiers.pageInfo.endCursor
  } while (after)
  return result
}
