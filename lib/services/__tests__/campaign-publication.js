import test from 'ava'
import {publishCampaignIndexSubmission, planCampaignVolumePublication} from '../campaign-publication.js'
import {classifyCampaignVolumeConflicts, applyConflictPolicyForIncomingChunkValues} from '../chunk-value-conflicts.js'
import {reconstructVolumesForChunks} from '../volumes-from-index.js'
import {normalizePublishedCampaignDraft} from '../campaigns.js'

const period = (start, end) => ({periodStart: new Date(start), periodEnd: new Date(end)})
const periods = [
  {id: 'winter', kind: 'INDEX', position: 0, startDate: '2025-11-01', endDate: '2026-06-01', startReadingDate: '2025-10-31', endReadingDate: '2026-06-01'},
  {id: 'summer', kind: 'INDEX', position: 1, startDate: '2026-06-01', endDate: '2026-11-01', startReadingDate: '2026-06-01', endReadingDate: '2026-10-31'}
]
const target = {id: 'target', pointPrelevementId: 'point', preleveurUserId: 'user', usageId: 'usage', flowType: 'PRELEVEMENT', meters: [{compteurId: 'meter'}]}
const readings = ['2025-10-31', '2026-06-01', '2026-10-31'].map((readingDate, index) => ({targetId: 'target', compteurId: 'meter', readingDate, value: String(index * 100)}))
const submission = {id: 'submission', responseId: 'response', createdByUserId: 'actor', snapshot: {readings, meterEvents: []}}
const campaign = {id: 'campaign', periods}
const total = (start, end) => ({...period(start, end), targetId: target.id, value: '100', status: 'COMPLETE', conflicts: []})

function fakeClient({conflicts = [], existingReadings = []} = {}) {
  const state = {conflicts, existingReadings, sources: [], chunks: [], coverages: [], audits: [], deleted: [], publication: null, locks: 0}
  const client = {
    state,
    async $executeRaw() {
      state.locks++
    },
    async $queryRaw(strings) {
      return strings.join('').includes('WITH incoming') ? state.conflicts : []
    },
    campaignSubmission: {async findUnique() {
      return {publication: state.publication}
    }},
    declarant: {async findUnique() {
      return {userId: 'actor', declarantRole: 'COLLECTEUR'}
    }},
    source: {
      async create({data}) {
        state.sources.push(data)
        return data
      },
      async findMany() {
        return []
      },
      async update() {}
    },
    chunk: {
      async create({data}) {
        state.chunks.push(data)
        return data
      },
      async findMany() {
        return []
      },
      async update() {}
    },
    chunkValue: {
      async findMany({where} = {}) {
        if (where?.chunk?.metadata) {
          return state.chunks.filter(chunk => JSON.stringify(chunk.metadata.campaignMeterEvent) === JSON.stringify(where.chunk.metadata.equals))
            .flatMap(chunk => chunk.chunkValues.create)
            .filter(value => String(value.value) === String(where.value) && value.readingDate.getTime() === where.readingDate.getTime())
        }

        return state.existingReadings
      },
      async deleteMany({where}) {
        state.deleted.push(...where.id.in)
      },
      async groupBy() {
        return []
      }
    },
    chunkValueReplacement: {
      async createMany({data}) {
        state.audits.push(...data)
      },
      async create({data}) {
        state.audits.push(data)
      }
    },
    campaignCoverage: {
      async findMany() {
        return state.coverages.filter(coverage => coverage.active !== false)
      },
      async updateMany({where, data}) {
        for (const coverage of state.coverages.filter(coverage => where.id.in.includes(coverage.id))) {
          Object.assign(coverage, data)
        }
      },
      async create({data}) {
        state.coverages.push(data)
      }
    }
  }
  return client
}

function conflict(start, end) {
  return {...period(start, end), chunkValueId: 'old-volume', chunkId: 'old-chunk', sourceId: 'old-source', pointPrelevementId: 'point', metricTypeCode: 'volume', frequency: '1 month', valueKind: 'DECLARED', value: 20, unit: 'm³'}
}

test('conflits complets et partiels sont distingués, sans découpage', t => {
  const inside = conflict('2026-01-01', '2026-02-01')
  const outside = conflict('2025-10-01', '2025-12-01')
  const adjacent = conflict('2026-11-01', '2026-12-01')
  t.deepEqual(classifyCampaignVolumeConflicts({conflicts: [inside, outside, adjacent], periods: [period('2025-11-01', '2026-11-01')]}), {complete: [inside], partial: [outside]})
})

