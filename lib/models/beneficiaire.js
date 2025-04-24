import mongo from '../util/mongo.js'
import {chain} from 'lodash-es'

export async function decorateBeneficiaire(beneficiaire) {
  const exploitations = await mongo.db.collection('exploitations').find(
    {id_beneficiaire: beneficiaire.id_beneficiaire},
    {projection: {
      usages: 1,
      id_exploitation: 1
    }}
  ).toArray()

  return {
    ...beneficiaire,
    exploitations,
    usages: chain(exploitations).map('usages').flatten().uniq().value()
  }
}

export async function getBeneficiaire(idBeneficiaire) {
  return mongo.db.collection('preleveurs').findOne(
    {id_beneficiaire: idBeneficiaire}
  )
}

export async function getBeneficiaires() {
  return mongo.db.collection('preleveurs').find().toArray()
}

export async function getBeneficiaireByEmail(email) {
  mongo.db.collection('preleveurs').findOne({email})
}
