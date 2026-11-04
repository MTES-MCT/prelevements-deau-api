import {listAuthenticatedPreleveurs, selectAuthenticatedPreleveur} from '../services/preleveur-profiles.js'

export async function listAuthenticatedPreleveursHandler(req, res) {
  res.send(await listAuthenticatedPreleveurs(req.authToken))
}

export async function selectAuthenticatedPreleveurHandler(req, res) {
  res.send(await selectAuthenticatedPreleveur(req.authToken, req.body))
}
