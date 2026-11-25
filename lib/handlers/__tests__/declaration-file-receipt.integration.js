import {Buffer} from 'node:buffer'
import {randomUUID} from 'node:crypto'
import process from 'node:process'
import test from 'ava'
import {prisma} from '../../../db/prisma.js'
import {allowTemplateDeclarationTypeForDeclarant} from '../../models/declaration-type.js'
import {requireDisposableDatabase} from '../../util/test-helpers/disposable-database.js'
import {createDeclarationHandler} from '../declarations.js'

const enabled = process.env.METER_INTEGRATION_TESTS === '1'
const integration = enabled ? test.serial : test.skip
test.before(() => { if (enabled) requireDisposableDatabase() })
test.after.always(async () => { await prisma.$disconnect(); await globalThis.pgPool?.end() })

async function submit(t, {failUpload = false, rejectScan = false, failProcessing = false} = {}) {
  const user = await prisma.user.create({data: {role: 'DECLARANT', email: randomUUID() + '@example.test',
    declarant: {create: {declarantRole: 'COLLECTEUR', socialReason: 'Collecteur de test', declarationNotificationsEnabled: false}}}})
  t.teardown(() => prisma.user.delete({where: {id: user.id}}))
  await allowTemplateDeclarationTypeForDeclarant(user.id)

  const oldRequired = process.env.ORCHESTRATION_REQUIRED
  const oldUrl = process.env.ORCHESTRATION_BASE_URL
  Object.assign(process.env, {ORCHESTRATION_REQUIRED: String(failProcessing), ORCHESTRATION_BASE_URL: ''})
  t.teardown(() => {
    if (oldRequired === undefined) delete process.env.ORCHESTRATION_REQUIRED
    else process.env.ORCHESTRATION_REQUIRED = oldRequired
    if (oldUrl === undefined) delete process.env.ORCHESTRATION_BASE_URL
    else process.env.ORCHESTRATION_BASE_URL = oldUrl
  })

  const filenames = ['second fichier.xlsx', 'premier.xlsx']
  const files = filenames.map(originalname => ({originalname, buffer: Buffer.from('test'), mimetype: 'application/octet-stream'}))
  const objects = new Set()
  const storage = {
    async uploadObject(key) {
      if (failUpload && objects.size > 0) throw new Error('Échec du second fichier')
      objects.add(key)
    },
    async deleteObject(key) { objects.delete(key) },
    async getPresignedUrl() { return 'https://storage.example.test/temporary' }
  }
  let response
  let error
  await createDeclarationHandler({user, body: {type: 'template-file'}, files},
    {status: status => ({json(body) { response = {status, body} }})}, caught => { error = caught },
    {storageClient: () => storage, scanFiles: async () => { if (rejectScan) throw new Error('Fichier refusé') }})
  const deposits = await prisma.declaration.findMany({where: {createdByDeclarantUserId: user.id},
    include: {files: true, receipts: true}})
  return {user, deposits, response, error, objects}
}

integration('un dossier de deux fichiers crée un seul mail avec les noms déposés dans leur ordre', async t => {
  const {user, deposits: [declaration], response, error} = await submit(t)
  t.is(error, undefined)
  t.is(response.status, 201)
  t.is(declaration.files.length, 2)
  t.is(declaration.receipts.length, 1)
  const [receipt] = declaration.receipts
  t.like(receipt, {kind: 'FILES_RECEIVED', status: 'PENDING', recipientEmail: user.email, revision: 0})
  t.deepEqual(receipt.snapshot, {code: declaration.code, declarantName: 'Collecteur de test',
    declarationType: 'Modèle de déclaration de volumes', files: ['second_fichier.xlsx', 'premier.xlsx']})
})

for (const [step, options] of [['antivirus', {rejectScan: true}], ['second fichier', {failUpload: true}]]) {
  integration(`un échec au stade « ${step} » ne laisse ni pièces ni mail`, async t => {
    const result = await submit(t, options)
    t.truthy(result.error)
    t.is(result.objects.size, 0)
    t.is(result.deposits.length, 0)
  })
}

integration('une panne du traitement après le dépôt conserve les fichiers et leur unique confirmation de réception', async t => {
  const {deposits: [declaration], error, objects} = await submit(t, {failProcessing: true})
  t.truthy(error)
  t.is(declaration.processingStatus, 'FAILED')
  t.is(objects.size, 2)
  t.is(declaration.receipts.length, 1)
  t.is(declaration.receipts[0].kind, 'FILES_RECEIVED')
})
