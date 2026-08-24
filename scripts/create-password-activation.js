#!/usr/bin/env node
import '../lib/config/env.js'

import process from 'node:process'
import {pathToFileURL} from 'node:url'

import {prisma} from '../db/prisma.js'
import {
  AUTH_METHODS,
  readAuthMethods,
  readPasswordActivationFrontUrl
} from '../lib/config/auth.js'
import {issuePasswordActivation} from '../lib/models/password-access.js'
import {getAuthUserByEmail} from '../lib/models/user.js'
import {normalizeEmail} from '../lib/util/email.js'

function readArgument(args, name) {
  const prefix = `--${name}=`
  const argument = args.find(value => value.startsWith(prefix))
  return argument?.slice(prefix.length)
}

export function getDatabaseTarget(databaseUrl) {
  let parsed
  try {
    parsed = new URL(databaseUrl)
  } catch {
    throw new Error('DATABASE_URL est invalide.')
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('DATABASE_URL doit utiliser PostgreSQL.')
  }

  const port = parsed.port || '5432'
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  if (!parsed.hostname || !database) {
    throw new Error('DATABASE_URL doit contenir un hôte et une base.')
  }

  return {
    confirmation: `${parsed.hostname}:${port}/${database}`,
    host: parsed.hostname,
    port,
    database,
    user: decodeURIComponent(parsed.username || '') || '(non précisé)'
  }
}

export function getFrontUrl(value) {
  return readPasswordActivationFrontUrl(value)
}

export async function createPasswordActivationForOperator({
  args = process.argv.slice(2),
  environment = process.env,
  findUser = getAuthUserByEmail,
  issueActivation = issuePasswordActivation,
  log = console.log
} = {}) {
  const email = normalizeEmail(readArgument(args, 'email'))
  const confirmedTarget = readArgument(args, 'confirm-target')
  const confirmedUserId = readArgument(args, 'confirm-user')
  const methods = readAuthMethods(environment.AUTH_METHODS)

  if (!methods.includes(AUTH_METHODS.PASSWORD)) {
    throw new Error('La méthode password n’est pas active dans AUTH_METHODS.')
  }

  const target = getDatabaseTarget(environment.DATABASE_URL)
  const user = await findUser(email)
  if (!user) {
    throw new Error('Utilisateur actif introuvable.')
  }

  const frontUrl = getFrontUrl(environment.FRONT_URL)

  log('Cible PostgreSQL résolue :')
  log(`- hôte : ${target.host}`)
  log(`- port : ${target.port}`)
  log(`- base : ${target.database}`)
  log(`- utilisateur : ${target.user}`)
  log('\nUtilisateur applicatif résolu :')
  log(`- id : ${user.id}`)
  log(`- email principal : ${user.email}`)
  log(`- rôle : ${user.role}`)

  if (confirmedTarget !== target.confirmation || confirmedUserId !== user.id) {
    throw new Error(
      'Confirmation requise : relancez avec '
      + `--confirm-target=${target.confirmation} --confirm-user=${user.id}`
    )
  }

  const result = await issueActivation(user.id)
  if (!result) {
    throw new Error('Impossible de créer le lien pour cet utilisateur.')
  }

  const activationUrl = `${frontUrl}/activation-mot-de-passe#token=${encodeURIComponent(result.token)}`

  log('\nLien d’activation à transmettre par un canal sûr (affiché une seule fois) :')
  log(activationUrl)
  log(`Expiration : ${result.activation.expiresAt.toISOString()}`)

  return {
    userId: user.id,
    activationUrl,
    expiresAt: result.activation.expiresAt
  }
}

const isDirectExecution = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectExecution) {
  try {
    await createPasswordActivationForOperator()
  } catch (error) {
    console.error(`Erreur : ${error.message}`)
    process.exitCode = 1
  } finally {
    await prisma.$disconnect()
  }
}
