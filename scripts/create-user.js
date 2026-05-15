
import '../lib/config/env.js'
import process, {argv} from 'node:process'
import {prisma} from '../db/prisma.js'
import {randomUUID} from 'node:crypto'
import {allowTemplateDeclarationTypeForDeclarant} from '../lib/models/declaration-type.js'

const VALID_ROLES = new Set(['DECLARANT', 'INSTRUCTOR', 'ADMIN'])

function parseArgValue(args, argName) {
  const arg = args.find(a => a.startsWith(`--${argName}=`))
  if (!arg) {
    return undefined
  }

  const value = arg.split('=').slice(1).join('=')
  return value.replaceAll(/^["']|["']$/g, '')
}

function getProfileRelation(role) {
  if (role === 'DECLARANT') {
    return {declarant: {create: {}}}
  }

  if (role === 'INSTRUCTOR' || role === 'ADMIN') {
    return {instructor: {create: {}}}
  }

  return {}
}

function getProfileLabel(user) {
  if (user.declarant) {
    return 'Declarant'
  }

  if (user.instructor) {
    return user.role === 'ADMIN' ? 'Admin' : 'Instructor'
  }

  return user.role === 'ADMIN' ? 'Admin' : '-'
}

async function main() {
  const args = argv.slice(2)

  const email = parseArgValue(args, 'email')
  const lastName = parseArgValue(args, 'nom')
  const firstName = parseArgValue(args, 'prenom')
  const role = (parseArgValue(args, 'role') || 'DECLARANT').toUpperCase()

  if (!email || !lastName || !firstName) {
    console.error(
      'Usage: node scripts/create-user.js --email=user@example.com --nom=Dupont --prenom=Jean [--role=DECLARANT|INSTRUCTOR|ADMIN]'
    )
    process.exit(1)
  }

  if (!VALID_ROLES.has(role)) {
    console.error('Le rôle doit être "DECLARANT", "INSTRUCTOR" ou "ADMIN".')
    process.exit(1)
  }

  try {
    const createdUser = await prisma.user.create({
      data: {
        id: randomUUID(),
        email,
        firstName,
        lastName,
        role,
        ...getProfileRelation(role)
      },
      include: {
        declarant: true,
        instructor: true
      }
    })

    if (createdUser.declarant) {
      await allowTemplateDeclarationTypeForDeclarant(createdUser.declarant.userId)
    }

    console.log('\u001B[32;1m%s\u001B[0m', '\n✓ Utilisateur créé avec succès\n')
    console.log('ID:', createdUser.id)
    console.log('Email:', createdUser.email)
    console.log('Nom:', createdUser.firstName, createdUser.lastName)
    console.log('Rôle:', createdUser.role)
    console.log('Profil:', getProfileLabel(createdUser))
    console.log()
  } catch (error) {
    console.error('\u001B[31;1m%s\u001B[0m', '\n✗ Erreur lors de la création de l\'utilisateur\n')
    console.error(error?.message || error)
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

await main()
