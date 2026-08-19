import process from 'node:process'

import test from 'ava'
import express from 'express'
import request from 'supertest'

import {
  createResponseCompressionMiddleware,
  readResponseCompressionMinBytes,
  shouldCompressJson
} from './response-compression.js'

test.serial('readResponseCompressionMinBytes utilise un seuil sûr par défaut', t => {
  const previousValue = process.env.API_RESPONSE_COMPRESSION_MIN_BYTES
  t.teardown(() => {
    if (previousValue === undefined) {
      delete process.env.API_RESPONSE_COMPRESSION_MIN_BYTES
    } else {
      process.env.API_RESPONSE_COMPRESSION_MIN_BYTES = previousValue
    }
  })

  delete process.env.API_RESPONSE_COMPRESSION_MIN_BYTES
  t.is(readResponseCompressionMinBytes(), 1024)

  process.env.API_RESPONSE_COMPRESSION_MIN_BYTES = '2048'
  t.is(readResponseCompressionMinBytes(), 2048)

  process.env.API_RESPONSE_COMPRESSION_MIN_BYTES = 'invalid'
  t.is(readResponseCompressionMinBytes(), 1024)
})

test('shouldCompressJson exclut les pièces jointes et contenus déjà encodés', t => {
  const requestMock = {headers: {}}
  const createResponseMock = headers => ({
    getHeader(name) {
      return headers[name]
    }
  })

  t.true(shouldCompressJson(requestMock, createResponseMock({
    'Content-Type': 'application/problem+json; charset=utf-8'
  })))
  t.false(shouldCompressJson(requestMock, createResponseMock({
    'Content-Disposition': 'attachment; filename="export.json"',
    'Content-Type': 'application/json'
  })))
  t.false(shouldCompressJson(requestMock, createResponseMock({
    'Content-Encoding': 'gzip',
    'Content-Type': 'application/json'
  })))
  t.false(shouldCompressJson(requestMock, createResponseMock({
    'Content-Type': 'text/event-stream'
  })))
})

test.serial('compresse en gzip uniquement les réponses JSON dépassant le seuil', async t => {
  const previousValue = process.env.API_RESPONSE_COMPRESSION_MIN_BYTES
  t.teardown(() => {
    if (previousValue === undefined) {
      delete process.env.API_RESPONSE_COMPRESSION_MIN_BYTES
    } else {
      process.env.API_RESPONSE_COMPRESSION_MIN_BYTES = previousValue
    }
  })
  process.env.API_RESPONSE_COMPRESSION_MIN_BYTES = '1024'

  const app = express()
  app.use(createResponseCompressionMiddleware())
  app.get('/large', (request_, response) => {
    response.json({value: 'compressible '.repeat(1000)})
  })
  app.get('/small', (request_, response) => {
    response.json({value: 'small'})
  })

  const largeResponse = await request(app)
    .get('/large')
    .set('Accept-Encoding', 'gzip')
  const smallResponse = await request(app)
    .get('/small')
    .set('Accept-Encoding', 'gzip')

  t.is(largeResponse.headers['content-encoding'], 'gzip')
  t.regex(largeResponse.headers.vary, /accept-encoding/i)
  t.is(smallResponse.headers['content-encoding'], undefined)
})
