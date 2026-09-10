import ExcelJS from 'exceljs'

const kindLabels = {INDEX: 'Relevés de compteurs', NEEDS: 'Besoins en eau'}
const statusLabels = {COMPLETE: 'Calculé', MISSING: 'Relevé indisponible', CONFLICT: 'Calcul impossible'}
const eventLabels = {RESET: 'Remise à zéro', REPLACEMENT: 'Remplacement de compteur'}
const issueLabels = {
  UNKNOWN_TARGET_OR_METER: 'Point ou compteur non reconnu',
  INVALID_READING_DATE: 'Date du relevé invalide',
  DUPLICATE_READING: 'Plusieurs relevés pour le même compteur à la même date',
  INVALID_INDEX: 'Index invalide',
  MISSING_REASON_REQUIRED: 'Motif d’indisponibilité manquant',
  METER_CONTINUITY_CONFIRMATION_REQUIRED: 'Continuité du compteur à confirmer',
  CORRECTION_REASON_REQUIRED: 'Correction du relevé incomplète ou incohérente',
  EXISTING_READING_REFERENCE_REQUIRED: 'Relevé existant à confirmer',
  STALE_SOURCE_READING: 'Le relevé existant est absent ou a été modifié depuis sa reprise',
  INVALID_SOURCE_READING: 'Le relevé existant ne peut pas être utilisé',
  SOURCE_METER_MISMATCH: 'Le relevé existant concerne un autre compteur',
  AMBIGUOUS_HISTORICAL_METER: 'Compteur du relevé existant à confirmer',
  SOURCE_READING_CHANGED: 'La date ou la valeur du relevé existant a changé',
  SOURCE_READING_REUSED_FOR_ANOTHER_METER: 'Le même relevé existant est utilisé pour plusieurs compteurs',
  INVALID_METER_EVENT_DATE: 'Date du changement de compteur invalide',
  INVALID_METER_EVENT: 'Changement de compteur à vérifier',
  METER_TRANSITION_REQUIRED: 'Changement de compteur à renseigner',
  NEGATIVE_DELTA_REQUIRES_EVENT: 'L’index a diminué : vérifier le relevé ou renseigner le changement de compteur',
  CAMPAIGN_TARGETS_AND_PERIODS_REQUIRED: 'Points ou périodes de la campagne à renseigner',
  READING_OUTSIDE_CAMPAIGN_BOUNDARIES: 'Date du relevé non prévue dans la campagne',
  METER_EVENT_OUTSIDE_CAMPAIGN: 'Changement de compteur en dehors de la campagne',
  METER_OR_PERIOD_REQUIRED: 'Dates des relevés de début et de fin à vérifier',
  AMBIGUOUS_METER_BINDING: 'Rattachement du compteur au point à vérifier',
  NO_ACTIVE_METER: 'Aucun compteur actif sur la période',
  INVALID_PERIOD_OR_METER_DATE: 'Dates de la période ou du compteur invalides',
  MISSING_READING: 'Relevé manquant',
  VOLUME_OUT_OF_RANGE: 'Volume supérieur à la limite autorisée',
  AMBIGUOUS_VOLUME_OWNER: 'Préleveur du volume existant non identifié',
  PARTIAL_VOLUME_OVERLAP: 'Chevauchement partiel avec un volume existant'
}

