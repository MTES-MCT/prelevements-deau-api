import test from 'ava'
import {renderDeclarationReceipt} from '../declaration-receipt-email.js'
import {renderEmailVerificationEmail} from '../email-templates.js'

const options = {frontUrl: 'https://recette.example.test/', canEdit: true}
const receipt = {
  declarationId: 'dossier-1', recipientName: 'Camille Martin', createdAt: new Date('2026-11-02T23:42:00Z'),
  kind: 'QUICK_CREATED'
}
const snapshot = {code: 'A14P6C', declarantName: 'Ferme du Moulin', declarationType: 'Déclaration mensuelle', measurementType: 'INDEX'}
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
  return html.replace(/<div style="display:none;[^"]*">[^<]*<\/div>/, '')
    .replaceAll(/<\/?(?:strong|span|del|ins|em|b)\b[^<>]*>/g, '').replaceAll(/<[^<>]+>/g, ' ').replaceAll(/\s+/g, ' ')
}

function struckText(html) {
  return Array.from(html.matchAll(/<del\b[^>]*>([\s\S]*?)<\/del>/gi), match => plain(match[1]).trim()).join(' ')
}

function measureParagraph(html, fragment) {
  const paragraphs = html.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) ?? []
  const paragraph = paragraphs.find(item => plain(item).includes(fragment))
  if (!paragraph) throw new Error('Ligne du récapitulatif introuvable : ' + fragment)
  return paragraph
}

test('la confirmation cite le dépôt en heure de Paris, les valeurs saisies et les liens de son environnement', async t => {
  const {subject, html} = await quick([series])
  const body = plain(html)
  t.is(subject, 'Partageons l’eau - Votre déclaration du 03/11/2026 a bien été reçue')
  for (const fragment of ['Bonjour Camille Martin,', 'Ferme du Moulin', '03/11/2026 à 00 h 42', 'Déclaration n°A14P6C',
    'Type de déclaration · Déclaration mensuelle', 'Mode de déclaration · Relevés d’index',
    'Forage des Prés Comptage 12 · Compteur C-1182', 'Index relevé le 29/10/2026 : 18 670 m³',
    'Index précédent : 17 520 m³ le 30/09/2026', 'Volume calculé entre ces deux relevés : 1 150 m³', 'Modifier ma déclaration']) {
    t.true(body.includes(fragment), `Texte attendu : ${fragment}`)
  }
  t.true(html.includes('https://recette.example.test/saisie-en-ligne/dossier-1/modifier'))
  t.true(html.includes('https://recette.example.test/tableau-de-bord'))
  t.true(html.includes('mailto:contact@partageonsleau.beta.gouv.fr'))
  t.is(struckText(html), '')
  t.false(body.includes('Index ajouté'))
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
  for (const fragment of ['Index modifié', 'Avant · Index relevé le 31/10/2026 : 18 760 m³',
    'Après · Index relevé le 29/10/2026 : 18 670 m³',
    'le volume calculé de 1 240 m³ a été retiré', 'Du 30/09/2026 au 29/10/2026 : 1 150 m³',
    'Période suivante · Du 29/10/2026 au 15/11/2026 : le volume calculé passe de 610 m³ à 700 m³',
    'Index inchangé', 'Si vous n’êtes pas à l’origine de cette modification']) t.true(body.includes(fragment), `Texte attendu : ${fragment}`)
  t.true(body.indexOf('Forage des Prés') < body.indexOf('Pompage rivière'))
  const struck = struckText(html)
  for (const former of ['18 760 m³', '1 240 m³', '610 m³']) t.true(struck.includes(former), `Valeur remplacée : ${former}`)
  for (const current of ['18 670 m³', '1 150 m³', '700 m³', '17 520 m³']) t.false(struck.includes(current), `Valeur conservée : ${current}`)
})

