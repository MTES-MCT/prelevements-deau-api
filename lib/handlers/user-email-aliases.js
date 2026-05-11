import {
  createUserEmailAlias,
  deleteUserEmailAlias,
  listUserEmailAliases
} from '../models/user-email-alias.js'

export async function listMyEmailAliasesHandler(req, res) {
  const aliases = await listUserEmailAliases(req.user.id)

  res.status(200).send({
    emailAliases: aliases
  })
}

export async function createMyEmailAliasHandler(req, res) {
  const alias = await createUserEmailAlias(req.user.id, req.body.email)

  res.status(201).send(alias)
}

export async function deleteMyEmailAliasHandler(req, res) {
  await deleteUserEmailAlias(req.user.id, req.params.emailAliasId)

  res.status(200).send({
    success: true
  })
}

export async function listDeclarantEmailAliasesHandler(req, res) {
  const aliases = await listUserEmailAliases(req.params.declarantId)

  res.status(200).send({
    emailAliases: aliases
  })
}

export async function createDeclarantEmailAliasHandler(req, res) {
  const alias = await createUserEmailAlias(req.params.declarantId, req.body.email)

  res.status(201).send(alias)
}

export async function deleteDeclarantEmailAliasHandler(req, res) {
  await deleteUserEmailAlias(req.params.declarantId, req.params.emailAliasId)

  res.status(200).send({
    success: true
  })
}
