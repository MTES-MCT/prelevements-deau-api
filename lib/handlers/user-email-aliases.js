import {
  createUserEmailAlias,
  deleteUserEmailAlias,
  listUserEmailAliases
} from '../models/user-email-alias.js'
import {requestEmailAliasAddition} from '../services/user-email-verifications.js'

export async function listMyEmailAliasesHandler(req, res) {
  const aliases = await listUserEmailAliases(req.user.id)

  res.status(200).send({
    emailAliases: aliases
  })
}

export async function createMyEmailAliasHandler(req, res) {
  const verification = await requestEmailAliasAddition(
    req.user.id,
    req.body?.email,
    {
      allowImpersonatedSession: true,
      sessionToken: req.authToken
    }
  )

  res.status(202).send(verification)
}

export async function deleteMyEmailAliasHandler(req, res) {
  await deleteUserEmailAlias(req.user.id, req.params.emailAliasId, {
    allowImpersonatedSession: true,
    requireRemainingLogin: true,
    sessionToken: req.authToken
  })

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
