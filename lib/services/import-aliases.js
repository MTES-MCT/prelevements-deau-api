export const IMPORT_ALIAS_PROVIDER = 'pe-import-alias'

function aliasTarget(targets) {
  const ids = [...new Set(targets)]
  if (ids.length > 1 || ids.some(id => typeof id !== 'string' || !id)) throw new Error('IMPORT_ALIAS_CONFLICT')
  return ids[0]
}

function followAlias(id, targetsForId) {
  const visited = new Set()
  let current = id
  for (;;) {
    if (visited.has(current)) throw new Error('IMPORT_ALIAS_CYCLE')
    visited.add(current)
    const target = aliasTarget(targetsForId(current))
    if (!target) return current
    current = target
  }
}

// Only explicit PE merge ledgers are aliases. Provider references and retirement
// markers never create an identity shortcut, and never grant access rights.
export function createImportAliasResolver(references, {scope, points, exploitations} = {}) {
  const aliases = references.filter(ref => ref.provider === IMPORT_ALIAS_PROVIDER && ref.kind === 'POINT'
    && (scope === undefined || ref.scope === scope))
  const exploitationAliases = aliases.flatMap(ref => ref.metadata?.exploitationAliases ?? [])
  const validateTarget = (before, after, records) => {
    if (before !== after && records !== undefined && !records.some(row => row.id === after && !row.deletedAt)) {
      throw new Error('IMPORT_ALIAS_TARGET_MISSING')
    }
    return after
  }
  return {
    point(id) {
      return validateTarget(id, followAlias(id, current => aliases.filter(ref => ref.externalId === current)
        .map(ref => ref.pointPrelevementId)), points)
    },
    exploitation(id, sourceId) {
      const sourceTargets = exploitationAliases.filter(ref => sourceId && ref.sourceSourceId === sourceId).map(ref => ref.targetId)
      const resolved = followAlias(id, current => exploitationAliases.filter(ref => ref.sourceId === current).map(ref => ref.targetId))
      const targets = sourceTargets.map(target => followAlias(target, current => exploitationAliases.filter(ref => ref.sourceId === current).map(ref => ref.targetId)))
      const target = aliasTarget([...(resolved !== id || !targets.length ? [resolved] : []), ...targets])
      if (target !== id && exploitations?.some(row => row.id === id)) throw new Error('IMPORT_ALIAS_CONFLICT')
      return validateTarget(id, target, exploitations)
    }
  }
}

export async function resolvePointImportAlias(client, pointId, {scope} = {}) {
  let current = pointId
  const visited = new Set()
  for (;;) {
    if (visited.has(current) || visited.size >= 32) throw new Error('IMPORT_ALIAS_CYCLE')
    visited.add(current)
    // The next identity is only known after reading this link in the chain.
    // eslint-disable-next-line no-await-in-loop
    const refs = await client.externalReference.findMany({where: {
      provider: IMPORT_ALIAS_PROVIDER, kind: 'POINT', externalId: current, ...(scope === undefined ? {} : {scope})
    }, select: {pointPrelevementId: true}})
    const target = aliasTarget(refs.map(ref => ref.pointPrelevementId))
    if (!target) break
    current = target
  }
  if (current !== pointId) {
    const target = await client.pointPrelevement.findUnique({where: {id: current}, select: {id: true, deletedAt: true}})
    if (!target || target.deletedAt) throw new Error('IMPORT_ALIAS_TARGET_MISSING')
  }
  return current
}
