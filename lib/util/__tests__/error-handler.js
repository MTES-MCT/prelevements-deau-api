import test from 'ava'

import errorHandler from '../error-handler.js'

test.serial('errorHandler expose latestAssociationVersion dans le body d’une 412', t => {
  const previousConsoleError = console.error
  let body
  const response = {
    statusCode: null,
    status(code) {
      this.statusCode = code
      return this
    },
    send(value) {
      body = value
      return this
    }
  }
  const error = Object.assign(new Error('Version obsolète'), {
    statusCode: 412,
    data: {latestAssociationVersion: 'a'.repeat(64)}
  })

  console.error = () => {}
  try {
    errorHandler(error, {method: 'PATCH', url: '/test'}, response)
  } finally {
    console.error = previousConsoleError
  }

  t.is(response.statusCode, 412)
  t.deepEqual(body.data, {latestAssociationVersion: 'a'.repeat(64)})
})
