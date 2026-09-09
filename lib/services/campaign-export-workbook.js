import ExcelJS from 'exceljs'

const dateText = value => value instanceof Date ? value.toISOString() : String(value ?? '')

function addSheet(workbook, name, headers) {
  const sheet = workbook.addWorksheet(name, {views: [{state: 'frozen', ySplit: 1}]})
  sheet.columns = headers.map(header => ({header, width: 25}))
  sheet.getRow(1).font = {bold: true}
  sheet.autoFilter = {from: {row: 1, column: 1}, to: {row: 1, column: headers.length}}
  return sheet
}

// Decimal values remain strings: Excel's 15-digit numeric precision must not
// change an index. Plain string cells never become formulas or hyperlinks.
export function buildCampaignWorkbook({campaign, targets, responses}) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Partageons l’eau'
  const summary = addSheet(workbook, 'Transmissions', ['Campagne', 'Préleveur', 'Volet', 'État', 'Version transmise', 'Transmission', 'Auteur', 'Commentaire'])
  const indices = addSheet(workbook, 'Index', [
    'Cible',
    'Point',
    'Exploitation',
    'Préleveur',
    'Compteur',
    'Date du relevé',
    'Index m³',
    'Motif absence',
    'Relevé source',
    'Version source',
    'Relevé corrigé',
    'Motif de correction',
    'Transmission',
    'Version',
    'Auteur',
    'Date transmission',
    'Même compteur confirmé'
  ])
  const events = addSheet(workbook, 'Événements compteurs', ['Cible', 'Type', 'Date', 'Ancien compteur', 'Nouveau compteur', 'Index final ancien', 'Index initial nouveau', 'Motif', 'Transmission', 'Version'])
  const volumes = addSheet(workbook, 'Volumes exacts', ['Cible', 'Point', 'Préleveur', 'Période', 'Début inclus', 'Fin exclue', 'Volume m³', 'État', 'Motifs', 'Transmission', 'Version', 'Auteur', 'Date transmission'])
  const needs = addSheet(workbook, 'Besoins', ['Cible', 'Point', 'Exploitation', 'Préleveur', 'Période', 'Début inclus', 'Fin exclue', 'Débit demandé m³/h', 'Volume demandé m³', 'Transmission', 'Version', 'Auteur', 'Date transmission'])
  const targetMap = new Map(targets.map(target => [target.id, target]))
  const periodMap = new Map(campaign.periods.map(period => [period.id, period]))
  const responseMap = new Map(responses.map(response => [`${response.preleveurUserId}:${response.kind}`, response]))
  const expectedResponses = [...new Set(targets.map(target => target.preleveurUserId))]
    .flatMap(preleveurUserId => ['INDEX', 'NEEDS'].map(kind => responseMap.get(`${preleveurUserId}:${kind}`) ?? {preleveurUserId, kind}))
  for (const response of expectedResponses) {
    const submission = response.latestSubmission
    summary.addRow([campaign.name, response.preleveurUserId, response.kind, submission ? 'TRANSMIS' : 'NON TRANSMIS', submission?.version ?? '', dateText(submission?.submittedAt), submission?.createdByUserId ?? '', submission?.snapshot?.comment ?? ''])
    if (!submission) {
      continue
    }

    const {snapshot = {}, publication = {}} = submission
    const audit = [submission.id, submission.version, submission.createdByUserId, dateText(submission.submittedAt)]
    for (const reading of snapshot.readings ?? []) {
      const target = targetMap.get(reading.targetId)
      if (target) {
        indices.addRow([
          target.id,
          target.pointPrelevementId,
          target.exploitationId,
          target.preleveurUserId,
          reading.compteurId ?? 'Non renseigné',
          reading.readingDate,
          reading.value === null || reading.value === undefined ? '' : String(reading.value),
          reading.missingReason ?? '',
          reading.sourceChunkValueId ?? '',
          reading.sourceValueUpdatedAt ?? '',
          reading.correctionOfChunkValueId ?? '',
          reading.correctionReason ?? '',
          ...audit,
          reading.meterConfirmed === true ? 'Oui' : ''
        ])
      }
    }

    for (const event of snapshot.meterEvents ?? []) {
      if (targetMap.has(event.targetId)) {
        events.addRow([event.targetId, event.type, event.at, event.previousCompteurId, event.nextCompteurId ?? event.previousCompteurId, String(event.previousIndex ?? ''), String(event.nextIndex ?? ''), event.reason, submission.id, submission.version])
      }
    }

    for (const total of publication?.totals ?? []) {
      const target = targetMap.get(total.targetId)
      if (target) {
        const reasons = [...(total.missing ?? []), ...(total.conflicts ?? [])]
          .map(reason => typeof reason === 'string' ? reason : reason.reason ?? reason.code ?? JSON.stringify(reason)).join('; ')
        volumes.addRow([target.id, target.pointPrelevementId, target.preleveurUserId, periodMap.get(total.periodId)?.label ?? total.periodId, dateText(total.periodStart), dateText(total.periodEnd), total.value === null || total.value === undefined ? '' : String(total.value), total.status, reasons, ...audit])
      }
    }

    for (const line of snapshot.needs ?? []) {
      const target = targetMap.get(line.targetId)
      const period = periodMap.get(line.periodId)
      if (target && period) {
        needs.addRow([target.id, target.pointPrelevementId, target.exploitationId, target.preleveurUserId, period.label, dateText(period.startDate).slice(0, 10), dateText(period.endDate).slice(0, 10), String(line.requestedFlow ?? ''), String(line.requestedVolume ?? ''), ...audit])
      }
    }
  }

  return workbook
}
