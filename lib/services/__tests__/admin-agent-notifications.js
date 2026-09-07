import test from 'ava'

import {sendAdminAgentAccountNotification} from '../admin-agent-notifications.js'

const AGENT = {
  email: 'agent@example.test',
  firstName: 'Camille',
  lastName: 'Rivière'
}

test('sendAdminAgentAccountNotification alerte toutes les adresses uniques après un changement', async t => {
  const sent = []
  const result = await sendAdminAgentAccountNotification({
    type: 'EMAIL_CHANGED',
    agent: {...AGENT, email: 'nouvelle@example.test'},
    previousEmail: AGENT.email,
    newEmail: 'nouvelle@example.test',
    recipients: [AGENT.email, 'nouvelle@example.test', AGENT.email]
  }, {
    send: async (...arguments_) => sent.push(arguments_)
  })

  t.true(result)
  t.deepEqual(sent.map(([recipient]) => recipient), [
    AGENT.email,
    'nouvelle@example.test'
  ])
  t.true(sent.every(([, subject]) => subject.includes('adresse de connexion')))
})

test('sendAdminAgentAccountNotification ignore un type inconnu ou sans destinataire', async t => {
  let sendCount = 0
  const send = async () => {
    sendCount++
  }

  t.false(await sendAdminAgentAccountNotification({
    type: 'UNKNOWN',
    recipients: [AGENT.email]
  }, {send}))
  t.false(await sendAdminAgentAccountNotification({
    type: 'RESTORED',
    agent: AGENT,
    recipients: []
  }, {send}))
  t.is(sendCount, 0)
})
