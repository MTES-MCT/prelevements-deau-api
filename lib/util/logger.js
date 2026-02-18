/**
 * Crée un logger qui utilise job.log() si disponible, sinon console.
 * @param {object} [job] - Job BullMQ (optionnel)
 * @returns {{log: function, warn: function, error: function}}
 */
export function createLogger(job) {
  const base = {
    log: msg => console.log(msg),
    warn: msg => console.warn(msg),
    error: msg => console.error(msg)
  }

  if (!job?.log) {
    return base
  }

  return {
    log: msg => { job.log(msg); base.log(msg) },
    warn: msg => { job.log(`⚠️ ${msg}`); base.warn(`⚠️ ${msg}`) },
    error: msg => { job.log(`❌ ${msg}`); base.error(`❌ ${msg}`) }
  }
}
