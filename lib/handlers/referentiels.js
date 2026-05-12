import createHttpError from 'http-errors'

function sendDisabledList(_req, res) {
  res.send([])
}

function sendDisabledDetail(_req, _res) {
  throw createHttpError(404, 'Référentiel désactivé.')
}

export const getBssListHandler = sendDisabledList
export const getBssDetailHandler = sendDisabledDetail

export const getBnpeListHandler = sendDisabledList
export const getBnpeDetailHandler = sendDisabledDetail

export const getMeContinentalesBvListHandler = sendDisabledList
export const getMeContinentalesBvDetailHandler = sendDisabledDetail

export const getBvBdcarthageListHandler = sendDisabledList
export const getBvBdcarthageDetailHandler = sendDisabledDetail

export const getMesoListHandler = sendDisabledList
export const getMesoDetailHandler = sendDisabledDetail
