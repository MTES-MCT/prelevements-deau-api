/* eslint-disable n/prefer-global/process */
/* eslint-disable unicorn/no-process-exit */
import 'dotenv/config'
import {argv} from 'node:process'
import mongo from '../lib/util/mongo.js'
import {insertUser} from '../lib/models/user.js'

await mongo.connect()

async function main() {
  const args = argv.slice(2)

  const email = args.find(a => a.startsWith('--email='))?.split('=')[1]
  const nom = args.find(a => a.startsWith('--nom='))?.split('=')[1]
  const prenom = args.find(a => a.startsWith('--prenom='))?.split('=')[1]
  const structure = args.find(a => a.startsWith('--structure='))?.split('=')[1]
  const territoire = args.find(a => a.startsWith('--territoire='))?.split('=')[1]
  const role = args.find(a => a.startsWith('--role='))?.split('=')[1] || 'reader'

  if (!email || !nom || !prenom) {
    console.error('Usage: node scripts/create-user.js --email=user@example.com --nom=Dupont --prenom=Jean [--structure=DREAL] [--territoire=GUADELOUPE] [--role=reader|editor]')
    process.exit(1)
  }

  if (role !== 'reader' && role !== 'editor') {
    console.error('Le rôle doit être "reader" ou "editor"')
    process.exit(1)
  }

  const user = {
    email,
    nom,
    prenom,
    structure: structure || null,
    roles: []
  }

  // Si un territoire est fourni, ajouter le rôle
  if (territoire) {
    user.roles.push({territoire, role})
  }

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
        console.log(`  - ${r.territoire}: ${r.role}`)
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
