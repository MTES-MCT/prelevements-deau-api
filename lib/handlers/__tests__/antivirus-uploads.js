import {Buffer} from 'node:buffer'
import {createHash} from 'node:crypto'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {createDeclarationHandler} from '../declarations.js'
import {createDocument} from '../../services/document.js'
import {scanUploadedFiles} from '../../services/antivirus.js'

const userId = '11111111-1111-4111-8111-111111111111'
const file = (content = 'document sain') => ({buffer: Buffer.from(content), originalname: 'document.pdf', mimetype: 'application/pdf'})
const configuration = {NODE_ENV: 'production', CLAMAV_URL: 'https://scanner.example.test', CLAMAV_INVOKE_TOKEN: 'synthetic-token'}

function stub(t, object, key, replacement) {
  const original = object[key]
  object[key] = replacement
  t.teardown(() => { object[key] = original })
}

function scanner(calls, outcome) {
  return files => scanUploadedFiles(files, {env: configuration, async scanFile(buffer) {
    calls.push('scan')
    if (outcome === 'unavailable') throw new Error('private transport details')
    return {status: buffer.toString().includes('refusé') ? outcome : 'clean',
      engineVersion: '1.4.6', signatureVersion: '30000', signatureUpdatedAt: new Date().toISOString(),
      sha256: createHash('sha256').update(buffer).digest('hex')}
  }})
}

for (const [outcome, expectedStatus] of [['infected', 422], ['unscannable', 422], ['unavailable', 503]]) {
  test.serial(`une déclaration ${outcome} ne crée aucun dossier, fichier ou notification`, async t => {
    const calls = []
    stub(t, prisma.declarant, 'findUnique', async () => { calls.push('permissions'); return {declarantRole: 'PRELEVEUR'} })
    stub(t, prisma.declarantDeclarationType, 'findFirst', async () => {
      calls.push('type')
      return {declarationType: {id: 'type', code: 'template-file', name: 'Modèle', version: 1, isAvailable: true}}
    })
    stub(t, prisma.declaration, 'create', async () => { t.fail('No declaration may be created before every scan passes') })
    stub(t, prisma.declarationFile, 'create', async () => { t.fail('No file may be persisted') })
    stub(t, globalThis, 'fetch', async () => { t.fail('No orchestration request may be sent') })
    const scanFiles = scanner(calls, outcome)
    let failure
    await createDeclarationHandler({body: {type: 'template-file'}, files: [file(), file('document refusé')],
      user: {id: userId, role: 'DECLARANT'}}, {status() { t.fail('No successful response') }}, error => { failure = error },
    {scanFiles: (_req, _res, files) => scanFiles(files)})
    t.is(failure.status, expectedStatus)
    t.is(calls.filter(call => call === 'scan').length, 2)
    t.true(calls.lastIndexOf('permissions') < calls.indexOf('scan'))
    t.true(calls.indexOf('type') < calls.indexOf('scan'))
  })

  test.serial(`un document ${outcome} n’est ni stocké ni créé`, async t => {
    const calls = []
    stub(t, prisma.resourceDocument, 'create', async () => { t.fail('No document may be persisted') })
    const error = await t.throwsAsync(createDocument({
      payload: {nature: 'Autorisation IOTA', signatureDate: '2026-11-10'},
      file: file('document refusé'), declarantUserId: userId, user: {id: userId, role: 'ADMIN'},
      s3() { t.fail('No S3 upload before antivirus acceptance') }, scanFiles: scanner(calls, outcome)
    }))
    t.is(error.status, expectedStatus)
    t.deepEqual(calls, ['scan'])
  })
}

test.serial('les autorisations et validations du dépôt précèdent toujours l’analyse', async t => {
  const deniedFile = file('document refusé')
  stub(t, prisma.declarant, 'findUnique', async () => null)
  let failure
  await createDeclarationHandler({body: {type: 'template-file'}, files: [deniedFile], user: {id: userId}}, {},
    error => { failure = error }, {scanFiles: async () => t.fail('Unauthorized uploads must not reach scanner')})
  t.is(failure.status, 404)
  const error = await t.throwsAsync(createDocument({payload: {}, file: deniedFile, declarantUserId: userId,
    scanFiles: async () => t.fail('Invalid documents must not reach scanner')}))
  t.is(error.statusCode, 400)
})

test.serial('un document sain est analysé avant son stockage et sa création', async t => {
  const calls = []
  const uploaded = file()
  stub(t, prisma.resourceDocument, 'create', async ({data}) => {
    calls.push('database')
    return data
  })
  const result = await createDocument({
    payload: {nature: 'Autorisation IOTA', signatureDate: '2026-11-10'},
    file: uploaded, declarantUserId: userId, user: {id: userId, role: 'ADMIN'},
    s3: () => ({async uploadObject(_key, buffer) {
      calls.push('storage')
      t.is(buffer, uploaded.buffer)
    }}),
    scanFiles: scanner(calls, 'clean')
  })
  t.deepEqual(calls, ['scan', 'storage', 'database'])
  t.is(result.filename, 'document.pdf')
  t.is(result.declarantUserId, userId)
})
