import {
  createCollectionCampaign, listCollectionCampaigns, getCollectionCampaignSummary,
  getCollectionCampaign, listCollectionCandidates, updateCollectionCampaign,
  transitionCollectionCampaign, listCollectionResponses, getAuthorizedCampaignResponseContext,
  saveCollectionResponseDraft, getCollectionResults
} from '../services/collection-campaigns.js'
import {submitCampaignResponse} from '../services/campaign-submission.js'
import {approveCampaignMeter, getCampaignMeterReview} from '../services/campaign-meter-publication.js'
import {validateCampaignId, validateCampaignQuery, validateResponseWrite} from '../validation/collection-campaigns.js'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'

const id = req => validateCampaignId(req.params.campaignId)
const responseId = req => validateCampaignId(req.params.responseId)
const send = (res, data) => res.json({success: true, data})

export async function listCollectionCampaignsHandler(req, res) { send(res, await listCollectionCampaigns(req.user, validateCampaignQuery(req.query))) }
export async function getCollectionCampaignSummaryHandler(req, res) { send(res, await getCollectionCampaignSummary(req.user)) }
export async function getCollectionCampaignHandler(req, res) { send(res, await getCollectionCampaign(req.user, id(req))) }
export async function listCollectionCandidatesHandler(req, res) { send(res, await listCollectionCandidates(req.user, validateCampaignQuery(req.query))) }
export async function createCollectionCampaignHandler(req, res) { res.status(201); send(res, await createCollectionCampaign(req.body, {user: req.user})) }
export async function updateCollectionCampaignHandler(req, res) { send(res, await updateCollectionCampaign(req.user, id(req), req.body)) }
export const transitionCollectionCampaignHandler = action => async (req, res) => { send(res, await transitionCollectionCampaign(req.user, id(req), action)) }
export async function listCollectionResponsesHandler(req, res) { send(res, await listCollectionResponses(req.user, id(req), validateCampaignQuery(req.query))) }
export async function getCollectionResponseHandler(req, res) { send(res, await getAuthorizedCampaignResponseContext(req.user, id(req), responseId(req))) }
export async function saveCollectionResponseDraftHandler(req, res) { send(res, await saveCollectionResponseDraft(req.user, id(req), responseId(req), validateResponseWrite(req.body))) }
export async function submitCollectionResponseHandler(req, res) { send(res, await submitCampaignResponse({user: req.user, campaignId: id(req), responseId: responseId(req), body: validateResponseWrite(req.body)})) }
export async function approveCollectionMeterHandler(req, res) { send(res, await approveCampaignMeter({user: req.user, campaignId: id(req), compteurId: validateCampaignId(req.params.compteurId), body: req.body})) }
export async function getCollectionMeterReviewHandler(req, res) { send(res, await getCampaignMeterReview({user: req.user, campaignId: id(req), compteurId: validateCampaignId(req.params.compteurId)})) }
export async function getCollectionResultsHandler(req, res) { send(res, await getCollectionResults(req.user, id(req), validateCampaignQuery(req.query))) }

export function campaignCsvCell(value) {
  const text = String(value ?? '')
  const safe = /^[=+\-@]/.test(text.trimStart()) || /^[\t\r\n]/.test(text) ? `'${text}` : text
  return `"${safe.replaceAll('"', '""')}"`
}

export function campaignResponseCsvRows(response) {
  const identity = [response.preleveur?.socialReason, response.preleveur?.siret, response.preleveur?.email, response.point?.name, response.countingCode]
  const submitted = response.submittedData ?? {}
  const publicationLabel = {NOT_SUBMITTED: 'Non soumis', PUBLISHED: 'Publié', PENDING_REVIEW: 'En attente de validation'}[response.publicationStatus] ?? response.publicationStatus
  const suffix = [publicationLabel, response.lastSubmittedAt?.toISOString?.() ?? response.lastSubmittedAt, submitted.comment]
  const rows = []
  for (const meter of submitted.meters ?? []) {
    for (const [key, label] of [['offSeason', 'Hors étiage 2025–2026'], ['season', 'Étiage 2026']]) {
      const period = meter[key] ?? {}
      rows.push([...identity, 'Bilan', meter.serialNumber, label, period.usageId,
        key === 'offSeason' ? period.indexStart : meter.offSeason?.indexEnd, period.indexEnd, '', '', period.surface, period.crops,
        ...suffix, ''])
    }
  }
  for (const [key, label] of [['season', 'Étiage 2027'], ['offSeason', 'Hors étiage 2026–2027']]) {
    const period = submitted.needs?.[key] ?? {}
    rows.push([...identity, 'Besoins', '', label, period.usageId, '', '', period.flow, period.volume, period.surface, period.crops,
      ...suffix, ''])
  }
  for (const [key, label] of [['offSeason', 'Hors étiage 2025–2026'], ['season', 'Étiage 2026']]) {
    rows.push([...identity, 'Volumes publiés', '', label, '', '', '', '', '', '', '', ...suffix, response.volumes?.[key] ?? ''])
  }
  return rows
}

export async function exportCollectionResultsHandler(req, res) {
  const campaignId = id(req)
  const header = ['Préleveur', 'SIRET', 'Email', 'Point de prélèvement', 'Code comptage', 'Section', 'Numéro de compteur', 'Période', 'Sous-usage', 'Index début (m³)', 'Index fin (m³)', 'Débit demandé (m³/h)', 'Volume demandé (m³)', 'Surface (ha)', 'Assolements', 'Publication des volumes', 'Dernier envoi', 'Commentaire', 'Volume prélevé publié (m³)']
  // Authorize and read the first page before committing HTTP headers.
  const firstPage = await getCollectionResults(req.user, campaignId, {page: 1, pageSize: 200})
  const usageLabels = new Map(firstPage.waterUses.map(usage => [usage.id, usage.label]))
  const line = row => `${row.map(campaignCsvCell).join(';')}\r\n`
  async function* rows() {
    yield `\uFEFF${line(header)}`
    let page = 1
    let result = firstPage
    while (true) {
      for (const response of result.items) {
        for (const row of campaignResponseCsvRows(response)) {
          row[8] = usageLabels.get(row[8]) ?? row[8]
          yield line(row)
        }
      }
      if (page * 200 >= result.total) return
      page++
      // eslint-disable-next-line no-await-in-loop -- Stream bounded pages and recheck current response permissions.
      result = await listCollectionResponses(req.user, campaignId, {page, pageSize: 200, status: 'SUBMITTED'})
    }
  }
  res.set('Content-Type', 'text/csv; charset=utf-8')
  res.set('Content-Disposition', `attachment; filename="campagne-${campaignId}.csv"`)
  try {
    await pipeline(Readable.from(rows()), res)
  } catch (error) {
    if (!res.headersSent) throw error
    // An interrupted CSV must not become a successful file with appended JSON.
    if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error('[campaign-export] stream interrupted', {code: error.code ?? 'STREAM_ERROR'})
    res.destroy()
  }
}
