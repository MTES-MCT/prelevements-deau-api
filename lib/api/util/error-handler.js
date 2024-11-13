function errorHandler(err, req, res, _next) {
  if (err) {
    if (err.isJoi) {
      return res
        .status(400)
        .send({
          code: 400,
          message: 'Validation error',
          details: err.details
        })
    }

    const statusCode = err.statusCode || 500
    const exposeError = statusCode !== 500

    res
      .status(statusCode)
      .send({
        code: statusCode,
        message: exposeError ? err.message : 'An unexpected error has occurred'
      })

    if (statusCode === 500) {
      console.error(err)
    }
  }
}

export default errorHandler

