import express from 'express'
import w from '../util/w.js'

import {getPointsPrelevement, getPointPrelevement} from '../../models/prelevements.js'

const prelevementRoutes = new express.Router()

prelevementRoutes.get('/points-prelevement', w(async (req, res) => {
  const prelevements = await getPointsPrelevement()

  res.send(prelevements)
}))

prelevementRoutes.get('/points-prelevement/:id', w(async (req, res) => {
  const pointPrelevement = await getPointPrelevement(req.params.id)

  res.send(pointPrelevement)
}))

export default prelevementRoutes