test('les périodes contiguës couvrent intégralement un ancien intervalle sans prorata', t => {
  const totals = [total('2025-11-01', '2026-06-01'), total('2026-06-01', '2026-11-01')]
  const result = planCampaignVolumePublication({totals, conflicts: [conflict('2026-05-01', '2026-07-01')]})
  t.deepEqual(result.map(row => row.status), ['COMPLETE', 'COMPLETE'])
})

test('un conflit partiel se propage aux autres périodes si leur remplacement devient partiel', t => {
  const totals = [total('2025-11-01', '2026-06-01'), total('2026-06-01', '2026-11-01')]
  const result = planCampaignVolumePublication({totals, conflicts: [conflict('2025-10-01', '2026-02-01'), conflict('2026-05-01', '2026-07-01')]})
  t.deepEqual(result.map(row => row.status), ['CONFLICT', 'CONFLICT'])
  t.deepEqual(result.map(row => row.value), [null, null])
})

test('publication crée index canoniques et volumes COMPUTED exacts, rejouable sans doublon', async t => {
  const client = fakeClient()
  const publication = await publishCampaignIndexSubmission({submission, campaign, targets: [target], actorUserId: 'actor', client})
  t.is(client.state.sources.length, 1)
  t.is(client.state.chunks.length, 2)
  t.true(client.state.chunks.every(chunk => chunk.calculationStrategy === 'CAMPAIGN'))
  const volumes = client.state.chunks.flatMap(chunk => chunk.chunkValues.create).filter(value => value.metricTypeCode === 'volume')
  t.deepEqual(volumes.map(value => value.valueKind), ['COMPUTED', 'COMPUTED'])
  t.is(volumes[0].periodStart.toISOString(), '2025-11-01T00:00:00.000Z')
  t.is(volumes[0].periodEnd.toISOString(), '2026-06-01T00:00:00.000Z')
  t.is(client.state.coverages.length, 2)
  client.state.publication = publication
  const replay = await publishCampaignIndexSubmission({submission, campaign, targets: [target], actorUserId: 'actor', client})
  t.deepEqual(replay, publication)
  t.is(client.state.chunks.length, 2)
})

test('chevauchement partiel transmet les index mais ne détruit ni ne couvre le volume ancien', async t => {
  const client = fakeClient({conflicts: [conflict('2025-10-01', '2026-01-01')]})
  const publication = await publishCampaignIndexSubmission({submission, campaign, targets: [target], actorUserId: 'actor', client})
  t.deepEqual(publication.totals.map(row => row.status), ['CONFLICT', 'COMPLETE'])
  t.deepEqual(client.state.deleted, [])
  t.deepEqual(client.state.audits, [])
  t.deepEqual(client.state.coverages.map(coverage => coverage.periodId), ['summer'])
})

test('volume entièrement couvert remplacé avec historique complet', async t => {
  const client = fakeClient({conflicts: [conflict('2026-01-01', '2026-02-01')]})
  await publishCampaignIndexSubmission({submission, campaign, targets: [target], actorUserId: 'actor', client})
  t.deepEqual(client.state.deleted, ['old-volume'])
  t.is(client.state.audits[0].value, 20)
  t.is(client.state.audits[0].conflictPolicy, 'CAMPAIGN_SUPERSEDE')
  t.is(client.state.audits[0].metadata.submissionId, submission.id)
})

test('absences justifiées créent une couverture persistante sans faux volume zéro', async t => {
  const client = fakeClient()
  const missingSubmission = {...submission, snapshot: {readings: readings.map(reading => ({...reading, value: null, missingReason: 'Compteur inaccessible'}))}}
  const publication = await publishCampaignIndexSubmission({submission: missingSubmission, campaign, targets: [target], actorUserId: 'actor', client})
  t.deepEqual(publication.totals.map(row => row.value), [null, null])
  t.is(client.state.coverages.length, 2)
  t.true(client.state.coverages.every(coverage => coverage.chunkValueId === null))
  t.is(client.state.chunks.flatMap(chunk => chunk.chunkValues.create).length, 0)
})

test('index de transition manquant ne produit aucune mesure factice et les bornes connues sont canoniques', async t => {
  const client = fakeClient()
  const eventSubmission = {...submission, snapshot: {...submission.snapshot, meterEvents: [{targetId: target.id, type: 'RESET', at: '2026-01-01', previousCompteurId: 'meter', previousIndex: null, nextIndex: '0', reason: 'Ancien compteur illisible'}]}}
  const publication = await publishCampaignIndexSubmission({submission: eventSubmission, campaign, targets: [target], actorUserId: 'actor', client})
  t.is(publication.totals[0].value, null)
  t.is(publication.totals[0].status, 'MISSING')
  t.is(publication.meterEventReferences[0].previous.chunkValueId, null)
  t.truthy(publication.meterEventReferences[0].next.chunkValueId)
  t.is(client.state.chunks.flatMap(chunk => chunk.chunkValues.create).filter(value => value.metricTypeCode === 'index').length, 4)
})

