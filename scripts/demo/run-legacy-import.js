#!/usr/bin/env node

import '../../lib/config/env.js'

import {spawnSync} from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'

import {
  authorizeLegacyDemoMutation,
  printLegacyAuthorization
} from './legacy-demo-guard.js'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectDirectory = path.resolve(scriptDirectory, '../..')

function runScript(scriptPath, arguments_ = []) {
  const result = spawnSync(process.execPath, [scriptPath, ...arguments_], {
    cwd: projectDirectory,
    env: process.env,
    stdio: 'inherit'
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(`${scriptPath} a échoué avec le statut ${result.status}.`)
  }
}

function main() {
  const authorization = authorizeLegacyDemoMutation({requireLocalServices: true})
  printLegacyAuthorization(authorization, 'zones, fixtures et déclarations')

  if (!authorization.authorized) {
    return
  }

  const childArguments = [
    '--apply',
    `--confirm-legacy=${authorization.expectedConfirmation}`
  ]

  runScript('scripts/import-zones.js')
  runScript('scripts/demo/init-demo-fixtures.js', childArguments)
  runScript('scripts/demo/init-demo-declarations.js', childArguments)
}

try {
  main()
} catch (error) {
  console.error(error?.message ?? error)
  process.exitCode = 1
}
