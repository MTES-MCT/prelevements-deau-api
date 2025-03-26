import {chain} from 'lodash-es'

import * as storage from './internal/in-memory.js'
import {getBeneficiaireExploitations} from './exploitation.js'

export function getBeneficiaireByEmail(email) {
  return storage.beneficiaires.find(b => b.email === email)
}

export async function getBeneficiairesFromPointId(idPoint) {
  const exploitations = storage.exploitationsIndexes.point[idPoint] || []
  const beneficiairesSet = new Set()

  for (const exploitation of exploitations) {
    const beneficiaire = storage.indexedBeneficiaires[exploitation.id_beneficiaire]
    if (beneficiaire) {
      beneficiairesSet.add(beneficiaire)
    }
  }

  return [...beneficiairesSet]
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