test('révision de commentaire réutilise aussi les deux index canoniques de reset', async t => {
  const client = fakeClient()
  const eventSubmission = {...submission, snapshot: {...submission.snapshot, meterEvents: [{targetId: target.id, type: 'RESET', at: '2026-01-01', previousCompteurId: 'meter', previousIndex: '50', nextIndex: '0', reason: 'Remise à zéro'}]}}
  await publishCampaignIndexSubmission({submission: eventSubmission, campaign, targets: [target], actorUserId: 'actor', client})
  client.state.existingReadings = client.state.chunks.filter(chunk => !chunk.metadata.campaignMeterEvent).flatMap(chunk => chunk.chunkValues.create
    .filter(value => value.metricTypeCode === 'index')
    .map(value => ({...value, chunkId: chunk.id, chunk: {...chunk, source: {status: 'COMPLETED'}}})))
  await publishCampaignIndexSubmission({submission: {...eventSubmission, id: 'next'}, campaign, targets: [target], actorUserId: 'actor', client})
  t.is(client.state.chunks.flatMap(chunk => chunk.chunkValues.create).filter(value => value.metricTypeCode === 'index').length, 5)
})

test('volume ancien sans préleveur identifié ne peut être attribué ni écrasé automatiquement', t => {
  const old = {...conflict('2026-01-01', '2026-02-01'), preleveurUserId: null}
  const result = planCampaignVolumePublication({totals: [total('2025-11-01', '2026-06-01')], conflicts: [old]})
  t.is(result[0].status, 'CONFLICT')
  t.is(result[0].conflicts[0].code, 'AMBIGUOUS_VOLUME_OWNER')
})

test('reprise d’un index existant ne le duplique pas', async t => {
  const source = {id: 'old-index', valueKind: 'DECLARED', metricTypeCode: 'index', value: '0', updatedAt: new Date('2026-01-01'), periodStart: new Date('2025-10-31'), chunk: {pointPrelevementId: 'point', preleveurUserId: 'user', compteurId: 'meter', instructionStatus: 'VALIDATED', source: {status: 'COMPLETED'}}}
  const client = fakeClient({existingReadings: [source]})
  const referencedSubmission = {...submission, snapshot: {readings: [{...readings[0], sourceChunkValueId: source.id, sourceValueUpdatedAt: source.updatedAt}, ...readings.slice(1)]}}
  const publication = await publishCampaignIndexSubmission({submission: referencedSubmission, campaign, targets: [target], actorUserId: 'actor', client})
  t.is(client.state.chunks.flatMap(chunk => chunk.chunkValues.create).filter(value => value.metricTypeCode === 'index').length, 2)
  t.true(publication.readingReferences.some(reference => reference.chunkValueId === source.id))
})

test('sans inventaire, publication et révision conservent les index par point sans créer de compteur', async t => {
  const client = fakeClient()
  const meterlessTarget = {...target, meters: []}
  const snapshot = {readings: readings.map(reading => ({...reading, compteurId: null, meterConfirmed: true}))}
  const first = await publishCampaignIndexSubmission({submission: {...submission, snapshot}, campaign, targets: [meterlessTarget], actorUserId: 'actor', client})
  t.deepEqual(first.totals.map(row => row.value), ['100', '100'])
  t.true(first.readingReferences.every(reference => reference.compteurId === null))
  const indexChunks = client.state.chunks.filter(chunk => chunk.chunkValues.create.some(value => value.metricTypeCode === 'index'))
  t.is(indexChunks.length, 1)
  t.is(indexChunks[0].compteurId, null)
  t.is(indexChunks[0].pointPrelevementId, target.pointPrelevementId)
  client.state.existingReadings = indexChunks.flatMap(chunk => chunk.chunkValues.create.map(value => ({...value, chunkId: chunk.id, chunk: {...chunk, source: {status: 'COMPLETED'}}})))
  const draft = normalizePublishedCampaignDraft(snapshot, first)
  t.true(draft.readings.every(reading => reading.meterConfirmed === true && reading.sourceChunkValueId))
  await publishCampaignIndexSubmission({submission: {...submission, id: 'revision', snapshot: {...draft, comment: 'Précision'}}, campaign, targets: [meterlessTarget], actorUserId: 'actor', client})
  t.is(client.state.chunks.flatMap(chunk => chunk.chunkValues.create).filter(value => value.metricTypeCode === 'index').length, 3)
  t.deepEqual(client.state.deleted, [])
})

