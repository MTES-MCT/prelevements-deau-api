import createHttpError from 'http-errors'
import mongo from '../util/mongo.js'

export async function getBss(idBss) {
  const bss = await mongo.db.collection('bss').findOne({
    id_bss: idBss
  })

  if (!bss) {
    throw createHttpError(404, 'Identifiant BSS introuvable.')
  }

  return bss
}

export async function getBssList() {
  return mongo.db.collection('bss').find().toArray()
}

export async function getBnpe(idBnpe) {
  const bnpe = await mongo.db.collection('bnpe').findOne({
    code_point_prelevement: idBnpe
  })

  if (!bnpe) {
    throw createHttpError(404, 'Identifiant BNPE introuvable.')
  }

  return bnpe
}

export function getBnpeList() {
  return mongo.db.collection('bnpe').find().toArray()
}

export async function getMeContinentalesBv(idMeContinentalesBv) {
  const meContinentalesBv = await mongo.db.collection('me_continentales_bv').findOne({
    code_point_prelevement: idMeContinentalesBv
  })

  if (!meContinentalesBv) {
    throw createHttpError(404, 'Identifiant me-continentales-bv introuvable.')
  }

  return meContinentalesBv
}

export function getMeContinentalesBvList() {
  return mongo.db.collection('me_continentales_bv').find().toArray()
}

export async function getBvBdcarthage(idBvBdcarthage) {
  const bvBdCarthage = await mongo.db.collection('bv_bdcarthage').findOne({
    code_cours: idBvBdcarthage
  })

  if (!bvBdCarthage) {
    throw createHttpError(404, 'Identifiant bv-bdcarthage introuvable.')
  }

  return bvBdCarthage
}

export async function getBvBdcarthageList() {
  return mongo.db.collection('bv_bdcarthage').find().toArray()
}

export async function getMeso(idMeso) {
  const meso = await mongo.db.collection('meso').findOne({
    code: idMeso
  })

  if (!meso) {
    throw createHttpError(404, 'Identifiant meso introuvable.')
  }

  return meso
}

export async function getMesoList() {
  return mongo.db.collection('meso').find().toArray()
}

