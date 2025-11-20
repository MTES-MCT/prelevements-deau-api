/**
 * Crée un logger qui utilise job.log() si disponible, sinon console.
 * @param {object} [job] - Job BullMQ (optionnel)
 * @returns {{log: function, warn: function, error: function}}
 */
export function createLogger(job) {
  if (job?.log) {
    return {
      log: message => job.log(message),
      warn: message => job.log(`⚠️ ${message}`),
      error: message => job.log(`❌ ${message}`)
    }
  }

  return console
}