test('sans confirmation de continuité, aucune source ou donnée de volume ne peut être publiée', async t => {
  const client = fakeClient()
  const snapshot = {readings: readings.map(reading => ({...reading, compteurId: null}))}
  const error = await t.throwsAsync(() => publishCampaignIndexSubmission({submission: {...submission, snapshot}, campaign, targets: [{...target, meters: []}], actorUserId: 'actor', client}))
  t.is(error.statusCode, 409)
  t.deepEqual(client.state.sources, [])
  t.deepEqual(client.state.chunks, [])
  t.deepEqual(client.state.coverages, [])
})

test('correction d’un relevé crée un successeur audité sans supprimer la mesure précédente', async t => {
  const source = {
    id: 'old-index', chunkId: 'old-index-chunk', valueKind: 'DECLARED', metricTypeCode: 'index', value: '0', frequency: 'instant', unit: 'm³',
    updatedAt: new Date('2026-01-01'), periodStart: new Date('2025-10-31'), periodEnd: new Date('2025-10-31T00:15:00Z'),
    chunk: {sourceId: 'old-source', pointPrelevementId: 'point', preleveurUserId: 'user', compteurId: 'meter', instructionStatus: 'VALIDATED', source: {status: 'COMPLETED'}}
  }
  const client = fakeClient({existingReadings: [source]})
  const corrected = {...submission, snapshot: {readings: [{...readings[0], value: '1', correctionOfChunkValueId: source.id, sourceValueUpdatedAt: source.updatedAt, correctionReason: 'Transcription'}, ...readings.slice(1)]}}
  await publishCampaignIndexSubmission({submission: corrected, campaign, targets: [target], actorUserId: 'actor', client})
  t.is(client.state.audits[0].conflictPolicy, 'CAMPAIGN_READING_CORRECTION')
  t.is(client.state.audits[0].replacedChunkValueId, source.id)
  t.truthy(client.state.audits[0].replacementChunkValueId)
  t.deepEqual(client.state.deleted, [])
})

test('nouvelle révision avec les mêmes relevés non référencés ne recrée pas les index', async t => {
  const client = fakeClient()
  await publishCampaignIndexSubmission({submission, campaign, targets: [target], actorUserId: 'actor', client})
  client.state.existingReadings = client.state.chunks.flatMap(chunk => chunk.chunkValues.create
    .filter(value => value.metricTypeCode === 'index')
    .map(value => ({...value, chunkId: chunk.id, chunk: {...chunk, source: {status: 'COMPLETED'}}})))
  const next = {...submission, id: 'next-submission', snapshot: {...submission.snapshot, comment: 'Commentaire corrigé'}}
  const result = await publishCampaignIndexSubmission({submission: next, campaign, targets: [target], actorUserId: 'actor', client})
  t.is(client.state.chunks.flatMap(chunk => chunk.chunkValues.create).filter(value => value.metricTypeCode === 'index').length, 3)
  t.true(result.readingReferences.every(reference => client.state.existingReadings.some(value => value.id === reference.chunkValueId)))
  t.is(client.state.coverages.filter(coverage => coverage.active !== false).length, 2)
})

test('une ancienne réimportation ne peut remplacer une couverture de campagne', async t => {
  const client = fakeClient()
  client.state.coverages = [{...period('2025-11-01', '2026-06-01'), active: true}]
  const result = await applyConflictPolicyForIncomingChunkValues({client, pointPrelevementId: 'point', preleveurUserId: 'user', requestedPolicy: 'REPLACE_EXISTING', valueRows: [{...period('2026-01-01', '2026-02-01'), metricTypeCode: 'volume', value: 500}]})
  t.true(result.shouldSkip)
  t.deepEqual(result.valueRowsToInsert, [])
  t.deepEqual(client.state.deleted, [])
})

test('reconstruction générique exclut les chunks campagne en création ET suppression', async t => {
  const queries = []
  const deletions = []
  const client = {
    async $queryRaw(strings) {
      queries.push(strings.join(''))
      return []
    },
    chunkValue: {async deleteMany({where}) {
      deletions.push(where)
    }}
  }
  const chunk = {id: 'generic', pointPrelevementId: 'point', calculationStrategy: 'GENERIC', chunkValues: [{metricTypeCode: 'index', valueKind: 'DECLARED'}]}
  const result = await reconstructVolumesForChunks([chunk, {...chunk, id: 'campaign', calculationStrategy: 'CAMPAIGN'}], client)
  t.deepEqual(deletions[0].chunkId.in, ['generic'])
  t.is(result.details[1].reason, 'CAMPAIGN_EXACT_CALCULATION')
  t.regex(queries[0], /"calculationStrategy" = 'GENERIC'/)
  t.regex(queries[0], /"CampaignCoverage"/)
  t.regex(queries[0], /PARTITION BY "preleveurUserId", "compteurId"/)
})
