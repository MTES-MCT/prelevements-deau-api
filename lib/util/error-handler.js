function isSerializationConflict(error) {
  return error?.code === 'P2034'
    || error?.code === '40001'
    || error?.meta?.code === '40001'
    || error?.cause?.code === '40001'
}

function isEmailAddressConflict(error) {
  const message = [
    error?.message,
    error?.meta?.database_error,
    error?.cause?.message
  ].filter(Boolean).join(' ')

  return [
    'UserEmailVerification_active_email_key',
    'UserEmailVerification_email_not_primary',
    'UserEmailVerification_email_not_alias',
    'UserEmailAlias_email_not_primary',
    'UserEmailAlias_email_reserved',
    'User_email_not_alias',
    'User_email_reserved',
    'UserEmailIdentity_compatible_claims_check'
  ].some(constraint => message.includes(constraint))
}

function errorHandler(err, req, res, _next) {
  if (err) {
    const serializationConflict = isSerializationConflict(err)
    const emailAddressConflict = isEmailAddressConflict(err)
    const statusCode = err.statusCode
      || (serializationConflict || emailAddressConflict ? 409 : 500)
    const exposeError = statusCode !== 500
    let {message} = err

    if (serializationConflict) {
      message = 'Cette exploitation a été modifiée simultanément. Rechargez-la puis réessayez.'
    }

    if (emailAddressConflict) {
      message = 'Cette adresse email est déjà utilisée ou en cours de validation.'
    }

    console.error('[ERROR_HANDLER]', {
      method: req.method,
      url: req.originalUrl || req.url,
      message: err.message,
      name: err.name
    })

    if (Number.isInteger(err.retryAfterSeconds) && err.retryAfterSeconds > 0) {
      res.set('Retry-After', String(err.retryAfterSeconds))
    }

    res
      .status(statusCode)
      .send({
        code: statusCode,
        message: exposeError ? message : 'Une erreur inattendue est survenue',
        validationErrors: err.details,
        data: exposeError ? err.data : undefined
      })

    if (statusCode === 500) {
      console.error(err)
    }
  }
}

export default errorHandler
