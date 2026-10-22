import test from 'ava'
import nodemailer from 'nodemailer'
import {renderMagicLinkEmail} from '../email-templates.js'

const user = {
  prenom: 'Camille',
  nom: 'Test',
  structure: 'Structure de test',
  roles: [
    {territoire: '974', role: 'editor'},
    {territoire: '975', role: 'reader'}
  ]
}

test('le rendu du mail conserve un lien et le rôle pour chaque territoire', async t => {
  const html = await renderMagicLinkEmail(user, 'test-token', 'https://api.example.test')

  t.is(typeof html, 'string')
  t.regex(html, /<!doctype html>/iv)
  t.false(html.includes('<mjml'))
  t.true(html.includes('Bonjour Camille Test'))
  t.true(html.includes('Structure de test'))
  t.true(html.includes('15 minutes'))
  for (const {territoire, role} of user.roles) {
    t.true(html.includes(`href="https://api.example.test/auth/verify/test-token?territoire=${territoire}"`))
    t.true(html.includes(`${territoire} (${role === 'editor' ? 'Éditeur' : 'Lecteur'})`))
  }
})

test('le mail accepte une structure non renseignée', async t => {
  const html = await renderMagicLinkEmail({...user, structure: undefined}, 'test-token', 'https://api.example.test')
  t.true(html.includes('Structure : Non renseignée'))
})

test('Nodemailer construit le message HTML sans connexion SMTP', async t => {
  const html = await renderMagicLinkEmail(user, 'test-token', 'https://api.example.test')
  const transport = nodemailer.createTransport({jsonTransport: true})
  const info = await transport.sendMail({
    from: 'service@example.test',
    to: 'camille@example.test',
    subject: 'Connexion à Prélèvements d’eau',
    html
  })
  const message = JSON.parse(info.message)

  t.is(message.html, html)
  t.is(message.subject, 'Connexion à Prélèvements d’eau')
  t.deepEqual(message.to, [{address: 'camille@example.test', name: ''}])
})
