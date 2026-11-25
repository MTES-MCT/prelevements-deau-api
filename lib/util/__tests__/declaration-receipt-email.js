import test from 'ava'
import {renderDeclarationReceipt} from '../declaration-receipt-email.js'

const options = {frontUrl: 'https://recette.example.test/', canEdit: true}
const receipt = {
  declarationId: 'dossier-1', recipientName: 'Camille Martin', createdAt: new Date('2026-11-02T23:42:00Z'),
  kind: 'QUICK_CREATED'
}
const snapshot = {code: 'A14P6C', declarantName: 'Ferme du Moulin', measurementType: 'INDEX'}
const index = {type: 'INDEX', value: 18670, readingDate: '2026-10-29',
  previousReading: {value: 17520, date: '2026-09-30'}, computedVolume: 1150}
const volume = {type: 'VOLUME', value: 0, periodStartDate: '2026-10-01', periodEndDate: '2026-10-31'}
const series = {pointName: 'Forage des Prés', countingCode: '12', compteurName: 'C-1182', flowType: 'PRELEVEMENT',
  status: 'ADDED', before: null, after: index, periods: [], warnings: []}
const latePeriod = {periodStartDate: '2026-10-29', periodEndDate: '2026-11-15',
  before: 610, beforeKind: 'COMPUTED', after: 700, afterKind: 'COMPUTED'}

function quick(rows, overrides = {}, renderOptions = options) {
  return renderDeclarationReceipt({...receipt, ...overrides, snapshot: {...snapshot, series: rows}}, renderOptions)
}

function plain(html) {
  return html.replaceAll(/<[^<>]+>/g, ' ').replaceAll(/\s+/g, ' ')
}

test('la confirmation cite le dépôt en heure de Paris, les valeurs saisies et les liens de son environnement', async t => {
  const {subject, html} = await quick([series])
  const body = plain(html)
  t.is(subject, 'Partageons l’eau - Votre déclaration du 03/11/2026 a bien été reçue')
  for (const fragment of ['Bonjour Camille Martin,', 'Ferme du Moulin', '03/11/2026 à 00 h 42', 'Déclaration n°A14P6C · Relevés d’index',
    'Forage des Prés · comptage 12 · compteur C-1182', 'Index relevé le 29/10/2026 : 18 670 m³',
    'Index précédent : 17 520 m³ le 30/09/2026', 'Volume calculé entre ces deux relevés : 1 150 m³', 'Modifier ma déclaration']) {
    t.true(body.includes(fragment), `Texte attendu : ${fragment}`)
  }
  t.true(html.includes('https://recette.example.test/saisie-en-ligne/dossier-1/modifier'))
  t.true(html.includes('https://recette.example.test/tableau-de-bord'))
  t.true(html.includes('mailto:contact@partageonsleau.beta.gouv.fr'))
})

test('une correction conserve les deux dates et restitue le volume recalculé sur la période suivante', async t => {
  const modified = {...series, status: 'MODIFIED', before: {...index, value: 18760, readingDate: '2026-10-31', computedVolume: 1240},
    periods: [
      {periodStartDate: '2026-09-30', periodEndDate: '2026-10-31', before: 1240, beforeKind: 'COMPUTED', after: null, afterKind: null},
      {periodStartDate: '2026-09-30', periodEndDate: '2026-10-29', before: null, beforeKind: null, after: 1150, afterKind: 'COMPUTED'},
      latePeriod
    ]}
  const unchanged = {...series, pointName: 'Pompage rivière', status: 'UNCHANGED', before: index}
  const {html, subject} = await quick([modified, unchanged], {kind: 'QUICK_UPDATED'})
  const body = plain(html)
  t.is(subject, 'Partageons l’eau - Votre déclaration n°A14P6C a été modifiée')
  for (const fragment of ['Index modifié', 'Auparavant : 18 760 m³ le 31/10/2026',
    'le volume calculé de 1 240 m³ a été retiré', 'Du 30/09/2026 au 29/10/2026 : 1 150 m³',
    'Période suivante, du 29/10/2026 au 15/11/2026 : le volume calculé passe de 610 m³ à 700 m³',
    'Index inchangé', 'Si vous n’êtes pas à l’origine de cette modification']) t.true(body.includes(fragment), `Texte attendu : ${fragment}`)
  t.true(body.indexOf('Forage des Prés') < body.indexOf('Pompage rivière'))
})

test('un premier index, un volume calculé nul et un calcul absent restent distincts', async t => {
  const first = {...series, after: {...index, value: 0, previousReading: null, computedVolume: null}}
  const equal = {...series, after: {...index, value: 17520, computedVolume: 0}}
  const warning = 'L’index saisi est inférieur au relevé précédent.'
  const lower = {...series, after: {...index, value: 10, computedVolume: null}, warnings: [{code: 'INDEX_BELOW_PREVIOUS', message: warning}]}
  const body = plain((await quick([first, equal, lower])).html)
  for (const fragment of ['Index relevé le 29/10/2026 : 0 m³', 'Aucun index antérieur',
    'Volume calculé entre ces deux relevés : 0 m³', 'Aucun volume calculé entre ces deux relevés', warning]) t.true(body.includes(fragment), `Texte attendu : ${fragment}`)
})

