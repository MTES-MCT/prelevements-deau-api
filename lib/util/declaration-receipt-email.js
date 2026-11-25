import {emailServiceHeading, escapeHtml, renderMjml, renderSecurityContactLink, transactionalEmailAttributes} from './email-templates.js'

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

function measureDates(measure) {
  if (!measure) return ''
  if (measure.readingDate) return `le ${day(measure.readingDate)}`
  if (measure.periodStartDate && measure.periodEndDate) return periodDates(measure.periodStartDate, measure.periodEndDate)
  return ''
}

const statusColors = {
  ADDED: ['#e7f3eb', '#235a39'], MODIFIED: ['#e9f1fb', '#174c80'],
  REMOVED: ['#fbecea', '#842b20'], UNCHANGED: ['#f1f1f1', '#555555']
}

function strike(text, status) {
  const color = status === 'REMOVED' ? statusColors.REMOVED[1] : statusColors.UNCHANGED[1]
  return `<del style="text-decoration:line-through;color:${color}">${text}</del>`
}

function highlight(text, status) {
  const style = status ? ` style="color:${statusColors[status][1]}"` : ''
  return `<strong${style}>${text}</strong>`
}

function previousMeasureDates(before, after) {
  const markDate = (date, replacement) => date === replacement ? escapeHtml(day(date)) : strike(escapeHtml(day(date)), 'MODIFIED')
  if (before.type === 'INDEX') return `le ${markDate(before.readingDate, after.readingDate)}`
  const {periodStartDate: start, periodEndDate: end} = before
  if (start === end) {
    const retained = start === after.periodStartDate || start === after.periodEndDate
    return `le ${markDate(start, retained ? start : undefined)}`
  }
  return `du ${markDate(start, after.periodStartDate)} au ${markDate(end, after.periodEndDate)}`
}

