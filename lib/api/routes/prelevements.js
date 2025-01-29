import express from 'express'
import w from '../../util/w.js'

import {getPointsPrelevement, getPointPrelevement, getExploitation, getBeneficiaire, getRegle, getDocument} from '../../points-prelevement.js'

const prelevementRoutes = new express.Router()

prelevementRoutes.get('/points-prelevement', w(async (req, res) => {
  const prelevements = await getPointsPrelevement()

  res.send(prelevements)
}))

prelevementRoutes.get('/points-prelevement/:id', w(async (req, res) => {
  const pointPrelevement = await getPointPrelevement(req.params.id)

  res.send(pointPrelevement)
}))

prelevementRoutes.get('/exploitations/:id', w(async (req, res) => {
  const exploitation = await getExploitation(req.params.id)

  res.send(exploitation)
}))

prelevementRoutes.get('/beneficiaires/:id', w(async (req, res) => {
  const beneficiaire = await getBeneficiaire(req.params.id)

  res.send(beneficiaire)
}))

prelevementRoutes.get('/regles/:id', w(async (req, res) => {
  const regle = await getRegle(req.params.id)

  res.send(regle)
}))

prelevementRoutes.get('/documents/:id', w(async (req, res) => {
  const document = await getDocument(req.params.id)

  res.send(document)
}))

export default prelevementRoutes
