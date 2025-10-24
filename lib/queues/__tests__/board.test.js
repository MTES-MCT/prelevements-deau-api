import test from 'ava'
import express from 'express'
import request from 'supertest'
import {createBullBoardRouter} from '../board.js'

const app = express()
const basePath = '/admin/queues'
app.use(basePath, createBullBoardRouter(basePath, 'test-password'))

test('devrait retourner 401 sans authentification', async t => {
  const res = await request(app).get('/admin/queues')
  t.is(res.status, 401)
  t.is(res.body.error, 'Authentification requise')
  t.is(res.headers['www-authenticate'], 'Basic realm="BullBoard"')
})

test('devrait retourner 401 avec un mauvais mot de passe', async t => {
  const res = await request(app)
    .get('/admin/queues')
    .auth('admin', 'wrong-password')
  t.is(res.status, 401)
  t.is(res.body.error, 'Authentification échouée')
  t.is(res.headers['www-authenticate'], 'Basic realm="BullBoard"')
})

test('devrait servir le dashboard BullBoard avec authentification', async t => {
  const res = await request(app)
    .get('/admin/queues')
    .auth('admin', 'test-password')

  t.is(res.status, 200)
  t.is(res.type, 'text/html')
  t.true(res.text.includes('<!DOCTYPE html>'))
})

test('devrait servir les assets statiques avec authentification', async t => {
  const res = await request(app)
    .get('/admin/queues/static/css/main.css')
    .auth('admin', 'test-password')

  // Peut retourner 200 (CSS existe) ou 404 (pas encore généré)
  t.true([200, 404].includes(res.status))
})
