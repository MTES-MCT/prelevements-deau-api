import test from 'ava'

import {
  buildBrevoTemplatePreview,
  renderBrevoTemplatePreview
} from '../brevo-template-preview.js'

test('renderBrevoTemplatePreview remplace les params et échappe le HTML', t => {
  const preview = renderBrevoTemplatePreview({
    subject: 'Bonjour {{ params.NOM }}',
    htmlContent: '<p>{{ params.NOM }}</p><a href="{{ unsubscribe }}">Se désinscrire</a>',
    textContent: 'Période : {{ params.PERIODE }}'
  }, {
    NOM: '<Établissement & fils>',
    PERIODE: 'juillet 2026'
  })

  t.is(preview.subject, 'Bonjour <Établissement & fils>')
  t.true(preview.htmlContent.includes('&lt;Établissement &amp; fils&gt;'))
  t.true(preview.htmlContent.includes('#aperçu-desinscription'))
  t.is(preview.textContent, 'Période : juillet 2026')
  t.deepEqual(preview.unresolvedPlaceholders, [])
})

test('buildBrevoTemplatePreview récupère le template en lecture seule', async t => {
  let request
  const fetchImplementation = async (url, options) => {
    request = {url, options}
    return {
      ok: true,
      async json() {
        return {
          name: 'Rappel mensuel',
          isActive: true,
          subject: 'Bonjour {{ params.NOM }}',
          htmlContent: '<p>{{ params.PERIODE }}</p>'
        }
      }
    }
  }

  const preview = await buildBrevoTemplatePreview({
    templateId: 2,
    params: {NOM: 'ASA Test', PERIODE: 'juin 2026'},
    recipient: {email: 'test@example.fr', name: 'ASA Test'},
    apiKey: 'test-key',
    fetchImplementation
  })

  t.true(request.url.endsWith('/smtp/templates/2'))
  t.is(request.options.method, undefined)
  t.is(preview.subject, 'Bonjour ASA Test')
  t.true(preview.approximate)
})

test('renderBrevoTemplatePreview signale les params absents', t => {
  const preview = renderBrevoTemplatePreview({
    subject: 'Bonjour {{ params.INCONNUE }}',
    htmlContent: ''
  }, {})

  t.deepEqual(preview.unresolvedPlaceholders, ['params.INCONNUE'])
})
