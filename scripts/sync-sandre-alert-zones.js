#!/usr/bin/env node
import '../lib/config/env.js'
import process from 'node:process'

import {prisma} from '../db/prisma.js'
import {synchronizeSandreAlertZones} from '../lib/services/sandre-alert-zone-sync.js'

function parseArguments(arguments_) {
  const apply = arguments_.includes('--apply')
  const dryRun = arguments_.includes('--dry-run')
  if (apply === dryRun) {
    throw new Error('Précisez exactement un mode : --dry-run ou --apply.')
  }

  const departmentCodes = arguments_
    .filter(argument => argument.startsWith('--department='))
    .map(argument => argument.slice('--department='.length))

  const knownArguments = new Set(['--apply', '--dry-run'])
  const unknownArguments = arguments_.filter(argument => (
    !knownArguments.has(argument) && !argument.startsWith('--department=')
  ))
  if (unknownArguments.length > 0) {
    throw new Error(`Argument(s) inconnu(s) : ${unknownArguments.join(', ')}.`)
  }

  return {
    apply,
    ...(departmentCodes.length > 0 ? {departmentCodes} : {})
  }
}

try {
  const options = parseArguments(process.argv.slice(2))
  const result = await synchronizeSandreAlertZones(options)
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(error.summary ? JSON.stringify(error.summary, null, 2) : error)
  process.exitCode = 1
} finally {
  await prisma.$disconnect()
}
