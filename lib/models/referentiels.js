import createHttpError from 'http-errors'
import mongo from '../util/mongo.js'

export async function getBss(idBss, {throwIfNotFound = false} = {}) {
  const bss = await mongo.db.collection('bss').findOne({
    id_bss: idBss
  })

  if (!bss && throwIfNotFound) {
    throw createHttpError(404, 'Identifiant BSS introuvable.')
  }

  return bss
}

export async function getBssList() {
  return mongo.db.collection('bss').find().toArray()
}

export async function getBnpe(idBnpe, {throwIfNotFound = false} = {}) {
  const bnpe = await mongo.db.collection('bnpe').findOne({
    code_point_prelevement: idBnpe
  })

  if (!bnpe && throwIfNotFound) {
    throw createHttpError(404, 'Identifiant BNPE introuvable.')
  }

  return bnpe
}

export function getBnpeList() {
  return mongo.db.collection('bnpe').find().toArray()
}

export async function getMeContinentalesBv(idMeContinentalesBv, {throwIfNotFound = false} = {}) {
  const meContinentalesBv = await mongo.db.collection('me_continentales_bv').findOne({
    code_dce: idMeContinentalesBv
  })

  if (!meContinentalesBv && throwIfNotFound) {
    throw createHttpError(404, 'Identifiant me-continentales-bv introuvable.')
  }

  return meContinentalesBv
}

export function getMeContinentalesBvList() {
  return mongo.db.collection('me_continentales_bv').find().toArray()
}

export async function getBvBdcarthage(idBvBdcarthage, {throwIfNotFound = false} = {}) {
  const bvBdCarthage = await mongo.db.collection('bv_bdcarthage').findOne({
    code_cours: idBvBdcarthage
  })

  if (!bvBdCarthage && throwIfNotFound) {
    throw createHttpError(404, 'Identifiant bv-bdcarthage introuvable.')
  }

  return bvBdCarthage
}

export async function getBvBdcarthageList() {
  return mongo.db.collection('bv_bdcarthage').find().toArray()
}

export async function getMeso(idMeso, {throwIfNotFound = false} = {}) {
  const meso = await mongo.db.collection('meso').findOne({
    code: idMeso
  })

  if (!meso && throwIfNotFound) {
    throw createHttpError(404, 'Identifiant meso introuvable.')
  }

  return meso
}

export async function getMesoList() {
  return mongo.db.collection('meso').find().toArray()
}

