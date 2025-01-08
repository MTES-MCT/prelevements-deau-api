import express from 'express'
import w from '../util/w.js'

import {getPointsPrelevement} from '../../models/prelevements.js'

const prelevementRoutes = new express.Router()

prelevementRoutes.get('/points-prelevement', w(async (req, res) => {
  const prelevements = await getPointsPrelevement()

  res.send(prelevements)
}))

export default prelevementRoutes