function renderMeasure(measure, flowType, commonDates, status, {replacement, previousValue} = {}) {
  const label = measure.type === 'INDEX' ? 'Index relevé' : flowType === 'REJET' ? 'Volume rejeté' : 'Volume prélevé'
  const typeChanged = replacement && measure.type !== replacement.type
  const amount = escapeHtml(quantity(measure.value))
  const obsolete = status === 'REMOVED' || (replacement && (typeChanged || measure.value !== replacement.value))
  let value = obsolete ? strike(amount, status) : replacement ? amount : highlight(amount, status)
  if (previousValue != null) value = `de ${strike(quantity(previousValue), status)} à ${value}`
  const dates = measureDates(measure)
  const visibleDates = replacement ? previousMeasureDates(measure, replacement) : escapeHtml(dates)
  return `${typeChanged ? strike(label, status) : label}${dates && dates !== commonDates ? ` ${visibleDates}` : ''}\u00a0: ${value}`
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

function volumeWithOrigin(value, kind, parts, replacement) {
  const previous = (text, changed) => replacement && changed ? strike(text, 'MODIFIED') : text
  const amount = previous(quantity(value), value !== replacement?.after)
  if (kind === 'MIXED') {
    const part = (name, label, singleKind) => {
      const retained = replacement?.afterBreakdown?.[name] ?? (replacement?.afterKind === singleKind ? replacement.after : null)
      return `${label}\u00a0: ${previous(quantity(parts[name]), parts[name] !== retained)}`
    }
    return `${amount} (${part('declared', 'part déclarée', 'DECLARED')}, ${part('computed', 'part calculée', 'COMPUTED')})`
  }
  return `${amount} (${previous(`volume ${volumeKinds[kind]}`, kind !== replacement?.afterKind)})`
}

function renderPeriodChange(period, updated) {
  const {before, after, beforeKind, afterKind, beforeBreakdown, afterBreakdown} = period
  const dates = periodDates(period.periodStartDate, period.periodEndDate)
  const prefix = escapeHtml(dates.charAt(0).toUpperCase() + dates.slice(1))
  if (before == null) {
    const volume = highlight(volumeWithOrigin(after, afterKind, afterBreakdown), updated && 'ADDED')
    return `${updated ? 'Volume ajouté · ' : ''}${prefix}\u00a0: ${volume}.`
  }
  if (after == null) {
    const removed = strike(quantity(before), 'REMOVED')
    return `${prefix}\u00a0: le volume ${volumeKinds[beforeKind]} de ${removed} a été retiré.`
  }
  if (beforeKind === afterKind && afterKind !== 'MIXED') {
    const old = before !== after ? strike(quantity(before), 'MODIFIED') : quantity(before)
    return `${prefix}\u00a0: le volume ${volumeKinds[afterKind]} passe de ${old} à ${highlight(quantity(after), 'MODIFIED')}.`
  }
  const current = highlight(volumeWithOrigin(after, afterKind, afterBreakdown), 'MODIFIED')
  return `${prefix}\u00a0: ${current}, auparavant ${volumeWithOrigin(before, beforeKind, beforeBreakdown, period)}.`
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

function renderStatus(series) {
  const [background, color] = statusColors[series.status]
  return ` <span style="display:inline-block;background-color:${background};color:${color};font-size:12px;line-height:18px;font-weight:bold;padding:1px 7px;border-radius:3px;vertical-align:middle">${statusText(series)}</span>`
}

function renderIndexContext(after, periods, unchanged) {
  if (after?.type !== 'INDEX') return ''
  const lines = indexContext(after, periods)
  // The unchanged measure is a reminder. Keep its published volume and leave the earlier reading in the dossier.
  if (unchanged && after.previousReading) lines.shift()
  if (!lines.length) return ''
  return `<p style="margin:4px 0;color:#555555">${lines.map(escapeHtml).join('<br />')}</p>`
}

function renderWarning(warning) {
  const inconsistent = ['INDEX_BELOW_PREVIOUS', 'INDEX_ABOVE_NEXT'].includes(warning.code)
  const lead = inconsistent ? '<strong>À vérifier</strong> · ' : ''
  const color = inconsistent ? '#73501a' : '#555555'
  return `<p style="margin:6px 0 0;color:${color}">${lead}${escapeHtml(warning.message)}</p>`
}

function renderPeriod(period, indexDate, updated) {
  const next = period.periodStartDate === indexDate && period.periodEndDate > indexDate
  return `<p style="margin:4px 0 0">${next ? '<strong>Période suivante</strong> · ' : ''}${renderPeriodChange(period, updated)}</p>`
}

function renderSeries(series, updated, mixedFlows, commonDates) {
  const {before, after, periods, flowType} = series
  const identifiers = [series.countingCode && `Comptage ${series.countingCode}`,
    series.compteurName && `Compteur ${series.compteurName}`,
    flowType === 'REJET' ? 'Rejet' : mixedFlows && 'Prélèvement'].filter(Boolean).join(' · ')
  const details = periods.filter(period =>
    !(matchesDirectSide(before, period.before, period.beforeKind, period)
      && matchesDirectSide(after, period.after, period.afterKind, period)))
  const showBothDates = before && after && measureDates(before) !== measureDates(after)
  const contextDates = showBothDates ? '' : commonDates
  const status = updated && series.status
  const onlyValueChanged = status === 'MODIFIED' && before.type === after.type && !showBothDates && before.value !== after.value
  const current = renderMeasure(after ?? before, flowType, contextDates, status, {previousValue: onlyValueChanged ? before.value : undefined})
  const measure = status === 'MODIFIED' && !onlyValueChanged
    ? `<p style="margin:8px 0 0;color:#555555">Avant · ${renderMeasure(before, flowType, contextDates, status, {replacement: after})}</p><p style="margin:0;color:#174c80"><strong>Après</strong> · ${current}</p>`
    : `<p style="margin:8px 0 0">${current}</p>`
  return `<div style="border-top:1px solid #dddddd;padding:16px 0;overflow-wrap:anywhere;word-wrap:break-word">
    <h2 style="margin:0;color:#222222;font-size:17px;line-height:1.45">${escapeHtml(series.pointName)}${updated ? renderStatus(series) : ''}</h2>
    ${identifiers ? `<p style="margin:2px 0;color:#595959;font-size:13px">${escapeHtml(identifiers)}</p>` : ''}
    ${measure}${renderIndexContext(after, periods, series.status === 'UNCHANGED')}
    ${details.map(period => renderPeriod(period, after?.readingDate ?? before?.readingDate, updated)).join('')}
    ${series.warnings.map(renderWarning).join('')}
  </div>`
}

function renderMeasures(snapshot, updated, commonDates) {
  const mixedFlows = new Set(snapshot.series.map(series => series.flowType)).size > 1
  return snapshot.series.map(series => renderSeries(series, updated, mixedFlows, commonDates)).join('')
}

function renderFiles(snapshot) {
  const count = snapshot.files.length
  const label = count === 1 ? '1 fichier reçu' : `${count} fichiers reçus`
  return `<h2 style="margin:0 0 8px;font-size:17px">${label}</h2><ul style="margin:0;padding-left:21px;color:#174c80">${
    snapshot.files.map(name => `<li style="margin:5px 0;overflow-wrap:anywhere;word-break:break-all"><strong style="color:#333333">${escapeHtml(name)}</strong></li>`).join('')
  }</ul><p style="margin:12px 0 0;color:#555555">Vous pouvez suivre le traitement des fichiers dans votre dossier.</p>`
}

function inboxPreview(snapshot, mode, commonDates, files, updated) {
  const reference = `Déclaration n°${snapshot.code}`
  if (files) return [`${snapshot.files.length} fichier${snapshot.files.length > 1 ? 's reçus' : ' reçu'}`, snapshot.declarationType, reference].filter(Boolean).join(' · ')
  const rows = updated ? snapshot.series.filter(row => row.status !== 'UNCHANGED') : snapshot.series
  const dates = snapshot.readingDate ? `du ${day(snapshot.readingDate)}` : commonDates
  const first = rows.length === 1 ? rows[0].pointName : `${rows.length} comptages`
  const type = updated ? `Modification · ${mode}` : mode
  return [[type, dates].filter(Boolean).join(' '), first, reference].filter(Boolean).join(' · ')
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
  const mode = files ? 'Dépôt par fichier' : snapshot.measurementType === 'INDEX' ? 'Relevés d’index' : 'Volumes déclarés'
  const commonDates = files ? '' : measureDates(snapshot)
  const datesLabel = snapshot.readingDate ? 'Date du relevé' : 'Période déclarée'
  const contact = renderSecurityContactLink()
  const html = await renderMjml(`
    <mjml lang="fr">
      <mj-head>
        <mj-title>${escapeHtml(subject)}</mj-title>
        <mj-preview>${escapeHtml(inboxPreview(snapshot, mode, commonDates, files, updated))}</mj-preview>
        ${transactionalEmailAttributes}
      </mj-head>
      <mj-body background-color="#f4f4f4">
        <mj-section padding="40px 20px" background-color="#ffffff"><mj-column>
          ${emailServiceHeading}
          <mj-text padding="0 0 8px">${recipientName ? `Bonjour ${escapeHtml(recipientName)},` : 'Bonjour,'}</mj-text>
          <mj-text padding="0 0 18px">${escapeHtml(intro)}</mj-text>
          <mj-text padding="0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse"><tr>
            <td bgcolor="#eef5fc" style="padding:12px 16px;border-left:3px solid #0063CB;overflow-wrap:anywhere">
            <h1 style="font-size:18px;line-height:1.4;margin:0 0 6px">Déclaration n°${escapeHtml(snapshot.code)}</h1>
            ${snapshot.declarationType ? `<p style="margin:2px 0"><strong>Type de déclaration</strong> · ${escapeHtml(snapshot.declarationType)}</p>` : ''}
            <p style="margin:2px 0"><strong>Mode de déclaration</strong> · ${mode}</p>
            ${commonDates ? `<p style="margin:2px 0"><strong>${datesLabel}</strong> · ${escapeHtml(snapshot.readingDate ? day(snapshot.readingDate) : commonDates)}</p>` : ''}
            </td></tr></table></mj-text>
          <mj-text padding="16px 0 0">
            ${files ? renderFiles(snapshot) : renderMeasures(snapshot, updated, commonDates)}
          </mj-text>
          ${edit ? '<mj-text padding="12px 0 0" align="center">Une erreur dans votre saisie\u00a0? Vous pouvez la corriger en ligne.</mj-text>' : ''}
          <mj-button href="${escapeHtml(href.href)}" padding="12px 0 16px">${edit ? 'Modifier ma déclaration' : 'Consulter ma déclaration'}</mj-button>
          <mj-text padding="0 0 16px" align="center">Retrouvez vos déclarations dans votre <a href="${escapeHtml(dashboard.href)}">tableau de bord</a>.</mj-text>
          <mj-divider border-color="#dddddd" border-width="1px" padding="6px 0 12px" />
          <mj-text padding="2px 0" font-size="13px">${updated ? 'Si vous n’êtes pas à l’origine de cette modification, écrivez-nous à' : 'Une question\u00a0? Écrivez-nous à'} ${contact}.</mj-text>
          <mj-text padding="6px 0 0">L’équipe Partageons l’Eau</mj-text>
          <mj-text padding="4px 0 0" font-size="12px" color="#666666">Ce message est envoyé automatiquement. Merci de ne pas y répondre.</mj-text>
        </mj-column></mj-section>
      </mj-body>
    </mjml>`)
  return {subject, html}
}
