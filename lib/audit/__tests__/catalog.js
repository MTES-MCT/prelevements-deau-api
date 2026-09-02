import fs from 'node:fs/promises'

import test from 'ava'

import {
  AUDIT_ACTIONS,
  findAuditAction
} from '../catalog.js'

const EXEMPT_MUTATIONS = new Set([
  'POST /admin/declaration-notifications/email-preview',
  'POST /declarations/quick/conflicts',
  'POST /points-prelevement/batch'
])
const SENSITIVE_READS = [
  '/admin/agents',
  '/admin/agents/11111111-1111-4111-8111-111111111111',
  '/admin/audit-events',
  '/admin/password-accesses',
  '/declarations/11111111-1111-4111-8111-111111111111',
  '/declarations/telemetry-sources/11111111-1111-4111-8111-111111111111',
  '/documents/11111111-1111-4111-8111-111111111111',
  '/exports/11111111-1111-4111-8111-111111111111/download',
  '/service-accounts/me/declarants',
  '/service-accounts/declarants/11111111-1111-4111-8111-111111111111/context',
  '/service-accounts/declarations/11111111-1111-4111-8111-111111111111/processing-context',
  '/sources/11111111-1111-4111-8111-111111111111',
  '/zones/11111111-1111-4111-8111-111111111111/suivi-declarations/export'
]

function extractMutationRoutes(source) {
  const routes = new Set()
  const directRoutePattern = /app\.(post|put|patch|delete)\(\s*['`]([^'`]+)['`]/g
  const chainedRoutePattern = /app\.route\(\s*['`]([^'`]+)['`]\s*\)([\s\S]*?)(?=\n\s*(?:app\.|\/\*|\/\/|return app))/g

  for (const match of source.matchAll(directRoutePattern)) {
    routes.add(`${match[1].toUpperCase()} ${match[2]}`)
  }

  for (const routeMatch of source.matchAll(chainedRoutePattern)) {
    const path = routeMatch[1]

    for (const methodMatch of routeMatch[2].matchAll(/\.(post|put|patch|delete)\(/g)) {
      routes.add(`${methodMatch[1].toUpperCase()} ${path}`)
    }
  }

  return [...routes].sort()
}

test('le catalogue possède des codes d’action uniques', t => {
  const types = AUDIT_ACTIONS.map(action => action.type)
  t.is(new Set(types).size, types.length)
})

test('toutes les routes avec effet de bord sont auditées ou explicitement exemptées', async t => {
  const routesSource = await fs.readFile(new URL('../../routes.js', import.meta.url), 'utf8')
  const missingRoutes = extractMutationRoutes(routesSource)
    .filter(route => !EXEMPT_MUTATIONS.has(route))
    .filter(route => {
      const [method, path] = route.split(' ')
      const concretePath = path.replaceAll(/:[^/]+/g, '11111111-1111-4111-8111-111111111111')
      return !findAuditAction(method, concretePath)
    })

  t.deepEqual(missingRoutes, [])
})

test('les POST de prévisualisation ne sont pas audités', t => {
  for (const route of EXEMPT_MUTATIONS) {
    const [method, path] = route.split(' ')
    t.is(findAuditAction(method, path), null)
  }
})

test('la route de détail ne capture pas les listes de déclarations', t => {
  t.is(findAuditAction('GET', '/declarations/me'), null)
  t.is(findAuditAction('GET', '/declarations/allowed-types'), null)
  t.truthy(findAuditAction('GET', '/declarations/11111111-1111-4111-8111-111111111111'))
})

test('les lectures donnant accès à des données sensibles sont auditées', t => {
  for (const path of SENSITIVE_READS) {
    t.truthy(findAuditAction('GET', path), `Route sensible non auditée : ${path}`)
  }
})

test('la mutation en masse des exploitations d’un collecteur est auditée', t => {
  const action = findAuditAction(
    'PATCH',
    '/collecteurs/11111111-1111-4111-8111-111111111111/exploitations'
  )

  t.is(action.type, 'COLLECTEUR.EXPLOITATIONS_UPDATED')
  t.is(action.target.type, 'DECLARANT')
})
