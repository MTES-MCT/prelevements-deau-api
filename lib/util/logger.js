/**
 * Crée un logger qui utilise job.log() si disponible, sinon console.
 * @param {object} [job] - Job BullMQ (optionnel)
 * @returns {{log: function, warn: function, error: function}}
 */
export function createLogger(job) {
  if (!job?.log) {
    return console
  }

  const formatWarning = msg => typeof msg === 'string'
    ? `⚠️ ${msg}`
    : `⚠️ ${JSON.stringify(msg)}`

  return {
    log(msg) {
      job.log(msg)
      console.log(msg)
    },
    warn(msg) {
      const message = formatWarning(msg)
      job.log(message)
      console.warn(message)
    },
    error(msg) {
      job.log(`❌ ${msg}`)
      console.error(`❌ ${msg}`)
    }
  }
}
