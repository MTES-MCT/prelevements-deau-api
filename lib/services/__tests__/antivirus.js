import {Buffer} from 'node:buffer'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {EventEmitter} from 'node:events'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import test from 'ava'
import {MAX_SIGNATURE_AGE_MS, scanRequestFiles, scanUploadedFiles} from '../antivirus.js'

const now = Date.now()
const env = {NODE_ENV: 'production', CLAMAV_URL: 'https://scanner.example.test', CLAMAV_INVOKE_TOKEN: 'synthetic-scanner-only-token'}
const files = [{buffer: Buffer.from('document sain')}, {buffer: Buffer.from('autre document sain')}]
const verdict = (buffer, changes = {}) => ({status: 'clean', engineVersion: '1.4.6', signatureVersion: '30001',
  signatureUpdatedAt: new Date(now - 3600_000).toISOString(), sha256: createHash('sha256').update(buffer).digest('hex'), ...changes})
let directory
let certificate
let key

test.before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'antivirus-client-test-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', path.join(directory, 'key.pem'), '-out', path.join(directory, 'ca.pem'),
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], {stdio: 'ignore'})
  const pem = await Promise.all(['ca.pem', 'key.pem'].map(name => readFile(path.join(directory, name))))
  certificate = pem[0]
  key = pem[1]
})

test.after.always(async () => { if (directory) await rm(directory, {recursive: true, force: true}) })

async function server(t, handler) {
  const app = https.createServer({key, cert: certificate}, handler)
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))
  t.teardown(async () => {
    app.closeAllConnections()
    await new Promise(resolve => app.close(resolve))
  })
  return {...env, CLAMAV_URL: `https://127.0.0.1:${app.address().port}`, CLAMAV_CA_FILE: path.join(directory, 'ca.pem')}
}

test('tous les fichiers sont attestés avec une concurrence maximale de deux', async t => {
  let active = 0
  let maximum = 0
  const batch = [...files, ...files, ...files]
  const result = await scanUploadedFiles(batch, {env, now: () => now, async scanFile(buffer) {
    active++
    maximum = Math.max(maximum, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active--
    return verdict(buffer)
  }})
  t.is(result.files.length, batch.length)
  t.is(maximum, 2)
  t.deepEqual(result.files.map(file => file.sha256), batch.map(file => verdict(file.buffer).sha256))
})

for (const status of ['infected', 'unscannable']) {
  test(`le verdict ${status} refuse le dépôt entier sans lancer les fichiers suivants`, async t => {
    let calls = 0
    const error = await t.throwsAsync(scanUploadedFiles([...files, ...files], {env, now: () => now, async scanFile(buffer, {signal}) {
      calls++
      if (calls === 1) return verdict(buffer, {status})
      await new Promise(resolve => signal.addEventListener('abort', resolve, {once: true}))
      throw new Error('cancelled')
    }}))
    t.is(error.status, 422)
    t.is(calls, 2)
    t.regex(error.message, /Aucun fichier du dépôt/)
  })
}

for (const changes of [{status: 'unknown'}, {engineVersion: ''}, {signatureVersion: null}, {sha256: 'wrong'},
  {signatureUpdatedAt: new Date(now - MAX_SIGNATURE_AGE_MS - 1).toISOString()},
  {signatureUpdatedAt: new Date(now + 120_000).toISOString()}, {signatureUpdatedAt: 'invalid'}]) {
  test(`un résultat non attesté est indisponible : ${JSON.stringify(changes)}`, async t => {
    const error = await t.throwsAsync(scanUploadedFiles(files, {env, now: () => now,
      scanFile: async buffer => verdict(buffer, changes)}))
    t.is(error.status, 503)
    t.is(error.retryAfterSeconds, 30)
  })
}

test('une configuration absente ou désactivée en production bloque les nouveaux dépôts', async t => {
  for (const configuration of [{NODE_ENV: 'production'}, {NODE_ENV: 'production', CLAMAV_DISABLED: 'true'},
    {...env, CLAMAV_URL: 'http://scanner.example.test'}, {...env, CLAMAV_URL: 'https://other.example.test/scan'},
    {...env, CLAMAV_INVOKE_TOKEN: ''}]) {
    // eslint-disable-next-line no-await-in-loop
    const error = await t.throwsAsync(scanUploadedFiles(files, {env: configuration}))
    t.is(error.status, 503)
  }
  t.deepEqual(await scanUploadedFiles(files, {env: {NODE_ENV: 'test', CLAMAV_DISABLED: 'true'}}), {skipped: true})
})

test('le client HTTPS valide la CA et envoie seulement les octets et le jeton dédié', async t => {
  const received = []
  const configured = await server(t, async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const bytes = Buffer.concat(chunks)
    received.push({path: request.url, token: request.headers.authorization, type: request.headers['content-type'], bytes})
    response.writeHead(200, {'Content-Type': 'application/json'})
    response.end(JSON.stringify(verdict(bytes)))
  })
  const result = await scanUploadedFiles(files, {env: configured})
  t.is(result.files.length, 2)
  t.is(received.length, 2)
  t.true(received.every(item => item.path === '/scan' && item.token === `Bearer ${env.CLAMAV_INVOKE_TOKEN}` && item.type === 'application/octet-stream'))
  t.deepEqual(received.map(item => item.bytes).sort(Buffer.compare), files.map(file => file.buffer).sort(Buffer.compare))
  const error = await t.throwsAsync(scanUploadedFiles(files, {env: {...configured, CLAMAV_CA_FILE: ''}}))
  t.is(error.status, 503)
  t.is(received.length, 2)
})

