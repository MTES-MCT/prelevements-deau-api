
import '../lib/config/env.js'
import process, {argv} from 'node:process'
import {prisma} from '../db/prisma.js'

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

  const role = parseArgValue(args, 'role')?.toUpperCase()
  const email = parseArgValue(args, 'email')

  try {
    const users = await prisma.user.findMany({
      where: {
        ...(role ? {role} : {}),
        ...(email
          ? {
            email: {
              contains: email,
              mode: 'insensitive'
            }
          }
          : {})
      },
      orderBy: [
        {
          createdAt: 'desc'
        }
      ],
      include: {
        declarant: true,
        instructor: true
      }
    })

    if (users.length === 0) {
      console.log('Aucun utilisateur trouvé.')
      return
    }

    console.log(`\n${users.length} utilisateur(s) trouvé(s)\n`)

    for (const user of users) {
      console.log('----------------------------------------')
      console.log('ID:', user.id)
      console.log('Email:', user.email)
      console.log('Nom:', user.firstName, user.lastName)
      console.log('Rôle:', user.role)
      console.log('Profil:', user.declarant ? 'Declarant' : (user.instructor ? 'Instructor' : '-'))
      console.log('Créé le:', user.createdAt?.toISOString?.() ?? user.createdAt)
    }

    console.log('----------------------------------------')
    console.log()
  } catch (error) {
    console.error('\u001B[31;1m%s\u001B[0m', '\nErreur lors de la récupération des utilisateurs\n')
    console.error(error?.message || error)
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

await main()
