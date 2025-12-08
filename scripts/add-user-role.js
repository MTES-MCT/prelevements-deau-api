/* eslint-disable n/prefer-global/process */
/* eslint-disable unicorn/no-process-exit */
import 'dotenv/config'
import {argv} from 'node:process'
import mongo from '../lib/util/mongo.js'
import {getUserByEmail, addRoleToUser} from '../lib/models/user.js'

await mongo.connect()

async function main() {
  const args = argv.slice(2)

  const email = args.find(a => a.startsWith('--email='))?.split('=')[1]
  const territoire = args.find(a => a.startsWith('--territoire='))?.split('=')[1]
  const role = args.find(a => a.startsWith('--role='))?.split('=')[1] || 'reader'

  if (!email || !territoire) {
    console.error('Usage: node scripts/add-user-role.js --email=user@example.com --territoire=GUADELOUPE [--role=reader|editor]')
    process.exit(1)
  }

  if (role !== 'reader' && role !== 'editor') {
    console.error('Le rôle doit être "reader" ou "editor"')
    process.exit(1)
  }

  try {
    const user = await getUserByEmail(email)

    if (!user) {
      console.error('\u001B[31;1m%s\u001B[0m', '\n✗ Utilisateur introuvable\n')
      process.exit(1)
    }

    const updatedUser = await addRoleToUser(user._id, territoire, role)

    console.log('\u001B[32;1m%s\u001B[0m', '\n✓ Rôle ajouté avec succès\n')
    console.log('Utilisateur:', updatedUser.prenom, updatedUser.nom)
    console.log('Email:', updatedUser.email)
    console.log('\nRôles:')
    for (const r of updatedUser.roles) {
      console.log(`  - ${r.territoire}: ${r.role}`)
    }

    console.log()
  } catch (error) {
    console.error('\u001B[31;1m%s\u001B[0m', '\n✗ Erreur lors de l\'ajout du rôle\n')
    console.error(error.message)
    process.exit(1)
  }
}

try {
  await main()
} finally {
  await mongo.disconnect()
}
