function isSerializationConflict(error) {
  return error?.code === 'P2034'
    || error?.code === '40001'
    || error?.meta?.code === '40001'
    || error?.cause?.code === '40001'
}

function errorHandler(err, req, res, _next) {
  if (err) {
    const serializationConflict = isSerializationConflict(err)
    const statusCode = err.statusCode || (serializationConflict ? 409 : 500)
    const exposeError = statusCode !== 500
    const message = serializationConflict
      ? 'Cette exploitation a été modifiée simultanément. Rechargez-la puis réessayez.'
      : err.message

    console.error('[ERROR_HANDLER]', {
      method: req.method,
      url: req.originalUrl || req.url,
      message: err.message,
      name: err.name
    })

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
