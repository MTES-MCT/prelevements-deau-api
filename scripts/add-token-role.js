/* eslint-disable n/prefer-global/process */
/* eslint-disable unicorn/no-process-exit */
import 'dotenv/config'
import {argv} from 'node:process'
import mongo from '../lib/util/mongo.js'
import {getTokenEntry, updateTokenRole} from '../lib/models/token.js'

await mongo.connect()

async function main() {
  const args = argv.slice(2)

  const token = args.find(a => a.startsWith('--token='))?.split('=')[1]
  const role = args.find(a => a.startsWith('--role='))?.split('=')[1]

  if (!token || !role) {
    console.error('Usage: node scripts/add-token-role.js --token=<token> --role=<reader|editor>')
    process.exit(1)
  }

  if (role !== 'reader' && role !== 'editor') {
    console.error('Le rôle doit être "reader" ou "editor"')
    process.exit(1)
  }

  try {
    const tokenEntry = await getTokenEntry(token)

    if (!tokenEntry) {
      console.error('\u001B[31;1m%s\u001B[0m', '\n✗ Token introuvable\n')
      process.exit(1)
    }

    await updateTokenRole(token, role)

    console.info('\u001B[32;1m%s\u001B[0m', `\n✓ Rôle "${role}" ajouté au token pour le territoire "${tokenEntry.territoire}"\n`)
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
}

try {
  await main()
} finally {
  await mongo.disconnect()
}

