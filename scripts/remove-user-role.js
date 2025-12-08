/* eslint-disable n/prefer-global/process */
/* eslint-disable unicorn/no-process-exit */
import 'dotenv/config'
import {argv} from 'node:process'
import mongo from '../lib/util/mongo.js'
import {getUserByEmail, removeRoleFromUser} from '../lib/models/user.js'

await mongo.connect()

async function main() {
  const args = argv.slice(2)

  const email = args.find(a => a.startsWith('--email='))?.split('=')[1]
  const territoire = args.find(a => a.startsWith('--territoire='))?.split('=')[1]

  if (!email || !territoire) {
    console.error('Usage: node scripts/remove-user-role.js --email=user@example.com --territoire=GUADELOUPE')
    process.exit(1)
  }

  try {
    const user = await getUserByEmail(email)

    if (!user) {
      console.error('\u001B[31;1m%s\u001B[0m', '\n✗ Utilisateur introuvable\n')
      process.exit(1)
    }

    const updatedUser = await removeRoleFromUser(user._id, territoire)

    console.log('\u001B[32;1m%s\u001B[0m', '\n✓ Rôle supprimé avec succès\n')
    console.log('Utilisateur:', updatedUser.prenom, updatedUser.nom)
    console.log('Email:', updatedUser.email)

    if (updatedUser.roles.length > 0) {
      console.log('\nRôles restants:')
      for (const r of updatedUser.roles) {
        console.log(`  - ${r.territoire}: ${r.role}`)
      }
    } else {
      console.log('\nAucun rôle restant.')
    }

    console.log()
  } catch (error) {
    console.error('\u001B[31;1m%s\u001B[0m', '\n✗ Erreur lors de la suppression du rôle\n')
    console.error(error.message)
    process.exit(1)
  }
}

try {
  await main()
} finally {
  await mongo.disconnect()
}
