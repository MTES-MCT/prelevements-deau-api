import test from 'ava'

import {createRoutes} from '../routes.js'

function getRoute(router, path) {
  return router.stack.find(layer => layer.route?.path === path)?.route
}

function runMiddleware(middleware, userRole) {
  return new Promise(resolve => {
    middleware({userRole}, {}, error => resolve(error ?? null))
  })
}

test('la route du flux précède la route paramétrée et exige le rôle DECLARANT', async t => {
  const router = createRoutes()
  const paths = router.stack.map(layer => layer.route?.path).filter(Boolean)
  const feedRoute = getRoute(router, '/declarations/me/feed')
  const roleMiddleware = feedRoute.stack[0].handle
  const instructorError = await runMiddleware(roleMiddleware, 'INSTRUCTOR')
  const unauthenticatedError = await runMiddleware(roleMiddleware, undefined)

  t.true(paths.indexOf('/declarations/me/feed') < paths.indexOf('/declarations/:declarationId'))
  t.is(await runMiddleware(roleMiddleware, 'DECLARANT'), null)
  t.is(instructorError.status, 403)
  t.is(unauthenticatedError.status, 401)
})
