import test from 'ava'
import express from 'express'
import request from 'supertest'
import {createCampaignFollowupHandlers} from '../campaign-followup.js'
import {createRoutes} from '../../routes.js'

const campaignId = '10000000-0000-4000-8000-000000000001'
const preleveurUserId = '10000000-0000-4000-8000-000000000002'
const user = {id: '10000000-0000-4000-8000-000000000003', role: 'ADMIN'}

function fixture() {
  const calls = []
  const load = name => async (...args) => {
    calls.push({name, args})
    return {loaded: name}
  }

  const handlers = createCampaignFollowupHandlers({getSummary: load('summary'), listOverview: load('overview'), getResults: load('results')})
  const app = express()
  app.use((req, res, next) => {
    req.user = user
    next()
  })
  app.get('/campaigns/:campaignId/responses/summary', handlers.getCampaignResponseSummaryHandler)
  app.get('/campaigns/:campaignId/responses/overview', handlers.listCampaignResponseOverviewHandler)
  app.get('/campaigns/:campaignId/responses/results', handlers.getCampaignResponseResultsHandler)
  app.use((error, req, res, _next) => {
    res.status(error.statusCode || 500).json({message: error.message})
  })
  return {app, calls}
}

test('les trois handlers renvoient l’enveloppe existante et transmettent utilisateur, campagne et paramètres validés', async t => {
  const {app, calls} = fixture()
  const responses = await Promise.all([
    request(app).get(`/campaigns/${campaignId}/responses/summary`),
    request(app).get(`/campaigns/${campaignId}/responses/overview?limit=10&status=missing&q=Forage&cursor=${preleveurUserId}`),
    request(app).get(`/campaigns/${campaignId}/responses/results?preleveurUserId=${preleveurUserId}`)
  ])
  t.true(responses.every(response => response.status === 200))
  t.true(responses.every(response => response.headers['cache-control'] === 'no-store'))
  t.deepEqual(responses.map(response => response.body), ['summary', 'overview', 'results'].map(loaded => ({success: true, data: {loaded}})))
  t.deepEqual(calls.find(call => call.name === 'summary').args, [user, campaignId])
  t.deepEqual(calls.find(call => call.name === 'overview').args, [user, campaignId, {limit: 10, status: 'missing', q: 'Forage', cursor: preleveurUserId}])
  t.deepEqual(calls.find(call => call.name === 'results').args, [user, campaignId, {preleveurUserId}])
})

test('le handler overview fixe les valeurs par défaut sans interpréter une absence de filtre comme un statut', async t => {
  const {app, calls} = fixture()
  const response = await request(app).get(`/campaigns/${campaignId}/responses/overview`)
  t.is(response.status, 200)
  t.deepEqual(calls[0].args[2], {limit: 20, q: '', status: 'all'})
})

test('les handlers rejettent paramètres surnuméraires, tableaux, identifiants et filtres invalides avant tout service', async t => {
  const {app, calls} = fixture()
  const paths = [
    '/campaigns/bad-id/responses/summary',
    `/campaigns/${campaignId}/responses/summary?preleveurUserId=${preleveurUserId}`,
    `/campaigns/${campaignId}/responses/overview?limit=101`,
    `/campaigns/${campaignId}/responses/overview?status=other`,
    `/campaigns/${campaignId}/responses/overview?q=a&q=b`,
    `/campaigns/${campaignId}/responses/overview?cursor=bad-id`,
    `/campaigns/${campaignId}/responses/results`,
    `/campaigns/${campaignId}/responses/results?preleveurUserId=bad-id`,
    `/campaigns/${campaignId}/responses/results?preleveurUserId=${preleveurUserId}&draft=true`
  ]
  const responses = await Promise.all(paths.map(path => request(app).get(path)))
  t.true(responses.every(response => response.status === 400))
  t.deepEqual(calls, [])
})

test('les trois vraies routes restent protégées sans session', async t => {
  const app = express()
  const router = createRoutes()
  app.use('/', router)
  app.use('/api', router)
  app.use((error, req, res, _next) => {
    res.status(error.statusCode || 500).json({message: error.message})
  })
  const paths = ['', '/api'].flatMap(prefix => ['summary', 'overview', `results?preleveurUserId=${preleveurUserId}`]
    .map(suffix => `${prefix}/campaigns/${campaignId}/responses/${suffix}`))
  const responses = await Promise.all(paths.map(path => request(app).get(path)))
  t.true(responses.every(response => response.status === 401))
})
