import test from 'ava'

import {
  PASSWORD_SECURITY_NOTIFICATION_TYPES,
  sendPasswordSecurityNotification
} from '../password-security-notifications.js'

const USER = {
  email: 'personne@example.test',
  firstName: 'Camille',
  lastName: 'Rivière'
}

test('sendPasswordSecurityNotification envoie chaque type à l’adresse principale', async t => {
  const messages = []

  const deliveries = await Promise.all(
    Object.values(PASSWORD_SECURITY_NOTIFICATION_TYPES).map(type =>
      sendPasswordSecurityNotification(USER, type, {
        async render(user) {
          return `<p>${user.email} - ${type}</p>`
        },
        async send(to, subject, html) {
          messages.push({to, subject, html})
        }
      }))
  )

  for (const delivered of deliveries) {
    t.true(delivered)
  }

  t.is(messages.length, 3)
  t.true(messages.every(message => message.to === USER.email))
  t.true(messages.some(message => message.subject.includes('défini')))
  t.true(messages.some(message => message.subject.includes('modifié')))
  t.true(messages.some(message => message.subject.includes('réinitialisé')))
})

test('sendPasswordSecurityNotification absorbe un échec SMTP après la mutation', async t => {
  const delivered = await sendPasswordSecurityNotification(
    USER,
    PASSWORD_SECURITY_NOTIFICATION_TYPES.CHANGED,
    {
      async render() {
        return '<p>Modification persistée</p>'
      },
      async send() {
        throw new Error('SMTP indisponible')
      }
    }
  )

  t.false(delivered)
})

test('sendPasswordSecurityNotification ignore un compte sans adresse', async t => {
  let sent = false
  const delivered = await sendPasswordSecurityNotification(
    {firstName: 'Sans email'},
    PASSWORD_SECURITY_NOTIFICATION_TYPES.CHANGED,
    {
      async send() {
        sent = true
      }
    }
  )

  t.false(delivered)
  t.false(sent)
})
