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

test.serial('errorHandler traduit un conflit de sérialisation Prisma en 409', t => {
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

  console.error = () => {}
  try {
    errorHandler(
      Object.assign(new Error('Transaction failed'), {code: 'P2034'}),
      {method: 'PUT', url: '/exploitations/123'},
      response
    )
  } finally {
    console.error = previousConsoleError
  }

  t.is(response.statusCode, 409)
  t.is(body.message, 'Cette exploitation a été modifiée simultanément. Rechargez-la puis réessayez.')
})

test.serial('errorHandler expose le délai avant une nouvelle tentative', t => {
  const previousConsoleError = console.error
  const headers = {}
  const response = {
    set(name, value) {
      headers[name] = value
      return this
    },
    status() {
      return this
    },
    send() {
      return this
    }
  }
  const error = Object.assign(new Error('Veuillez patienter.'), {
    statusCode: 429,
    retryAfterSeconds: 42
  })

  console.error = () => {}
  try {
    errorHandler(error, {method: 'POST', url: '/test'}, response)
  } finally {
    console.error = previousConsoleError
  }

  t.is(headers['Retry-After'], '42')
})

test.serial('errorHandler traduit une réservation email concurrente en 409', t => {
  const previousConsoleError = console.error
  let body
  let statusCode
  const response = {
    status(code) {
      statusCode = code
      return this
    },
    send(value) {
      body = value
      return this
    }
  }

  console.error = () => {}
  try {
    errorHandler(
      new Error('constraint User_email_reserved failed'),
      {method: 'POST', url: '/zones/zone-1/instructeurs'},
      response
    )
  } finally {
    console.error = previousConsoleError
  }

  t.is(statusCode, 409)
  t.is(body.message, 'Cette adresse email est déjà utilisée ou en cours de validation.')
})

test.serial('errorHandler traduit une course du registre email en 409', t => {
  const previousConsoleError = console.error
  let body
  let statusCode
  const response = {
    status(code) {
      statusCode = code
      return this
    },
    send(value) {
      body = value
      return this
    }
  }

  console.error = () => {}
  try {
    errorHandler(
      {
        code: 'P2004',
        message: 'A constraint failed',
        meta: {
          database_error: 'UserEmailIdentity_compatible_claims_check'
        }
      },
      {method: 'POST', url: '/users/me/email-aliases'},
      response
    )
  } finally {
    console.error = previousConsoleError
  }

  t.is(statusCode, 409)
  t.is(body.message, 'Cette adresse email est déjà utilisée ou en cours de validation.')
})
