import process from 'node:process'
import {readFile} from 'node:fs/promises'
import pg from 'pg'
import {reviewRepair, applyRepair, rollbackRepair} from './lib/repair.js'
import {CliError, parseOptions, assertPrivateOutput, writePrivateJson, verifyBackupProof, connectionOptions, assertTarget} from './lib/cli.js'

process.umask(0o077)
let client
try {
  const options = parseOptions(process.argv.slice(2))
  const {command, values, output} = options
  await assertPrivateOutput(output)
  const against = command === 'review' ? null
    : JSON.parse(await readFile(values[command === 'apply' ? 'against-report' : 'against-receipt'], 'utf8'))
  if (command === 'apply') await verifyBackupProof(values['backup-proof'], values.target, against)
  client = new pg.Client(await connectionOptions(options))
  await client.connect()
  await assertTarget(client, values.target)
  if (command === 'review') await client.query('SET default_transaction_read_only = on')
  let preparedWritten = false
  const operationOptions = {
    target: values.target,
    async persistPrepared(receipt) {
      await writePrivateJson(output, receipt)
      preparedWritten = true
    }
  }
  const result = command === 'review' ? await reviewRepair(client, operationOptions)
    : command === 'apply' ? await applyRepair(client, against, operationOptions)
      : await rollbackRepair(client, against, operationOptions)
  await writePrivateJson(output, result, {replace: preparedWritten})
  console.log(JSON.stringify({command, target: values.target, output, summary: result.summary ?? result.review?.summary,
    status: result.status, changes: result.changes?.length}))
} catch (error) {
  // Database errors may contain credentials or personal data: only expose a
  // machine code, keeping the private PREPARED receipt available for recovery.
  console.error(error instanceof CliError ? error.message : JSON.stringify({error: 'SAGE_OVERLAP_FAILED',
    code: /^[A-Z0-9_]{1,80}$/.test(error.code ?? '') ? error.code : 'OPERATION_FAILED'}))
  process.exitCode = 1
} finally {
  await client?.end()
}