test('les deux conversions nomment les mesures, et un total identique conserve ses origines', async t => {
  const toVolume = {...series, flowType: 'REJET', status: 'MODIFIED', before: index, after: volume, periods: [
    {...latePeriod, before: 5, after: 5, afterKind: 'MIXED', afterBreakdown: {declared: 0, computed: 5}}
  ]}
  const toIndex = {...series, status: 'MODIFIED', before: volume}
  const body = plain((await quick([toVolume, toIndex], {kind: 'QUICK_UPDATED'})).html)
  for (const fragment of ['Rejet · Index remplacé par un volume', 'Volume rejeté du 01/10/2026 au 31/10/2026 : 0 m³',
    '5 m³ (part déclarée : 0 m³, part calculée : 5 m³), auparavant 5 m³ (volume calculé)',
    'Prélèvement · Volume remplacé par un index', 'Ancien volume déclaré : 0 m³ du 01/10/2026 au 31/10/2026']) t.true(body.includes(fragment), `Texte attendu : ${fragment}`)
})

test('la suppression de la dernière mesure propose la consultation et les courriels suivent le droit de correction', async t => {
  const removed = {...series, status: 'REMOVED', before: volume, after: null}
  const allRemoved = await quick([removed], {kind: 'QUICK_UPDATED'})
  const noEdit = await quick([series], {}, {...options, canEdit: false})
  for (const {html} of [allRemoved, noEdit]) {
    t.true(html.includes('https://recette.example.test/mes-declarations/dossier-1'))
    t.true(html.includes('Consulter ma déclaration'))
    t.false(html.includes('/modifier'))
  }
  t.true(plain(allRemoved.html).includes('Volume supprimé'))
})

test('un formulaire de cent comptages garde son ordre, ses points distincts et les périodes déclarées une seule fois', async t => {
  const rows = Array.from({length: 100}, (_, i) => ({
    ...series, pointName: 'Rivière', countingCode: String(100 - i).padStart(3, '0'),
    status: 'ADDED', after: volume, periods: [
      {...volume, before: null, beforeKind: null, after: 0, afterKind: 'DECLARED'}
    ]
  }))
  const {html} = await renderDeclarationReceipt({...receipt, kind: 'QUICK_UPDATED',
    snapshot: {...snapshot, measurementType: 'VOLUME', series: rows}}, options)
  const body = plain(html)
  t.deepEqual(Array.from(body.matchAll(/comptage (\d{3})/g), match => match[1]), rows.map(row => row.countingCode))
  t.is(body.match(/01\/10\/2026 au 31\/10\/2026/g)?.length, rows.length)
  t.is(body.match(/Volume ajouté/g)?.length, rows.length)
})

test('les dépôts par fichier listent les pièces dans leur ordre sans lien de téléchargement ni volume', async t => {
  const {html} = await renderDeclarationReceipt({...receipt, kind: 'FILES_RECEIVED', recipientName: null,
    snapshot: {...snapshot, declarationType: 'Dépôt des relevés', files: ['deux.csv', 'un.csv', 'deux.csv']}}, options)
  const body = plain(html)
  t.true(body.includes('Bonjour,'))
  t.true(body.includes('Fichiers déposés deux.csv un.csv deux.csv'))
  t.true(html.includes('https://recette.example.test/mes-declarations/dossier-1'))
  t.false(html.includes('/modifier'))
  t.false(body.includes('m³'))
})

test('les libellés, destinataires et fichiers sont échappés, seules les URL HTTP(S) sont utilisables', async t => {
  const markup = '<strong data-probe="texte">Nom & Cie</strong>'
  const malicious = {...receipt, recipientName: markup, kind: 'FILES_RECEIVED', snapshot: {...snapshot, declarantName: markup,
    declarationType: markup, files: [markup]}}
  const {html} = await renderDeclarationReceipt(malicious, options)
  const {html: quickHtml} = await quick([{...series, compteurName: markup, pointName: markup,
    warnings: [{code: 'INDEX_ABOVE_NEXT', message: markup}]}])
  for (const result of [html, quickHtml]) {
    t.false(result.includes('<strong data-probe='))
    t.true(result.includes('&lt;strong'))
    t.true(result.includes('Nom &amp; Cie'))
  }
  await Promise.all(['javascript:alert(1)', 'ftp://example.test', 'https://user:pass@example.test'].map(frontUrl =>
    t.throwsAsync(() => renderDeclarationReceipt(malicious, {frontUrl, canEdit: true}), {message: /HTTP\(S\)/})))
})
