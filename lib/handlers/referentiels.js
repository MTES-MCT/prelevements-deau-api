import {
  getBnpe,
  getBnpeList,
  getBss,
  getBssList,
  getBvBdcarthage,
  getBvBdcarthageList,
  getMeContinentalesBv,
  getMeContinentalesBvList,
  getMeso,
  getMesoList
} from '../models/referentiels.js'

// Liste BSS
export async function getBssListHandler(req, res) {
  const bssList = await getBssList()

  res.send(bssList)
}

// Détail BSS
export async function getBssDetailHandler(req, res) {
  const bss = await getBss(req.params.idBss, {throwIfNotFound: true})

  res.send(bss)
}

// Liste BNPE
export async function getBnpeListHandler(req, res) {
  const bnpeList = await getBnpeList()

  res.send(bnpeList)
}

// Détail BNPE
export async function getBnpeDetailHandler(req, res) {
  const bnpe = await getBnpe(req.params.idBnpe, {throwIfNotFound: true})

  res.send(bnpe)
}

// Liste ME Continentales BV
export async function getMeContinentalesBvListHandler(req, res) {
  const meContinentalesBvList = await getMeContinentalesBvList()

  res.send(meContinentalesBvList)
}

// Détail ME Continentales BV
export async function getMeContinentalesBvDetailHandler(req, res) {
  const meContinentalesBv = await getMeContinentalesBv(req.params.idMeContinentalesBv, {throwIfNotFound: true})

  res.send(meContinentalesBv)
}

// Liste BV BD Carthage
export async function getBvBdcarthageListHandler(req, res) {
  const bvBdCarthageList = await getBvBdcarthageList()

  res.send(bvBdCarthageList)
}

// Détail BV BD Carthage
export async function getBvBdcarthageDetailHandler(req, res) {
  const bvBdCarthage = await getBvBdcarthage(req.params.idBvBdcarthage, {throwIfNotFound: true})

  res.send(bvBdCarthage)
}

// Liste MESO
export async function getMesoListHandler(req, res) {
  const mesoList = await getMesoList()

  res.send(mesoList)
}

// Détail MESO
export async function getMesoDetailHandler(req, res) {
  const meso = await getMeso(req.params.idMeso, {throwIfNotFound: true})

  res.send(meso)
}