for (const [label, status, type, body] of [
  ['redirection', 302, 'application/json', '{}'], ['erreur serveur', 503, 'application/json', '{}'],
  ['HTML', 200, 'text/html', '<html>ok</html>'], ['JSON invalide', 200, 'application/json', '{'],
  ['réponse trop grande', 200, 'application/json', ' '.repeat(5000)]
]) {
  test(`le transport refuse ${label} sans communiquer de données sensibles`, async t => {
    const configured = await server(t, (_request, response) => {
      response.writeHead(status, {'Content-Type': type, Location: 'https://unexpected.example.test'})
      response.end(body)
    })
    const error = await t.throwsAsync(scanUploadedFiles(files, {env: configured}))
    t.is(error.status, 503)
    t.false(error.message.includes(env.CLAMAV_INVOKE_TOKEN))
    t.false(error.message.includes(configured.CLAMAV_URL))
  })
}

test('le délai global annule les connexions lentes', async t => {
  const configured = await server(t, request => request.resume())
  const began = Date.now()
  const error = await t.throwsAsync(scanUploadedFiles(files, {env: configured, timeoutMs: 100}))
  t.is(error.status, 503)
  t.true(Date.now() - began < 2000)
})

test('la fermeture du client annule les analyses et les listeners sont libérés', async t => {
  const request = new EventEmitter()
  const response = new EventEmitter()
  let started
  const ready = new Promise(resolve => { started = resolve })
  const pending = scanRequestFiles(request, response, files, {scanner: async (_files, {signal}) => {
    started()
    await new Promise(resolve => signal.addEventListener('abort', resolve, {once: true}))
    throw new Error('cancelled')
  }})
  await ready
  response.emit('close')
  await t.throwsAsync(pending, {message: 'cancelled'})
  t.is(response.listenerCount('close'), 0)
  t.is(request.listenerCount('aborted'), 0)
})

test('l’audit reçoit les empreintes et les versions, sans nom ni contenu de fichier', async t => {
  const request = {auditEventId: 'synthetic'}
  const report = {files: [{engineVersion: '1.4.6', sha256: 'synthetic-hash'}]}
  await scanRequestFiles(request, {}, files, {scanner: async () => report})
  t.deepEqual(request.auditContext.metadata.antivirus, report)
  t.false(JSON.stringify(request.auditContext).includes(files[0].buffer.toString()))
})