const personName = user => [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim()
const preleveurName = target => target.preleveur?.label || target.preleveur?.socialReason || personName(target.preleveur?.user) || 'Préleveur non renseigné'
const pointColumns = ['Point de prélèvement', 'Référence du point', 'Préleveur', 'Usage']
const auditColumns = ['Réponse transmise par', 'Date de transmission']
const decimalText = value => value === null || value === undefined ? '' : String(value)

function pointValues(target) {
  const point = target.pointPrelevement ?? {}
  return [
    point.usageName || point.name || 'Point non renseigné',
    point.name || '',
    preleveurName(target),
    target.usage?.name || target.exploitation?.usage?.label || 'Usage non renseigné'
  ]
}

function transmittedBy(submission) {
  const user = submission.createdBy
  return personName(user) || user?.declarant?.socialReason || 'Personne non renseignée'
}

function meterName(target, id) {
  if (!id) {
    return 'Non renseigné'
  }

  const meter = target.meters?.find(meter => meter.compteurId === id)?.compteur
  return meter?.serialNumber || meter?.identifier || 'Compteur sans numéro renseigné'
}

// Les dates civiles ne changent pas de fuseau. Les périodes sont stockées avec
// une fin exclusive ; le classeur affiche le dernier jour de la période.
function civilDate(value, {end = false} = {}) {
  if (!value) {
    return null
  }

  const text = value instanceof Date ? value.toISOString() : String(value)
  const date = new Date(`${text.slice(0, 10)}T00:00:00.000Z`)
  if (!Number.isFinite(date.getTime())) {
    return null
  }

  if (end) {
    date.setUTCDate(date.getUTCDate() - 1)
  }

  return date
}

function localTimestamp(value, formatter) {
  if (!value) {
    return null
  }

  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) {
    return null
  }

  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]))
  return new Date(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.000Z`)
}

function addSheet(workbook, name, headers, timezone) {
  const sheet = workbook.addWorksheet(name, {views: [{state: 'frozen', ySplit: 1}]})
  sheet.columns = headers.map(header => {
    const dateFormat = header === 'Date de transmission' ? 'dd/mm/yyyy hh:mm:ss' : 'dd/mm/yyyy'
    return {
      header,
      width: ['Commentaire', 'Précisions', 'Motif', 'Motif de correction'].includes(header) || header.startsWith('Motif d’indisponibilité') ? 48 : 28,
      style: {alignment: {vertical: 'top', wrapText: true}, ...(header.startsWith('Date') || ['Du', 'Au'].includes(header) ? {numFmt: dateFormat} : {})}
    }
  })
  sheet.getRow(1).font = {bold: true, color: {argb: 'FFFFFFFF'}}
  sheet.getRow(1).fill = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FF000091'}}
  sheet.getRow(1).height = 32
  sheet.autoFilter = {from: {row: 1, column: 1}, to: {row: 1, column: headers.length}}
  const notes = {
    'Référence du point': 'Nom de référence du point dans la plateforme, utile pour distinguer les noms usuels identiques.',
    'Réponse transmise par': 'Personne ayant transmis la réponse pour le préleveur. Il peut notamment s’agir de son collecteur.',
    'Type de réponse': 'La campagne recueille des relevés de compteurs et des besoins en eau.',
    'Date de transmission': `Heure locale de la campagne (${timezone}).`,
    Au: 'Dernier jour de la période.',
    'Index (m³)': 'Valeur conservée en texte pour préserver tous les chiffres du relevé.'
  }
  for (const [index, header] of headers.entries()) {
    if (notes[header]) {
      sheet.getCell(1, index + 1).note = notes[header]
    }
  }

  return sheet
}

function reasonLabel(reason) {
  if (typeof reason === 'string') {
    return issueLabels[reason] || (/^[A-Z][A-Z\d]*(?:_[A-Z\d]+)+$/.test(reason) ? 'Données à vérifier' : reason)
  }

  // Ne pas sérialiser les objets techniques : ils contiennent des UUID.
  return reason?.reason || issueLabels[reason?.code] || 'Relevé manquant ou données à vérifier'
}

function readingOrigin(reading) {
  if (reading.correctionOfChunkValueId) {
    return 'Relevé existant corrigé'
  }

  return reading.sourceChunkValueId ? 'Relevé existant repris' : 'Saisi pour cette campagne'
}

// Les valeurs décimales restent du texte : la limite de précision d’Excel ne
// doit pas arrondir les index. Une chaîne n’est jamais une formule ni un lien.
export function buildCampaignWorkbook({campaign, targets, responses}) {
  const targetMap = new Map(targets.map(target => [target.id, target]))
  const periodMap = new Map(campaign.periods.map(period => [period.id, period]))
  const preleveurMap = new Map(targets.map(target => [target.preleveurUserId, preleveurName(target)]))
  const responseMap = new Map(responses.map(response => [`${response.preleveurUserId}:${response.kind}`, response]))
  const expectedResponses = [...preleveurMap.keys()]
    .flatMap(preleveurUserId => ['INDEX', 'NEEDS'].map(kind => responseMap.get(`${preleveurUserId}:${kind}`) ?? {preleveurUserId, kind}))
  const hasLegacyFlow = expectedResponses.some(response => response.latestSubmission?.snapshot?.needs?.some(line =>
    targetMap.has(line.targetId) && periodMap.has(line.periodId)
    && line.requestedFlow !== undefined && line.requestedFlow !== null && line.requestedFlow !== ''))
  const timezone = campaign.timezone || 'Europe/Paris'
  const timestampFormatter = new Intl.DateTimeFormat('fr-FR', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  })
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Partageons l’eau'
  const summary = addSheet(workbook, 'Réponses', ['Campagne', 'Préleveur', 'Type de réponse', 'État de la réponse', ...auditColumns, 'Commentaire'], timezone)
  const indices = addSheet(workbook, 'Relevés de compteurs', [
    ...pointColumns, 'Compteur', 'Date du relevé', 'Index (m³)', 'Motif d’indisponibilité', 'Origine du relevé', 'Motif de correction', 'Continuité du compteur confirmée', ...auditColumns
  ], timezone)
  const events = addSheet(workbook, 'Changements de compteur', [
    ...pointColumns,
    'Type de changement',
    'Date du changement',
    'Ancien compteur',
    'Compteur après changement',
    'Index avant changement (m³)',
    'Index après changement (m³)',
    'Motif d’indisponibilité avant',
    'Motif d’indisponibilité après',
    'Motif',
    ...auditColumns
  ], timezone)
  const volumes = addSheet(workbook, 'Volumes prélevés', [...pointColumns, 'Période', 'Du', 'Au', 'Volume prélevé (m³)', 'État du calcul', 'Précisions', ...auditColumns], timezone)
  const needs = addSheet(workbook, 'Besoins en eau', [...pointColumns, 'Période', 'Du', 'Au', ...(hasLegacyFlow ? ['Débit historique (m³/h)'] : []), 'Volume demandé (m³)', ...auditColumns], timezone)
  for (const response of expectedResponses) {
    const submission = response.latestSubmission
    const audit = submission ? [transmittedBy(submission), localTimestamp(submission.submittedAt, timestampFormatter)] : ['', null]
    summary.addRow([campaign.name, preleveurMap.get(response.preleveurUserId), kindLabels[response.kind], submission ? 'Reçue' : 'Non transmise', ...audit, submission?.snapshot?.comment ?? ''])
    if (!submission) {
      continue
    }

    const {snapshot = {}, publication} = submission
    for (const reading of snapshot.readings ?? []) {
      const target = targetMap.get(reading.targetId)
      if (target) {
        indices.addRow([
          ...pointValues(target),
          meterName(target, reading.compteurId),
          civilDate(reading.readingDate),
          decimalText(reading.value),
          reading.missingReason ?? '',
          readingOrigin(reading),
          reading.correctionReason ?? '',
          reading.meterConfirmed === true ? 'Oui' : '',
          ...audit
        ])
      }
    }

    for (const event of snapshot.meterEvents ?? []) {
      const target = targetMap.get(event.targetId)
      if (target) {
        events.addRow([
          ...pointValues(target),
          eventLabels[event.type] || 'Changement de compteur',
          civilDate(event.at),
          meterName(target, event.previousCompteurId),
          meterName(target, event.nextCompteurId ?? event.previousCompteurId),
          decimalText(event.previousIndex),
          decimalText(event.nextIndex),
          event.previousMissingReason ?? '',
          event.nextMissingReason ?? '',
          event.reason ?? '',
          ...audit
        ])
      }
    }

    for (const total of publication?.totals ?? []) {
      const target = targetMap.get(total.targetId)
      const period = periodMap.get(total.periodId)
      if (target && period) {
        const reasons = [...new Set([...(total.missing ?? []), ...(total.conflicts ?? [])].map(reason => reasonLabel(reason)))].join('; ')
        volumes.addRow([
          ...pointValues(target),
          period.label,
          civilDate(total.periodStart ?? period.startDate),
          civilDate(total.periodEnd ?? period.endDate, {end: true}),
          total.status === 'COMPLETE' ? decimalText(total.value) : '',
          statusLabels[total.status] || 'Calcul à vérifier',
          reasons,
          ...audit
        ])
      }
    }

    for (const line of snapshot.needs ?? []) {
      const target = targetMap.get(line.targetId)
      const period = periodMap.get(line.periodId)
      if (target && period) {
        needs.addRow([
          ...pointValues(target),
          period.label,
          civilDate(period.startDate),
          civilDate(period.endDate, {end: true}),
          ...(hasLegacyFlow ? [decimalText(line.requestedFlow)] : []),
          decimalText(line.requestedVolume),
          ...audit
        ])
      }
    }
  }

  return workbook
}
