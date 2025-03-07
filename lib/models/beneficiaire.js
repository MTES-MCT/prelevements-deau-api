import * as storage from './internal/in-memory.js'

export function getBeneficiaireByEmail(email) {
  return storage.beneficiaires.find(b => b.email === email)
}
