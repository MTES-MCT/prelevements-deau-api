import {Buffer} from 'node:buffer'
import http from 'node:http'
import {once} from 'node:events'
import test from 'ava'
import express from 'express'
import request from 'supertest'
import {createUpload, MAX_UPLOAD_BYTES} from '../upload.js'

function createApp() {
  const app = express()
  app.post('/upload', createUpload({fileSize: 32}).single('file'), (req, res) => {
    res.json({name: req.file.originalname, content: req.file.buffer.toString('utf8'), fields: req.body})
  })
  app.use((error, _req, res, _next) => res.status(400).json({code: error.code || 'INVALID_MULTIPART'}))
  return app
}

test('Multer accepte le fichier et les champs, avec le plafond historique de 50 Mo', async t => {
  t.is(MAX_UPLOAD_BYTES, 50_000_000)
  const response = await request(createApp()).post('/upload')
    .field('comment', 'Relevé compteur')
    .attach('file', Buffer.from('Index;123'), 'compteur.csv')
  t.is(response.status, 200)
  t.deepEqual(response.body, {name: 'compteur.csv', content: 'Index;123', fields: {comment: 'Relevé compteur'}})
})

test('Multer refuse un fichier trop gros et une partie fichier inattendue', async t => {
  const tooBig = await request(createApp()).post('/upload').attach('file', Buffer.alloc(33), 'compteur.csv')
  t.is(tooBig.status, 400)
  t.is(tooBig.body.code, 'LIMIT_FILE_SIZE')
  const unexpected = await request(createApp()).post('/upload').attach('other', Buffer.from('index'), 'compteur.csv')
  t.is(unexpected.status, 400)
  t.is(unexpected.body.code, 'LIMIT_UNEXPECTED_FILE')
})

test('un multipart tronqué est rejeté et la requête suivante fonctionne', async t => {
  const app = createApp()
  const malformed = await request(app).post('/upload')
    .set('Content-Type', 'multipart/form-data; boundary=test-boundary')
    .send('--test-boundary\r\nContent-Disposition: form-data; name="file"; filename="a.csv"\r\n\r\nincomplete')
  t.is(malformed.status, 400)
  t.is(malformed.body.code, 'INVALID_MULTIPART')
  const healthy = await request(app).post('/upload').attach('file', Buffer.from('index'), 'compteur.csv')
  t.is(healthy.status, 200)
})

test('une déconnexion pendant le téléversement ne fait pas tomber le serveur', async t => {
  const app = createApp()
  const server = http.createServer(app)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.teardown(async () => {
    server.closeAllConnections()
    await new Promise(resolve => {
      server.close(resolve)
    })
  })
  const incomingRequest = once(server, 'request')
  const outgoing = http.request({
    host: '127.0.0.1', port: server.address().port, path: '/upload', method: 'POST',
    headers: {'Content-Type': 'multipart/form-data; boundary=abort-test', 'Content-Length': '1000'}
  })
  outgoing.on('error', () => {})
  outgoing.write('--abort-test\r\nContent-Disposition: form-data; name="file"; filename="a.csv"\r\n\r\n12')
  const [incoming] = await incomingRequest
  const aborted = once(incoming, 'aborted')
  outgoing.destroy()
  await aborted
  const healthy = await request(server).post('/upload').attach('file', Buffer.from('index'), 'compteur.csv')
  t.is(healthy.status, 200)
})
