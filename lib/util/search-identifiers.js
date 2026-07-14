export function normalizeSiretSearch(value) {
  const digits = String(value ?? '').replaceAll(/\D/g, '')
  return digits.length >= 3 ? digits : null
}
