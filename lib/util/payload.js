class ValidationError extends Error {
  constructor(details) {
    super('Payload invalide')
    this.name = 'ValidationError'
    this.statusCode = 400
    this.details = details
  }
}

function validatePayload(payload, schema) {
  const {error, value} = schema.validate(payload, {
    abortEarly: false,
    allowUnknown: false,
    convert: true
  })

  if (!error) {
    return value
  }

  const details = error.details.map(d => ({
    path: d.path.join('.'),
    type: d.type,
    message: d.message,
    ...(d.type === 'object.unknown' ? {unknownKey: d.context?.key} : {})
  }))

  throw new ValidationError(details)
}

export {ValidationError, validatePayload}
