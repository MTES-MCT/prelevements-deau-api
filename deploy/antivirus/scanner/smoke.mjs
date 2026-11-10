import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {randomBytes, randomUUID, createHash} from 'node:crypto'
import {mkdtemp, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {crc32, deflateRawSync} from 'node:zlib'

const image = process.argv[2]
assert(image, 'Usage: node smoke.mjs IMAGE')
const token = randomBytes(32).toString('hex')
const directory = await mkdtemp(join(tmpdir(), 'clamav-smoke-'))
const container = `clamav-smoke-${randomUUID()}`
const started = Date.now()
const report = {image, checks: []}
const docker = (...args) => execFileSync('docker', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim()

function zipCrypto(content, crc) {
  const keys = [0x12345678, 0x23456789, 0x34567890]
  const crcByte = (previous, byte) => (crc32(Buffer.from([byte]), (previous ^ 0xffffffff) >>> 0) ^ 0xffffffff) >>> 0
  function update(byte) {
    keys[0] = crcByte(keys[0], byte)
    keys[1] = (Math.imul((keys[1] + (keys[0] & 255)) >>> 0, 134775813) + 1) >>> 0
    keys[2] = crcByte(keys[2], keys[1] >>> 24)
  }
  for (const byte of Buffer.from('fixture-only')) update(byte)
  const header = Buffer.alloc(12)
  header[11] = crc >>> 24
  return Buffer.from([...Buffer.concat([header, content])].map(byte => {
    const temporary = (keys[2] | 2) & 0xffff
    const encrypted = byte ^ ((Math.imul(temporary, temporary ^ 1) >>> 8) & 255)
    update(byte)
    return encrypted
  }))
}

// Small ZIP fixtures, including a password-protected ZipCrypto archive, without
// a platform-specific ZIP command or a real user document.
function zip(content, encrypted = false) {
  const name = Buffer.from('fixture.txt')
  const deflated = deflateRawSync(content)
  const compressed = encrypted ? zipCrypto(deflated, crc32(content)) : deflated
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(encrypted ? 1 : 0, 6)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(crc32(content), 14)
  local.writeUInt32LE(compressed.length, 18)
  local.writeUInt32LE(content.length, 22)
  local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50)
  central.writeUInt16LE(20, 4)
  local.copy(central, 6, 4, 28)
  central.writeUInt16LE(name.length, 28)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + name.length, 12)
  end.writeUInt32LE(local.length + name.length + compressed.length, 16)
  return Buffer.concat([local, name, compressed, central, name, end])
}

try {
  const nodeVersion = docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '--version')
  assert.equal(nodeVersion, 'v24.22.1', 'Pinned Node runtime version')
  report.nodeVersion = nodeVersion
  const environmentFile = join(directory, 'container.env')
  await writeFile(environmentFile, `CLAMAV_INVOKE_TOKEN=${token}\n`, {mode: 0o600})
  docker('run', '--detach', '--rm', '--name', container, '--memory', '4g', '--cpus', '2',
    '--env-file', environmentFile, '--publish', '127.0.0.1::8080', image)
  const binding = docker('port', container, '8080/tcp')
  assert.match(binding, /^127\.0\.0\.1:\d+$/)
  const base = `http://${binding}`
  let healthy = false
  while (Date.now() - started < 120_000) {
    try {
      // eslint-disable-next-line no-await-in-loop -- Poll this isolated container until ready.
      const response = await fetch(`${base}/healthz`, {headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(2000)})
      if (response.ok) {
        // eslint-disable-next-line no-await-in-loop
        report.health = await response.json()
        healthy = true
        break
      }
    } catch { /* Connection refusal is expected while the daemon starts. */ }
    // eslint-disable-next-line no-await-in-loop
    await delay(300)
  }
  assert(healthy, 'Scanner did not become ready within 120s')
  report.startupMs = Date.now() - started
  assert.equal((await fetch(`${base}/healthz`)).status, 401)
  assert.equal((await fetch(`${base}/readyz`)).status, 200)
  async function scan(name, bytes, expected) {
    const start = Date.now()
    const response = await fetch(`${base}/scan`, {method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream'
    }, body: bytes, signal: AbortSignal.timeout(120_000)})
    assert.equal(response.status, 200, `${name}: HTTP status`)
    const result = await response.json()
    assert.equal(result.status, expected, `${name}: scan verdict`)
    assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'), `${name}: byte integrity`)
    assert.equal(result.bytes, bytes.length)
    assert(result.engineVersion && result.signatureVersion && result.signatureUpdatedAt)
    report.checks.push({name, verdict: result.status, bytes: bytes.length, durationMs: Date.now() - start})
  }
  const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')
  await scan('clean-text', Buffer.from('Index;Volume\n2026-11-10;12\n'), 'clean')
  await scan('eicar', eicar, 'infected')
  await scan('eicar-zip', zip(eicar), 'infected')
  await scan('encrypted-zip', zip(Buffer.from('protected content'), true), 'unscannable')
  await scan('expanded-file-limit', zip(Buffer.alloc(200 * 1024 * 1024 + 1, 'A')), 'unscannable')
  await scan('extractor-truncation-limit', zip(Buffer.alloc(400 * 1024 * 1024 + 1, 'A')), 'unscannable')
  await scan('maximum-50MB', Buffer.alloc(50_000_000, 'A'), 'clean')
  const oversized = await fetch(`${base}/scan`, {method: 'POST', headers: {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream'
  }, body: Buffer.alloc(50_000_001), signal: AbortSignal.timeout(10_000)})
  assert.equal(oversized.status, 413)
  report.checks.push({name: 'oversized', httpStatus: oversized.status})
  report.resourceUsage = docker('stats', '--no-stream', '--format', '{{.MemUsage}}', container)
  report.success = true
  console.log(JSON.stringify(report))
} catch (error) {
  // Container logs contain only scanner diagnostics; never dump the invocation token.
  try {console.error(docker('logs', container))} catch { /* A failed start may leave no container. */ }
  throw error
} finally {
  try {docker('rm', '--force', container)} catch { /* --rm may already have removed it. */ }
  await rm(directory, {recursive: true, force: true})
}
