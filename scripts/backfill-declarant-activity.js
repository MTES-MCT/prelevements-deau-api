#!/usr/bin/env node
import '../lib/config/env.js'
import process from 'node:process'

import {prisma} from '../db/prisma.js'
import {
  previewDeclarantsLastDeclarationAt,
  refreshAllDeclarantsLastDeclarationAt
} from '../lib/models/declarant.js'

function parseMode(arguments_) {
  const apply = arguments_.includes('--apply')
  const dryRun = arguments_.includes('--dry-run')
  const knownArguments = new Set(['--apply', '--dry-run'])
  const unknownArguments = arguments_.filter(argument => !knownArguments.has(argument))

  if (unknownArguments.length > 0) {
    throw new Error(`Argument(s) inconnu(s) : ${unknownArguments.join(', ')}.`)
  }

  if (apply === dryRun) {
    throw new Error('Précisez exactement un mode : --dry-run ou --apply.')
  }

  return {apply}
}

function summarize(rows) {
  return {
    changed: rows.length,
    setToDate: rows.filter(row => row.lastDeclarationAt !== null).length,
    setToNull: rows.filter(row => row.lastDeclarationAt === null).length
  }
}

try {
  const {apply} = parseMode(process.argv.slice(2))
  const preview = await previewDeclarantsLastDeclarationAt()
  const before = summarize(preview)

  if (apply) {
    const updated = await refreshAllDeclarantsLastDeclarationAt()
    const remaining = await previewDeclarantsLastDeclarationAt()
    const result = {
      mode: 'apply',
      planned: before.changed,
      updated: updated.length,
      remaining: remaining.length
    }

    console.log(JSON.stringify(result, null, 2))

    if (remaining.length > 0) {
      throw new Error('Le rattrapage de l’activité déclarative est incomplet.')
    }
  } else {
    console.log(JSON.stringify({mode: 'dry-run', ...before}, null, 2))
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await prisma.$disconnect()
}