test('si seule la date ou la période change, la valeur conservée reste lisible sans être barrée', async t => {
  const cases = [
    {after: index, before: {...index, readingDate: '2026-10-28'}, label: 'Date de relevé modifiée', oldDate: '28/10/2026', newDate: '29/10/2026'},
    {after: volume, before: {...volume, periodEndDate: '2026-10-20'}, label: 'Période modifiée', oldDate: '20/10/2026', newDate: '31/10/2026'}
  ]
  await Promise.all(cases.map(async ({before, after, label, oldDate, newDate}) => {
    const {html} = await quick([{...series, status: 'MODIFIED', before, after}], {kind: 'QUICK_UPDATED'})
    const body = plain(html)
    t.true(body.includes(label))
    t.true(body.includes(newDate))
    const struck = struckText(html)
    t.true(struck.includes(oldDate))
    t.false(struck.includes(newDate))
    t.false(struck.includes('m³'))
  }))
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

test('les valeurs des lignes ajoutées, retirées et modifiées reprennent leurs couleurs même quand le volume vaut zéro', async t => {
  const green = '#235a39'
  const red = '#842b20'
  const blue = '#174c80'
  const cases = [
    {status: 'ADDED', before: null, after: volume, label: 'Volume ajouté', colors: [green]},
    {status: 'REMOVED', before: volume, after: null, label: 'Volume supprimé', colors: [red]},
    {status: 'MODIFIED', before: volume, after: {...volume, value: 14}, label: 'Volume modifié', colors: [blue]},
    {status: 'UNCHANGED', before: volume, after: volume, label: 'Volume inchangé', colors: []},
    {status: 'ADDED', before: null, after: volume, label: 'Volume prélevé', colors: [], creation: true}
  ]
  await Promise.all(cases.map(async ({status, before, after, label, colors, creation}) => {
    const {html} = await quick([{...series, status, before, after}], {kind: creation ? 'QUICK_CREATED' : 'QUICK_UPDATED'})
    t.true(plain(html).includes(label))
    t.is(struckText(html).includes('0 m³'), status === 'MODIFIED' || status === 'REMOVED')
    const valueLine = measureParagraph(html, 'Volume prélevé')
    if (status === 'MODIFIED') t.true(plain(valueLine).includes('de 0 m³ à 14 m³'))
    const inks = Array.from(valueLine.matchAll(/[;" ]color\s*:\s*(#[\da-f]{6})\b/gi), match => match[1].toLowerCase())
    t.deepEqual([green, red, blue].filter(color => inks.includes(color)), colors, label)
  }))
})

test('lors du dépôt, le nouvel index reste neutre et un volume auparavant publié peut être retiré ou recalculé', async t => {
  const row = {...series, periods: [
    {periodStartDate: '2026-09-30', periodEndDate: '2026-10-31', before: 1240, beforeKind: 'COMPUTED', after: null, afterKind: null},
    latePeriod
  ]}
  const {html} = await quick([row])
  t.is(struckText(measureParagraph(html, 'Index relevé')), '')
  t.is(struckText(measureParagraph(html, 'Index précédent')), '')
  t.true(struckText(measureParagraph(html, 'a été retiré')).includes('1 240 m³'))
  const next = measureParagraph(html, 'Période suivante')
  t.true(plain(next).includes('passe de 610 m³ à 700 m³'))
  t.is(struckText(next), '610 m³')
})

test('les deux conversions nomment les mesures, et un total identique conserve ses origines', async t => {
  const toVolume = {...series, flowType: 'REJET', status: 'MODIFIED', before: index, after: volume, periods: [
    {...latePeriod, before: 5, after: 5, afterKind: 'MIXED', afterBreakdown: {declared: 0, computed: 5}}
  ]}
  const toIndex = {...series, status: 'MODIFIED', before: volume}
  const {html} = await quick([toVolume, toIndex], {kind: 'QUICK_UPDATED'})
  const body = plain(html)
  for (const fragment of ['Index remplacé par un volume', 'Compteur C-1182 · Rejet', 'Après · Volume rejeté du 01/10/2026 au 31/10/2026 : 0 m³',
    '5 m³ (part déclarée : 0 m³, part calculée : 5 m³), auparavant 5 m³ (volume calculé)',
    'Compteur C-1182 · Prélèvement', 'Volume remplacé par un index', 'Avant · Volume prélevé du 01/10/2026 au 31/10/2026 : 0 m³']) t.true(body.includes(fragment), `Texte attendu : ${fragment}`)
  const formerOrigin = struckText(measureParagraph(html, 'auparavant 5 m³'))
  t.true(formerOrigin.includes('volume calculé'))
  t.false(formerOrigin.includes('5 m³'))
})

test('un index remplacé par un volume de même valeur barre uniquement la mesure remplacée', async t => {
  const replaced = {...series, status: 'MODIFIED', before: {...index, value: 0}, after: volume}
  const {html} = await quick([replaced], {kind: 'QUICK_UPDATED'})
  t.true(plain(html).includes('Index remplacé par un volume'))
  const former = measureParagraph(html, 'Avant · Index relevé')
  const current = measureParagraph(html, 'Après · Volume prélevé')
  t.true(struckText(former).includes('0 m³'))
  t.is(struckText(current), '')
  t.true(plain(current).includes('0 m³'))
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
    snapshot: {...snapshot, measurementType: 'VOLUME', periodStartDate: volume.periodStartDate, periodEndDate: volume.periodEndDate, series: rows}}, options)
  const body = plain(html)
  t.deepEqual(Array.from(body.matchAll(/Comptage (\d{3})/g), match => match[1]), rows.map(row => row.countingCode))
  t.is(body.match(/01\/10\/2026 au 31\/10\/2026/g)?.length, 1)
  t.true(body.includes('Période déclarée · du 01/10/2026 au 31/10/2026'))
  t.is(body.match(/Volume prélevé : 0 m³/g)?.length, rows.length)
  t.is(body.match(/Volume ajouté/g)?.length, rows.length)
})

test('les dépôts par fichier listent les pièces dans leur ordre sans lien de téléchargement ni volume', async t => {
  const {html} = await renderDeclarationReceipt({...receipt, kind: 'FILES_RECEIVED', recipientName: null,
    snapshot: {...snapshot, declarationType: 'Dépôt des relevés', files: ['deux.csv', 'un.csv', 'deux.csv']}}, options)
  const body = plain(html)
  t.true(body.includes('Bonjour,'))
  t.true(body.includes('3 fichiers reçus deux.csv un.csv deux.csv'))
  t.true(body.includes('Type de déclaration · Dépôt des relevés'))
  t.true(body.includes('Mode de déclaration · Dépôt par fichier'))
  t.false(body.includes('Date du relevé'))
  t.true(html.includes('https://recette.example.test/mes-declarations/dossier-1'))
  t.false(html.includes('/modifier'))
  t.false(body.includes('m³'))
})

test('une date commune figure une seule fois et une correction rappelle les deux dates lorsqu’elles diffèrent', async t => {
  const common = {...snapshot, readingDate: index.readingDate}
  const created = await renderDeclarationReceipt({...receipt, snapshot: {...common, series: [series, {...series, pointName: 'Les Lys'}]}}, options)
  const rows = [{...series, status: 'MODIFIED', before: {...index, readingDate: '2026-10-28'}}]
  const modified = await renderDeclarationReceipt({...receipt, kind: 'QUICK_UPDATED', snapshot: {...common, series: rows}}, options)
  const old = await renderDeclarationReceipt({...receipt, snapshot: {code: snapshot.code, measurementType: 'INDEX', series: [series]}}, options)
  t.is(plain(created.html).match(/29\/10\/2026/g)?.length, 1)
  t.true(plain(created.html).includes('Date du relevé · 29/10/2026'))
  t.true(plain(modified.html).includes('Avant · Index relevé le 28/10/2026'))
  t.true(plain(modified.html).includes('Après · Index relevé le 29/10/2026'))
  t.false(plain(old.html).includes('Type de déclaration'))
  t.true(plain(old.html).includes('Index relevé le 29/10/2026'))
})

test('le récapitulatif partage la signature visuelle et les boutons des courriels de validation', async t => {
  const validation = await renderEmailVerificationEmail({user: {firstName: 'Camille'}, email: 'camille@example.test',
    purpose: 'ALIAS_ADD', confirmationUrl: 'https://recette.example.test/validation-email', expiresAt: receipt.createdAt})
  const recap = await quick([series])
  for (const html of [validation, recap.html]) {
    t.true(plain(html).includes("Partageons l'Eau Bonjour Camille"))
    t.true(html.includes('Arial, sans-serif'))
    t.true(html.includes('#f4f4f4'))
    t.true(html.includes('#0063CB'))
    t.true(html.includes('border-radius:4px'))
  }
  t.true(recap.html.includes('lang="fr"'))
  t.true(recap.html.includes('role="presentation"'))
})

test('les trois confirmations ont des aperçus différents dans la boîte de réception, masqués à l’ouverture', async t => {
  const cases = [
    [receipt.kind, {...snapshot, readingDate: index.readingDate, series: [series]}, 'Relevés d’index du 29/10/2026 · Forage des Prés'],
    [receipt.kind, {...snapshot, measurementType: 'VOLUME', periodStartDate: volume.periodStartDate, periodEndDate: volume.periodEndDate,
      series: [{...series, after: volume}]}, 'Volumes déclarés du 01/10/2026 au 31/10/2026 · Forage des Prés'],
    ['FILES_RECEIVED', {...snapshot, files: ['1.csv', '2.csv']}, '2 fichiers reçus · Déclaration mensuelle'],
    ['QUICK_UPDATED', {...snapshot, readingDate: index.readingDate, series: [{...series, before: index, status: 'MODIFIED'}]},
      'Modification · Relevés d’index du 29/10/2026']
  ]
  const receipts = await Promise.all(cases.map(([kind, data]) => renderDeclarationReceipt({...receipt, kind, snapshot: data}, options)))
  const creationSubjects = receipts.slice(0, 3).map(mail => mail.subject)
  t.is(new Set(creationSubjects).size, 1)
  for (const [i, {html}] of receipts.entries()) {
    const preview = html.match(/<div style="(display:none;[^"]*)">([^<]*)<\/div>/)
    t.truthy(preview)
    t.true(preview[1].includes('max-height:0px'))
    t.true(preview[2].includes(cases[i][2]))
    t.false(plain(html).includes(cases[i][2]))
  }
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
