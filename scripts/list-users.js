/* eslint-disable n/prefer-global/process */
/* eslint-disable unicorn/no-process-exit */
import 'dotenv/config'
import {argv} from 'node:process'
import mongo from '../lib/util/mongo.js'

await mongo.connect()

async function main() {
  const args = argv.slice(2)

  const territoire = args.find(a => a.startsWith('--territoire='))?.split('=')[1]
  const roleFilter = args.find(a => a.startsWith('--role='))?.split('=')[1]

  if (roleFilter && roleFilter !== 'reader' && roleFilter !== 'editor') {
    console.error('Le rôle doit être "reader" ou "editor"')
    process.exit(1)
  }

  try {
    let users

    users = await mongo.db.collection('users').find({
      deletedAt: {$exists: false}
    }).toArray()

    // Filtrer par rôle si demandé
    if (roleFilter) {
      users = users.filter(u => u.roles.some(r => {
        if (territoire) {
          return r.territoire === territoire && r.role === roleFilter
        }

        return r.role === roleFilter
      }))
    }

    console.log('\u001B[36;1m%s\u001B[0m', `\n${users.length} utilisateur(s) trouvé(s)\n`)

    if (users.length === 0) {
      return
    }

    for (const user of users) {
      console.log('─'.repeat(60))
      console.log('ID:', user._id.toString())
      console.log('Email:', user.email)
      console.log('Nom:', user.prenom, user.nom)
      if (user.structure) {
        console.log('Structure:', user.structure)
      }

      if (user.roles.length > 0) {
        console.log('Rôles:')
        for (const r of user.roles) {
          const badge = r.role === 'editor' ? '✏️ ' : '👁️ '
          console.log(`  ${badge} ${r.territoire}: ${r.role}`)
        }
      } else {
        console.log('Rôles: aucun')
      }

      console.log()
    }
  } catch (error) {
    console.error('\u001B[31;1m%s\u001B[0m', '\n✗ Erreur lors de la récupération des utilisateurs\n')
    console.error(error.message)
    process.exit(1)
  }
}

try {
  await main()
} finally {
  await mongo.disconnect()
}
