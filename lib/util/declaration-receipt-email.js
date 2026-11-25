import {escapeHtml, renderMjml, renderSecurityContactLink} from './email-templates.js'

const parisDate = new Intl.DateTimeFormat('fr-FR', {dateStyle: 'short', timeZone: 'Europe/Paris'})
const parisTime = new Intl.DateTimeFormat('fr-FR', {hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris'})
const number = new Intl.NumberFormat('fr-FR', {maximumFractionDigits: 10})

function day(isoDate) {
  return isoDate.split('-').reverse().join('/')
}

function quantity(value) {
  return `${number.format(value)}\u00a0m³`
}

function periodDates(start, end) {
  return start === end ? `le ${day(start)}` : `du ${day(start)} au ${day(end)}`
}

function measureText(measure, flowType) {
  if (measure.type === 'INDEX') return `Index relevé le ${day(measure.readingDate)}\u00a0: ${quantity(measure.value)}`
  const label = flowType === 'REJET' ? 'Volume rejeté' : 'Volume prélevé'
  return `${label} ${periodDates(measure.periodStartDate, measure.periodEndDate)}\u00a0: ${quantity(measure.value)}`
}

function previousMeasureText(before, after) {
  const dates = before.type === 'INDEX' ? `le ${day(before.readingDate)}` : periodDates(before.periodStartDate, before.periodEndDate)
  const label = before.type === after.type ? 'Auparavant' : before.type === 'INDEX' ? 'Ancien index' : 'Ancien volume déclaré'
  return `${label}\u00a0: ${quantity(before.value)} ${dates}.`
}

function statusText({status, before, after}) {
  const measure = after ?? before
  const label = measure.type === 'INDEX' ? 'Index' : 'Volume'
  if (status === 'ADDED') return `${label} ajouté`
  if (status === 'REMOVED') return `${label} supprimé`
  if (status === 'UNCHANGED') return `${label} inchangé`
  if (before.type !== after.type) return after.type === 'INDEX' ? 'Volume remplacé par un index' : 'Index remplacé par un volume'
  if (before.value === after.value) return after.type === 'INDEX' ? 'Date de relevé modifiée' : 'Période modifiée'
  return `${label} modifié`
}

const volumeKinds = {DECLARED: 'déclaré', COMPUTED: 'calculé', MIXED: 'total'}

function volumeWithOrigin(value, kind, parts) {
  if (kind === 'MIXED') return `${quantity(value)} (part déclarée\u00a0: ${quantity(parts.declared)}, part calculée\u00a0: ${quantity(parts.computed)})`
  return `${quantity(value)} (volume ${volumeKinds[kind]})`
}

function describePeriod(period, indexDate) {
  const {before, after, beforeKind, afterKind, beforeBreakdown, afterBreakdown} = period
  const dates = periodDates(period.periodStartDate, period.periodEndDate)
  const next = indexDate === period.periodStartDate && period.periodEndDate > indexDate
  const prefix = next ? `Période suivante, ${dates}` : dates.charAt(0).toUpperCase() + dates.slice(1)
  if (before == null) return `${prefix}\u00a0: ${volumeWithOrigin(after, afterKind, afterBreakdown)}.`
  if (after == null) return `${prefix}\u00a0: le volume ${volumeKinds[beforeKind]} de ${quantity(before)} a été retiré.`
  if (beforeKind === afterKind && afterKind !== 'MIXED') {
    return `${prefix}\u00a0: le volume ${volumeKinds[afterKind]} passe de ${quantity(before)} à ${quantity(after)}.`
  }
  return `${prefix}\u00a0: ${volumeWithOrigin(after, afterKind, afterBreakdown)}, auparavant ${volumeWithOrigin(before, beforeKind, beforeBreakdown)}.`
}

// The declaration already gives these direct volumes on their exact dates.
// Keep the additional period when another declaration or an index also contributed.
function matchesDirectSide(measure, value, kind, period) {
  if (value == null) return true
  return measure?.type === 'VOLUME' && kind === 'DECLARED' && measure.value === value
    && measure.periodStartDate === period.periodStartDate && measure.periodEndDate === period.periodEndDate
}

function indexContext(measure, periods) {
  if (!measure?.previousReading) return ['Aucun index antérieur pour ce comptage.']
  const {date, value} = measure.previousReading
  const lines = [`Index précédent\u00a0: ${quantity(value)} le ${day(date)}.`]
  if (measure.computedVolume == null) lines.push('Aucun volume calculé entre ces deux relevés.')
  else if (!periods.some(p => p.periodStartDate === date && p.periodEndDate === measure.readingDate
    && (p.afterKind === 'COMPUTED' && p.after === measure.computedVolume || p.afterBreakdown?.computed === measure.computedVolume))) {
    lines.push(`Volume calculé entre ces deux relevés\u00a0: ${quantity(measure.computedVolume)}.`)
  }
  return lines
}

function renderSeries(series, updated, mixedFlows) {
  const {before, after, periods, flowType} = series
  const title = [series.pointName, series.countingCode && `comptage ${series.countingCode}`,
    series.compteurName && `compteur ${series.compteurName}`, flowType === 'REJET' ? 'Rejet' : mixedFlows && 'Prélèvement',
    updated && statusText(series)].filter(Boolean).join(' · ')
  const lines = [measureText(after ?? before, flowType)]
  if (series.status === 'MODIFIED') lines.push(previousMeasureText(before, after))
  if (after?.type === 'INDEX') lines.push(...indexContext(after, periods))
  for (const period of periods) {
    if (matchesDirectSide(before, period.before, period.beforeKind, period)
      && matchesDirectSide(after, period.after, period.afterKind, period)) continue
    lines.push(describePeriod(period, after?.readingDate ?? before?.readingDate))
  }
  for (const warning of series.warnings) lines.push(warning.message)
  return `<h3 style="font-size:16px;margin:16px 0 4px">${escapeHtml(title)}</h3><p style="margin:0">${lines.map(escapeHtml).join('<br />')}</p>`
}

function renderMeasures(snapshot, updated) {
  const mixedFlows = new Set(snapshot.series.map(series => series.flowType)).size > 1
  return snapshot.series.map(series => renderSeries(series, updated, mixedFlows)).join('')
}

function renderFiles(snapshot) {
  const label = snapshot.files.length === 1 ? 'Fichier déposé' : 'Fichiers déposés'
  return `<h3 style="font-size:16px;margin:16px 0 4px">${label}</h3><ul style="margin:0;padding-left:20px">${
    snapshot.files.map(name => `<li>${escapeHtml(name)}</li>`).join('')
  }</ul>`
}

function receiptLinks(receipt, {frontUrl, canEdit}) {
  const base = new URL(frontUrl)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    throw new Error('Le lien vers l’application doit être une URL HTTP(S) sans identifiants.')
  }
  const id = encodeURIComponent(receipt.declarationId)
  const edit = receipt.kind !== 'FILES_RECEIVED' && canEdit && receipt.snapshot.series.some(series => series.after)
  const href = new URL(edit ? `/saisie-en-ligne/${id}/modifier` : `/mes-declarations/${id}`, base)
  const dashboard = new URL('/tableau-de-bord', base)
  return {edit, href, dashboard}
}

export async function renderDeclarationReceipt(receipt, options) {
  const {kind, recipientName, snapshot} = receipt
  const updated = kind === 'QUICK_UPDATED'
  const files = kind === 'FILES_RECEIVED'
  if (!updated && !files && kind !== 'QUICK_CREATED') throw new Error('Type de récapitulatif de déclaration inconnu.')
  const {edit, href, dashboard} = receiptLinks(receipt, options)
  const timestamp = new Date(receipt.createdAt)
  const date = parisDate.format(timestamp)
  const time = parisTime.format(timestamp).replace(':', ' h ')
  const declaration = `déclaration n°${snapshot.code}`
  const subject = updated ? `Partageons l’eau - Votre ${declaration} a été modifiée`
    : `Partageons l’eau - Votre déclaration du ${date} a bien été reçue`
  const beneficiary = snapshot.declarantName ? ` pour ${snapshot.declarantName}` : ''
  const intro = updated ? `La ${declaration}${beneficiary} a été modifiée le ${date} à ${time}. Voici son récapitulatif à jour.`
    : `Nous avons bien reçu la déclaration${beneficiary}, ${files ? 'déposée' : 'saisie'} le ${date} à ${time}.`
  const typeLabel = files ? snapshot.declarationType : snapshot.measurementType === 'INDEX' ? 'Relevés d’index' : 'Volumes déclarés'
  const title = [`Déclaration n°${snapshot.code}`, typeLabel].filter(Boolean).join(' · ')
  const contact = renderSecurityContactLink()
  const html = await renderMjml(`
    <mjml lang="fr">
      <mj-head>
        <mj-title>${escapeHtml(subject)}</mj-title>
        <mj-attributes>
          <mj-all font-family="Arial, sans-serif" />
          <mj-text font-size="15px" color="#303030" line-height="1.5" padding="8px 0" />
          <mj-button background-color="#000091" color="#ffffff" align="left" padding="8px 0" />
        </mj-attributes>
      </mj-head>
      <mj-body background-color="#f4f4f4">
        <mj-section padding="24px" background-color="#ffffff"><mj-column>
          <mj-text>${recipientName ? `Bonjour ${escapeHtml(recipientName)},` : 'Bonjour,'}</mj-text>
          <mj-text>${escapeHtml(intro)}</mj-text>
          <mj-text>
            <h2 style="font-size:20px;margin:0">${escapeHtml(title)}</h2>
            ${files ? renderFiles(snapshot) : renderMeasures(snapshot, updated)}
          </mj-text>
          ${edit ? '<mj-text>Une erreur dans votre saisie\u00a0? Vous pouvez la corriger en ligne.</mj-text>' : ''}
          <mj-button href="${escapeHtml(href.href)}">${edit ? 'Modifier ma déclaration' : 'Consulter ma déclaration'}</mj-button>
          <mj-text>Retrouvez vos déclarations dans votre <a href="${escapeHtml(dashboard.href)}">tableau de bord</a>.</mj-text>
          <mj-text>${updated ? 'Si vous n’êtes pas à l’origine de cette modification, écrivez-nous à' : 'Une question\u00a0? Écrivez-nous à'} ${contact}.</mj-text>
          <mj-text>L’équipe Partageons l’eau<br /><small>Ce message est envoyé automatiquement. Merci de ne pas y répondre.</small></mj-text>
        </mj-column></mj-section>
      </mj-body>
    </mjml>`)
  return {subject, html}
}
