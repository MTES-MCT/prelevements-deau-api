import {chain} from 'lodash-es'

import * as storage from './internal/in-memory.js'
import {getBeneficiaireExploitations} from './exploitation.js'

export function getBeneficiaireByEmail(email) {
  return storage.beneficiaires.find(b => b.email === email)
}

export async function getBeneficiairesFromPointId(idPoint) {
  return (storage.exploitationsIndexes.point[idPoint] || [])
    .map(exploitation => storage.indexedBeneficiaires[exploitation.id_beneficiaire])
}

export async function getBeneficiaire(idBeneficiaire) {
  const beneficiaire = storage.indexedBeneficiaires[idBeneficiaire]
  const exploitations = await getBeneficiaireExploitations(idBeneficiaire)
  const usages = chain(exploitations).map('usages').flatten().uniq().value()

  return {
    ...beneficiaire,
    exploitations,
    usages
  }
}

export async function getBeneficiaires() {
  return Promise.all(storage.beneficiaires.map(b => getBeneficiaire(b.id_beneficiaire)))
}
