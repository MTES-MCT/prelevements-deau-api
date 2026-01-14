/* eslint-disable n/prefer-global/process */
/* eslint-disable unicorn/no-process-exit */
import 'dotenv/config'
import {argv} from 'node:process'
import mongo from '../lib/util/mongo.js'
import {insertUser} from '../lib/models/user.js'

await mongo.connect()

function parseArgValue(args, argName) {
  const arg = args.find(a => a.startsWith(`--${argName}=`))
  if (!arg) {
    return undefined
  }

  const value = arg.split('=').slice(1).join('=')
  return value.replaceAll(/^["']|["']$/g, '')
}

async function main() {
  const args = argv.slice(2)

  const email = parseArgValue(args, 'email')
  const nom = parseArgValue(args, 'nom')
  const prenom = parseArgValue(args, 'prenom')
  const structure = parseArgValue(args, 'structure')
  const role = parseArgValue(args, 'role') || 'reader'

  if (!email || !nom || !prenom) {
    console.error('Usage: node scripts/create-user.js --email=user@example.com --nom=Dupont --prenom=Jean [--structure=DREAL] [--role=reader|editor|preleveur]')
    process.exit(1)
  }

  if (role !== 'reader' && role !== 'editor' && role !== 'preleveur') {
    console.error('Le rôle doit être "reader", "editor" ou "preleveur"')
    process.exit(1)
  }

  const user = {
    email,
    nom,
    prenom,
    structure: structure || null,
    roles: []
  }

  user.roles.push({role})

  try {
    const createdUser = await insertUser(user)
    console.log('\u001B[32;1m%s\u001B[0m', '\n✓ Utilisateur créé avec succès\n')
    console.log('ID:', createdUser._id.toString())
    console.log('Email:', createdUser.email)
    console.log('Nom:', createdUser.prenom, createdUser.nom)
    if (createdUser.structure) {
      console.log('Structure:', createdUser.structure)
    }

    if (createdUser.roles.length > 0) {
      console.log('\nRôles:')
      for (const r of createdUser.roles) {
        console.log(`  - ${r.role}`)
      }
    } else {
      console.log('\nAucun rôle assigné. Utilisez add-user-role.js pour ajouter des rôles.')
    }

    console.log()
  } catch (error) {
    console.error('\u001B[31;1m%s\u001B[0m', '\n✗ Erreur lors de la création de l\'utilisateur\n')
    console.error(error.message)
    process.exit(1)
  }
}

try {
  await main()
} finally {
  await mongo.disconnect()
}
