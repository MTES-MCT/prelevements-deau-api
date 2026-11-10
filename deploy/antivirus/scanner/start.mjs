import {spawn} from 'node:child_process'
import {setTimeout as delay} from 'node:timers/promises'
import {getEngineVersion} from './clamd.mjs'
import {createScannerServer} from './server.mjs'

const server = createScannerServer()
const daemon = spawn('clamd', ['--config-file=/app/clamd.conf', '--foreground'], {stdio: ['ignore', 'ignore', 'inherit']})
let listening = false
let stopping = false
function stop(exitCode = 0) {
  if (stopping) return
  stopping = true
  server?.close()
  server?.closeAllConnections()
  daemon.kill('SIGTERM')
  process.exitCode = exitCode
  setTimeout(() => process.exit(exitCode), 4000).unref()
}
daemon.once('error', () => stop(1))
daemon.once('exit', () => stop(stopping ? process.exitCode : 1))
process.once('SIGTERM', () => stop())
process.once('SIGINT', () => stop())

const deadline = Date.now() + 110_000
while (!stopping && Date.now() < deadline) {
  try {
    // Bind HTTP only when ClamAV has loaded a recent, valid signature database.
    // There are no outbound requests, timers that invoke this service, or freshclam daemon.
    // eslint-disable-next-line no-await-in-loop -- A bounded readiness poll is sequential.
    await getEngineVersion()
    server.listen(Number(process.env.PORT || 8080), '0.0.0.0')
    listening = true
    break
  } catch {
    // eslint-disable-next-line no-await-in-loop -- Back off between readiness checks.
    await delay(250)
  }
}
if (!listening) stop(1)
