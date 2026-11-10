import test from 'ava'

import errorHandler from '../error-handler.js'
import {getBrevoTemplate} from '../../services/brevo-template-preview.js'

function captureResponse(error) {
  const previousConsoleError = console.error
  const result = {headers: {}}
  const response = {
    set(name, value) {
      result.headers[name] = value
      return this
    },
    status(code) {
      result.status = code
      return this
    },
    send(body) {
      result.body = JSON.parse(JSON.stringify(body))
      return this
    }
  }
  console.error = () => {}
  try {
    errorHandler(error, {method: 'POST', url: '/test'}, response)
  } finally {
    console.error = previousConsoleError
  }
  return result
}

for (const statusCode of [undefined, 500, 502, 503, 504]) {
  test.serial(`une erreur ${statusCode ?? 'sans statut'} propose une action sans exposer de détails internes`, t => {
    const internal = 'synthetic-private-diagnostic'
    const error = Object.assign(new Error(internal), {
      statusCode,
      expose: statusCode !== 503,
      name: internal,
      stack: internal,
      details: [{message: internal, context: {value: internal}}],
      data: {credential: internal},
      cause: new Error(internal)
    })
    const {status, body} = captureResponse(error)
    t.is(status, statusCode ?? 500)
    t.deepEqual(Object.keys(body).sort(), ['code', 'message'])
    t.regex(body.message, /Réessayez/)
    t.regex(body.message, /contactez l’assistance/)
    t.false(body.message.includes('enregistré'))
    t.false(JSON.stringify(body).includes(internal))
  })
}

test.serial('les erreurs connues conservent leur message utile et leurs informations publiques', t => {
  const details = [{message: 'La date est obligatoire.', path: ['date']}]
  const validation = captureResponse(Object.assign(new Error('Vérifiez les champs indiqués.'), {statusCode: 400, details}))
  t.deepEqual(validation.body.validationErrors, details)

  for (const [statusCode, message, retryAfterSeconds] of [
    [422, 'Aucun fichier du dépôt n’a été enregistré. Réessayez avec un fichier lisible.', undefined],
    [503, 'L’analyse antivirus est temporairement indisponible. Réessayez dans 30 secondes.', 30]
  ]) {
    const response = captureResponse(Object.assign(new Error(message), {statusCode, retryAfterSeconds, expose: true}))
    t.deepEqual(response.body, {code: statusCode, message, ...(statusCode === 503 ? {messageIsPublic: true} : {})})
    t.is(response.headers['Retry-After'], retryAfterSeconds ? '30' : undefined)
  }
})

test.serial('les erreurs de configuration et les diagnostics fournisseur restent masqués', async t => {
  const missingKey = await t.throwsAsync(getBrevoTemplate(1, {apiKey: ''}))
  const upstream = await t.throwsAsync(getBrevoTemplate(1, {
    apiKey: 'synthetic-credential',
    fetchImplementation: async () => Response.json({message: 'synthetic-private-diagnostic'}, {status: 503})
  }))
  for (const error of [missingKey, upstream]) {
    const {body} = captureResponse(error)
    t.deepEqual(Object.keys(body).sort(), ['code', 'message'])
    t.false(JSON.stringify(body).includes('BREVO_API_KEY'))
    t.false(JSON.stringify(body).includes('synthetic-'))
    t.regex(body.message, /Réessayez/)
  }
})

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
