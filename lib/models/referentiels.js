import mongo from '../util/mongo.js'

export async function getBss(idBss) {
  const bss = mongo.db.collection('bss').findOne({
    id_bss: idBss
  })

  return bss
}

export async function getBnpe(idBnpe) {
  const bnpe = mongo.db.collection('bnpe').findOne({
    code_point_prelevement: idBnpe
  })

  return bnpe
}

export async function getMeContinentalesBv(idMeContinentalesBv) {
  const meContinentalesBv = mongo.db.collection('me_continentales_bv').findOne({
    code_point_prelevement: idMeContinentalesBv
  })

  return meContinentalesBv
}

export async function getBvBdcarthage(idBvBdcarthage) {
  const bvBdCarthage = mongo.db.collection('bv_bdcarthage').findOne({
    code_cours: idBvBdcarthage
  })

  return bvBdCarthage
}

export async function getMeso(idMeso) {
  const meso = mongo.db.collection('meso').findOne({
    code: idMeso
  })

  return meso
}

export async function getLibelleCommune(idCommune) {
  const commune = mongo.db.collection('communes').findOne({
    id: idCommune
  })

  return commune
}
