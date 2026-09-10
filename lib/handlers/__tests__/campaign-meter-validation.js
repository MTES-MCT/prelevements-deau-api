import test from 'ava'
import express from 'express'
import request from 'supertest'
import {validateCampaignDraft} from '../../validation/campaigns.js'
import errorHandler from '../../util/error-handler.js'

test('les erreurs de date conservent data.issues dans la véritable enveloppe HTTP', async t => {
  const targetId = '10000000-0000-4000-8000-000000000001'
  const compteurId = '10000000-0000-4000-8000-000000000002'
  const app = express()
  app.use(express.json())
  app.post('/test-draft', (req, res) => {
    res.json(validateCampaignDraft('INDEX', req.body, {
      campaign: {indexDates: ['2026-01-01', '2026-07-01'], periods: []}, targets: [{id: targetId, meters: [{compteurId}]}]
    }))
  })
  app.use(errorHandler)
  const response = await request(app).post('/test-draft').send({meterEvents: [{
    targetId, previousCompteurId: compteurId, type: 'RESET', at: '2026-08-01', previousIndex: null, nextIndex: null, reason: 'À compléter'
  }]})
  t.is(response.status, 400)
  t.is(response.body.code, 400)
  t.deepEqual(response.body.data.issues, [{
    code: 'METER_EVENT_OUTSIDE_CAMPAIGN', severity: 'ERROR', targetId, compteurId, at: '2026-08-01', field: 'at',
    message: 'La date du changement doit être comprise entre le 01/01/2026 et le 01/07/2026.'
  }])
  t.is(response.body.message, response.body.data.issues[0].message)
  t.false(Object.hasOwn(response.body, 'issues'))
})
