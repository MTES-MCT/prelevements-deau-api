export function getTransactionTimeoutMs(seconds = 900) {
  if ((typeof seconds !== 'number' && typeof seconds !== 'string')
    || (typeof seconds === 'string' && !/^\d+$/.test(seconds))
    || !Number.isSafeInteger(Number(seconds)) || Number(seconds) < 1 || Number(seconds) > 1800) {
    throw new Error('La durée de transaction doit être un entier entre 1 et 1800 secondes.')
  }

  return Number(seconds) * 1000
}
