import test from 'ava'
import {readFileSync} from 'node:fs'
import {validateCampaignInput, validateCollectionResponseData, validateCampaignQuery, validateResponseWrite} from '../../validation/collection-campaigns.js'
import {isCampaignOpen, assertCampaignResponseWritable, serializeCampaignResponse, campaignResponseAccessWhere, createCollectionCampaign, getCampaignPermissions, buildInitialCampaignData, runCollectionTransaction, getCampaignResponseVolumes, getAuthorizedCampaignResponseContext} from '../collection-campaigns.js'
import {meterBusinessDateBoundary} from '../meter-core.js'

const owner = '10000000-0000-4000-8000-000000000001'
const collector = '10000000-0000-4000-8000-000000000002'
const exploitationId = '10000000-0000-4000-8000-000000000003'
const usageId = '10000000-0000-4000-8000-000000000004'
const farmer = {id: owner, role: 'DECLARANT'}
const campaign = {id: 'campaign', status: 'OPEN', opensOn: new Date('2026-09-01'), closesOn: new Date('2026-12-31'), collecteurUserId: collector}
const period = {usageId, surface: '0', crops: 'Aucune'}
const data = () => ({meters: [{compteurId: null, serialNumber: 'MANUAL-1', offSeason: {...period, indexStart: '100', indexEnd: '200'}, season: {...period, indexEnd: '300'}}], needs: {offSeason: {...period, flow: '0', volume: '0'}, season: {...period, flow: '0', volume: '0'}}, comment: ''})
const context = () => ({campaign, response: {preleveurUserId: owner}, exploitation: {declarantUserId: owner, status: 'EN_ACTIVITE', declarant: {quickDeclarationEnabled: true, user: {deletedAt: null}}, pointPrelevement: {collectionMode: 'MANUAL', deletedAt: null}}})

test('un brouillon autorise les champs absents et les décimales à virgule', t => {
  t.deepEqual(validateCollectionResponseData({meters: [], needs: {season: {surface: '1,25'}}}), {meters: [], needs: {season: {surface: '1.25'}}})
})

test('les assolements acceptent plusieurs libellés indépendants dans les quatre périodes', t => {
  const value = data()
  for (const section of [value.meters[0], value.needs]) {
    for (const key of ['offSeason', 'season']) section[key].crops = ['  Céréales  ', 'Maïs', 'Blé tendre']
  }
  const validated = validateCollectionResponseData(value, {submitted: true})
  for (const section of [validated.meters[0], validated.needs]) {
    for (const key of ['offSeason', 'season']) t.deepEqual(section[key].crops, ['Céréales', 'Maïs', 'Blé tendre'])
  }
})

test('les anciennes chaînes d’assolement restent acceptées sans découpage', t => {
  const value = data()
  value.needs.season.crops = 'Culture historique, sans correspondance ; autre'
  t.is(validateCollectionResponseData(value, {submitted: true}).needs.season.crops, value.needs.season.crops)
  value.needs.season.crops = ['x'.repeat(3000)]
  t.deepEqual(validateCollectionResponseData(value, {submitted: true}).needs.season.crops, value.needs.season.crops)
})

test('seule la réalimentation et ses sous-usages dispensent de surface et d’assolement à la soumission', t => {
  const rootId = '10000000-0000-4000-8000-000000000012'
  const childId = '10000000-0000-4000-8000-000000000013'
  const waterUses = [{id: rootId, code: '12', kind: 'USAGE'}, {id: childId, code: '12E', kind: 'SUB_USAGE', parentId: rootId}]
  const value = data()
  for (const section of [value.meters[0], value.needs]) {
    section.offSeason = {...section.offSeason, usageId: rootId, surface: '', crops: []}
    section.season.usageId = childId
    delete section.season.surface
    delete section.season.crops
  }
  t.deepEqual(validateCollectionResponseData(value, {submitted: true, waterUses}), value)
  const onlySelectedChild = [{...waterUses[1], parent: waterUses[0]}]
  t.notThrows(() => validateCollectionResponseData({...data(), needs: {offSeason: {usageId: childId, flow: '0', volume: '0'}, season: data().needs.season}}, {submitted: true, waterUses: onlySelectedChild}))
  // A syntactically valid but unrecognized usage never gains this exemption.
  value.needs.season.usageId = usageId
  const error = t.throws(() => validateCollectionResponseData(value, {submitted: true, waterUses}))
  t.deepEqual(Object.keys(error.data.fields), ['needs.season.surface', 'needs.season.crops'])
  value.needs.season.usageId = childId
  value.needs.season.surface = '-1'
  t.truthy(t.throws(() => validateCollectionResponseData(value, {submitted: true, waterUses})).data.fields['needs.season.surface'])
})

test('la validation structurelle diffère les exigences agricoles sans relâcher les index, volumes et usages', t => {
  const value = data()
  delete value.needs.season.surface
  delete value.needs.season.crops
  const options = {submitted: true, deferAgriculturalRequirements: true}
  t.notThrows(() => validateCollectionResponseData(value, options))
  for (const field of ['usageId', 'volume', 'flow']) {
    const invalid = structuredClone(value)
    delete invalid.needs.season[field]
    t.truthy(t.throws(() => validateCollectionResponseData(invalid, options)).data.fields[`needs.season.${field}`])
  }
})

test('un tableau d’assolement vide est conservé en brouillon et refusé à l’envoi dans chaque période', t => {
  const value = data()
  for (const section of [value.meters[0], value.needs]) {
    for (const key of ['offSeason', 'season']) section[key].crops = []
  }
  t.deepEqual(validateCollectionResponseData(value), value)
  const error = t.throws(() => validateCollectionResponseData(value, {submitted: true}))
  t.is(error.status, 400)
  t.deepEqual(Object.keys(error.data.fields), ['meters.0.offSeason.crops', 'meters.0.season.crops', 'needs.offSeason.crops', 'needs.season.crops'])
})

test('les tableaux d’assolement bornent les libellés et refusent les valeurs vides, doublons ou non textuelles', t => {
  for (const crops of [[''], ['  '], [null], [5], [{}], [['Maïs']], ['Maïs', ' Maïs '], ['x'.repeat(3001)], Array.from({length: 101}, (_, index) => `Culture ${index}`)]) {
    const value = data()
    value.needs.season.crops = crops
    t.throws(() => validateCollectionResponseData(value))
    t.throws(() => validateCollectionResponseData(value, {submitted: true}))
  }
})

test('un brouillon peut conserver des index incohérents à corriger sans les publier', t => {
  const value = data()
  value.meters[0].offSeason.indexEnd = '99,5'
  value.meters[0].season.indexEnd = ''
  t.is(validateCollectionResponseData(value).meters[0].offSeason.indexEnd, '99.5')
})

test('la soumission signale chaque index décroissant avec son chemin de champ', t => {
  const value = data()
  value.meters[0].offSeason.indexEnd = '50'
  value.meters[0].season.indexEnd = '25'
  value.meters.push({...structuredClone(data().meters[0]), serialNumber: 'MANUAL-2'})
  value.meters[1].season.indexEnd = '199.9999'
  const error = t.throws(() => validateCollectionResponseData(value, {submitted: true}))
  t.is(error.status, 400)
  t.deepEqual(Object.keys(error.data.fields), ['meters.0.offSeason.indexEnd', 'meters.0.season.indexEnd', 'meters.1.season.indexEnd'])
  t.deepEqual(error.data.validationErrors, error.data.fields)
})

test('les index sont comparés sans arrondi flottant et indépendamment entre compteurs', t => {
  const value = data()
  value.meters[0].offSeason.indexStart = '999999999999.9998'
  value.meters[0].offSeason.indexEnd = '999999999999.9999'
  value.meters[0].season.indexEnd = '999999999999.9999'
  value.meters.push({...structuredClone(data().meters[0]), serialNumber: 'MANUAL-2'})
  t.notThrows(() => validateCollectionResponseData(value, {submitted: true}))
  value.meters[0].season.indexEnd = '999999999999.9998'
  t.truthy(t.throws(() => validateCollectionResponseData(value, {submitted: true})).data.fields['meters.0.season.indexEnd'])
})

test('des index nuls et équivalents à quatre décimales sont recevables', t => {
  const value = data()
  value.meters[0].offSeason.indexStart = '0,0000'
  value.meters[0].offSeason.indexEnd = 0
  value.meters[0].season.indexEnd = '0.000'
  t.is(validateCollectionResponseData(value, {submitted: true}).meters[0].season.indexEnd, '0')
})

test('la soumission exige les trois index, le numéro et tous les besoins', t => {
  t.is(validateCollectionResponseData(data(), {submitted: true}).meters[0].offSeason.indexStart, '100')
  for (const mutate of [value => { delete value.meters[0].serialNumber }, value => { delete value.meters[0].season.indexEnd }, value => { delete value.needs.offSeason.volume }, value => { value.meters = [] }]) {
    const value = data()
    mutate(value)
    const error = t.throws(() => validateCollectionResponseData(value, {submitted: true}))
    t.is(error.status, 400)
    t.true(Object.keys(error.data.fields).length > 0)
  }
})

test('les zéros sont recevables sans être assimilés à des champs vides', t => {
  const value = data()
  value.needs.season.volume = 0
  t.is(validateCollectionResponseData(value, {submitted: true}).needs.season.volume, '0')
})

test('validation refuse chiffres négatifs, précision excessive et propriétés non prévues', t => {
  for (const amount of ['-1', '0.00001', '1e8', 'Infinity']) {
    const value = data()
    value.meters[0].season.indexEnd = amount
    t.throws(() => validateCollectionResponseData(value, {submitted: true}))
  }
  t.throws(() => validateCollectionResponseData({...data(), preleveurUserId: owner}))
  t.throws(() => validateCollectionResponseData({meters: [{serialNumber: 'A', autoCalculateVolumes: false}]}))
})

test('les dates calendaires invalides sont refusées et les UUID stables v5 acceptés', t => {
  const input = {name: 'Test', collecteurUserId: collector, exploitationIds: ['10000000-0000-5000-8000-000000000003']}
  t.notThrows(() => validateCampaignInput(input))
  t.throws(() => validateCampaignInput({...input, opensOn: '2026-02-30'}))
  t.throws(() => validateCampaignInput({...input, type: 'OTHER'}))
  t.throws(() => validateCampaignInput({...input, exploitationIds: [exploitationId, exploitationId]}))
})

test('les écritures requièrent une version et la pagination est bornée', t => {
  t.throws(() => validateResponseWrite({data: {}}))
  t.throws(() => validateResponseWrite({revision: -1, data: {}}))
  t.throws(() => validateCampaignQuery({pageSize: 501}))
  t.deepEqual(validateResponseWrite({revision: 0, data: {}}), {revision: 0, data: {}})
})

test('ouverture en jours français inclusifs et fermeture immédiate', t => {
  t.true(isCampaignOpen(campaign, new Date('2026-12-31T22:59:00Z')))
  t.false(isCampaignOpen(campaign, new Date('2026-12-31T23:00:00Z')))
  t.false(isCampaignOpen({...campaign, closedAt: new Date()}, new Date('2026-11-01')))
  t.false(isCampaignOpen({...campaign, status: 'DRAFT'}, new Date('2026-11-01')))
  t.false(isCampaignOpen({...campaign, status: 'ARCHIVED'}, new Date('2026-11-01')))
  t.false(isCampaignOpen({...campaign, closesOn: null}, new Date('2026-11-01')))
})

test('avant le dernier relevé on peut rédiger mais pas envoyer', t => {
  const now = new Date('2026-09-24T12:00:00Z')
  t.notThrows(() => assertCampaignResponseWritable(context(), farmer, {now}))
  t.is(t.throws(() => assertCampaignResponseWritable(context(), farmer, {now, submitting: true})).status, 409)
  t.notThrows(() => assertCampaignResponseWritable(context(), farmer, {now: new Date('2026-10-31T12:00:00Z'), submitting: true}))
})

test('la réponse appartient au préleveur, pas au collecteur ni à un administrateur', t => {
  for (const user of [{id: collector, role: 'DECLARANT'}, {id: owner, role: 'ADMIN'}, {id: collector, role: 'INSTRUCTOR'}]) {
    t.is(t.throws(() => assertCampaignResponseWritable(context(), user)).status, 403)
  }
})

test('la campagne ne contourne pas une désactivation de saisie ni un point externe', t => {
  const now = new Date('2026-11-01')
  const disabled = context()
  disabled.exploitation.declarant.quickDeclarationEnabled = false
  t.is(t.throws(() => assertCampaignResponseWritable(disabled, farmer, {now})).status, 403)
  const external = context()
  external.exploitation.pointPrelevement.collectionMode = 'EXTERNAL'
  t.is(t.throws(() => assertCampaignResponseWritable(external, farmer, {now})).status, 403)
  const inactive = context()
  inactive.exploitation.status = 'ABANDONNEE'
  t.is(t.throws(() => assertCampaignResponseWritable(inactive, farmer, {now})).status, 409)
})

test('le collecteur consulte la dernière soumission sans accéder aux brouillons', t => {
  const response = {id: 'r', preleveurUserId: owner, firstSubmittedAt: new Date(), draftData: {comment: 'Privé'}, submittedData: {comment: 'Soumis'}, exploitation: {pointPrelevement: {id: 'point', name: 'Point', internalComment: 'Note interne'}}}
  const visible = serializeCampaignResponse(response, {id: collector, role: 'DECLARANT'}, {includeData: true})
  t.is(visible.draftData, null)
  t.deepEqual(visible.submittedData, {comment: 'Soumis'})
  t.true(visible.hasDraft)
  t.is(visible.status, 'SUBMITTED')
  t.deepEqual(serializeCampaignResponse(response, farmer, {includeData: true}).draftData, {comment: 'Privé'})
  t.false(Object.hasOwn(visible.point, 'internalComment'))
})

test('une version soumise identique au brouillon ne signale pas de modification en attente', t => {
  const response = {preleveurUserId: owner, firstSubmittedAt: new Date(), draftData: {comment: 'Envoyé'}, submittedData: {comment: 'Envoyé'}}
  t.false(serializeCampaignResponse(response, farmer).hasDraft)
})

test('les réponses requièrent une session déclarant et la gestion reste interdite en impersonation', t => {
  const routes = readFileSync(new URL('../../routes.js', import.meta.url), 'utf8')
  t.true(routes.includes("app.use('/campaigns', ensureHumanSession, ensureRole('ADMIN', 'DECLARANT'))"))
  for (const handler of ['createCollectionCampaignHandler', 'updateCollectionCampaignHandler', 'approveCollectionMeterHandler']) {
    t.regex(routes, new RegExp(`ensureNotImpersonating, ${handler}\\)`))
  }
  for (const handler of ['saveCollectionResponseDraftHandler', 'submitCollectionResponseHandler']) {
    t.true(routes.includes(`ensureRole('DECLARANT'), ${handler})`))
    t.false(routes.includes(`ensureNotImpersonating, ${handler}`))
  }
  for (const action of ['open', 'close', 'archive', 'delete']) {
    t.true(routes.includes(`ensureRole('ADMIN'), ensureNotImpersonating, transitionCollectionCampaignHandler('${action}')`))
  }
  t.regex(routes, /meters\/:compteurId\/review', ensureRole\('ADMIN'\), getCollectionMeterReviewHandler/)
})

test('les filtres collecteur portent sur la délégation de chaque exploitation', t => {
  t.deepEqual(campaignResponseAccessWhere({id: collector, role: 'DECLARANT'}, campaign), {exploitation: {collecteurs: {some: {collecteurUserId: collector}}}})
  t.deepEqual(campaignResponseAccessWhere(farmer, campaign), {preleveurUserId: owner, exploitation: {declarantUserId: owner}})
  t.deepEqual(campaignResponseAccessWhere({role: 'ADMIN'}, campaign), {})
})

test('une campagne lancée ou comportant un brouillon ne propose pas la suppression', t => {
  const admin = {role: 'ADMIN'}
  t.false(getCampaignPermissions(admin, campaign).canDelete)
  t.false(getCampaignPermissions(admin, {...campaign, status: 'DRAFT'}, {drafts: 1}).canDelete)
  t.true(getCampaignPermissions(admin, {...campaign, status: 'DRAFT'}, {submitted: 0, drafts: 0}).canDelete)
})

test('le seed peut créer dans sa transaction sans en ouvrir une seconde', async t => {
  let created
  const client = {
    declarant: {findFirst: async () => ({userId: collector})},
    declarantPointPrelevement: {findMany: async args => { t.deepEqual(args.where.pointPrelevement.OR, [{collectionMode: null}, {collectionMode: 'MANUAL'}]); return [{id: exploitationId, declarantUserId: owner}] }},
    collectionCampaign: {create: async args => { created = args.data; return {id: 'c', ...args.data} }}
  }
  await createCollectionCampaign({name: 'Test', collecteurUserId: collector, exploitationIds: [exploitationId]}, {user: {role: 'ADMIN', id: 'admin'}, client})
  t.is(created.status, 'DRAFT')
  t.is(created.opensOn, null)
  t.deepEqual(created.responses.create, [{exploitationId, preleveurUserId: owner}])
})

test('une population hors délégation bloque entièrement la création', async t => {
  const client = {declarant: {findFirst: async () => ({})}, declarantPointPrelevement: {findMany: async () => []}, collectionCampaign: {create: async () => t.fail('No write permitted')}}
  t.is((await t.throwsAsync(createCollectionCampaign({name: 'Test', collecteurUserId: collector, exploitationIds: [exploitationId]}, {user: {role: 'ADMIN'}, client}))).status, 400)
})

test('préremplissage exclusivement à la date exacte et au compteur exact, sans arbitrer les contradictions', t => {
  const meters = [{compteurId: 'A', serialNumber: 'A'}, {compteurId: 'B', serialNumber: 'B'}]
  const value = (compteurId, date, index) => ({periodStart: new Date(date), value: index, chunk: {compteurId, usageId}})
  const initial = buildInitialCampaignData(meters, [value('A', '2025-10-31Z', '10'), value('A', '2026-06-01Z', '20'),
    value('B', '2026-06-01Z', '80'), value('B', '2026-06-01Z', '81'), value('A', '2026-10-30Z', '200'), value('A', '2026-10-31T12:00:00Z', '300')], [{id: usageId}])
  t.deepEqual(initial.meters[0].offSeason, {indexStart: '10', indexEnd: '20', usageId})
  t.deepEqual(initial.meters[0].season, {})
  t.deepEqual(initial.meters[1].offSeason, {})
  t.deepEqual(initial.needs, {offSeason: {}, season: {}})
})

test('les propositions complètent les données connues sans masquer un index nul ni un conflit observé', t => {
  const meterId = '10000000-0000-4000-8000-000000000005'
  const staleMeterId = '10000000-0000-4000-8000-000000000006'
  const proposal = {meters: [
    {compteurId: meterId, serialNumber: 'Ancien libellé', offSeason: {indexStart: '42', indexEnd: '43'}, season: {indexEnd: '50'}},
    {compteurId: staleMeterId, serialNumber: 'Compteur retiré', offSeason: {indexStart: '999'}}
  ], needs: {offSeason: {usageId, volume: '75000'}, season: {usageId: staleMeterId, volume: '0'}}}
  const source = structuredClone(proposal)
  const reading = (date, value) => ({periodStart: new Date(date), value, chunk: {compteurId: meterId, usageId}})
  const initial = buildInitialCampaignData([{compteurId: meterId, serialNumber: 'Actuel'}], [
    reading('2025-10-31Z', '0'), reading('2026-06-01Z', '30'), reading('2026-06-01Z', '31')
  ], [{id: usageId}], proposal)
  t.is(initial.meters.length, 1)
  t.is(initial.meters[0].serialNumber, 'Actuel')
  t.deepEqual(initial.meters[0].offSeason, {indexStart: '0', usageId})
  t.deepEqual(initial.meters[0].season, {indexEnd: '50'})
  t.deepEqual(initial.needs, {offSeason: {usageId, volume: '75000'}, season: {volume: '0'}})
  t.deepEqual(proposal, source)
})

test('deux propositions pour le même compteur ne sont pas arbitrées automatiquement', t => {
  const compteurId = '10000000-0000-4000-8000-000000000005'
  const initial = buildInitialCampaignData([{compteurId}], [], [], {meters: [
    {compteurId, offSeason: {indexStart: '5'}}, {compteurId, offSeason: {indexStart: '8'}}
  ]})
  t.deepEqual(initial.meters[0].offSeason, {})
})

test('aucun sérialiseur ne divulgue les propositions brutes ni leur provenance privée', t => {
  const response = {preleveurUserId: owner, draftData: null, submittedData: null,
    prefillData: {needs: {season: {volume: '12345'}}}, prefillMetadata: {rows: [2], sourceSha256: 'private-hash', privateNotes: 'Confidentiel'}}
  for (const user of [farmer, {id: collector, role: 'DECLARANT'}, {role: 'ADMIN'}]) {
    for (const includeData of [true, false]) {
      const serialized = serializeCampaignResponse(response, user, {includeData})
      t.false(Object.hasOwn(serialized, 'prefillData'))
      t.false(Object.hasOwn(serialized, 'prefillMetadata'))
      t.is(serialized.status, 'NOT_STARTED')
      t.false(serialized.hasDraft)
    }
  }
})

function prefilledContextFixture(overrides = {}) {
  const response = {id: 'response', preleveurUserId: owner, revision: 0, firstSubmittedAt: null, draftData: null, submittedData: null,
    prefillData: {needs: {season: {volume: '12345'}}}, prefillMetadata: {version: 1, sourceSha256: 'private-hash', rows: [2], noAuthorizedOffSeasonUsage: true},
    exploitation: {id: exploitationId, declarantUserId: owner, declarant: {user: {}}, pointPrelevement: {}}, ...overrides}
  const client = {
    collectionCampaign: {findFirst: async () => campaign}, collectionResponse: {findFirst: async () => response},
    meterAllocation: {findMany: async () => []}, sandreWaterUse: {findMany: async () => []},
    chunkValue: {findMany: async () => []}, $queryRaw: async () => []
  }
  return {response, client}
}

test('le contexte privé utilise les propositions seulement avant la première saisie', async t => {
  const fixture = prefilledContextFixture()
  await Promise.all([farmer, {role: 'ADMIN'}].map(async user => {
    const result = await getAuthorizedCampaignResponseContext(user, campaign.id, 'response', fixture)
    t.is(result.data.needs.season.volume, '12345')
    t.deepEqual(result.prefill, {active: true, noAuthorizedOffSeasonUsage: true})
    t.false(JSON.stringify(result).includes('private-hash'))
  }))
  await Promise.all([{draftData: {needs: {season: {volume: '12'}}}}, {submittedData: {needs: {season: {volume: '12'}}}, firstSubmittedAt: new Date()}].map(async overrides => {
    const result = await getAuthorizedCampaignResponseContext(farmer, campaign.id, 'response', prefilledContextFixture(overrides))
    t.deepEqual(result.data, {needs: {season: {volume: '12'}}})
    t.deepEqual(result.prefill, {active: false, noAuthorizedOffSeasonUsage: true})
  }))
})

test('le collecteur ne reçoit ni propositions ni information d’autorisation hors étiage', async t => {
  const result = await getAuthorizedCampaignResponseContext({id: collector, role: 'DECLARANT'}, campaign.id, 'response', prefilledContextFixture())
  t.deepEqual(result.data.needs, {offSeason: {}, season: {}})
  t.is(result.prefill, null)
  t.false(JSON.stringify(result).includes('12345'))
  t.false(JSON.stringify(result).includes('private-hash'))
})

test('une information seule ou une proposition de compteur retiré n’affiche pas de préremplissage actif', async t => {
  await Promise.all([{}, {needs: {season: {}, offSeason: {}}}, {meters: [
    {compteurId: '10000000-0000-4000-8000-000000000005', offSeason: {indexStart: '100'}}
  ]}].map(async prefillData => {
    const result = await getAuthorizedCampaignResponseContext(farmer, campaign.id, 'response', prefilledContextFixture({prefillData}))
    t.deepEqual(result.prefill, {active: false, noAuthorizedOffSeasonUsage: true})
    t.deepEqual(result.data.needs, {offSeason: {}, season: {}})
    t.deepEqual(result.data.meters, [])
  }))
})

test('les traces d’une réponse déjà travaillée désactivent les propositions même sans brouillon restant', async t => {
  await Promise.all([{revision: 1}, {firstSubmittedAt: new Date()}, {lastSubmittedAt: new Date()}, {submittedHash: 'past-submission'}, {declarationId: 'past-declaration'}].map(async overrides => {
    const result = await getAuthorizedCampaignResponseContext(farmer, campaign.id, 'response', prefilledContextFixture(overrides))
    t.false(result.prefill.active)
    t.deepEqual(result.data.needs, {offSeason: {}, season: {}})
  }))
})

test('un conflit SERIALIZABLE demande de recharger, sans rejouer aveuglément une mutation', async t => {
  let attempts = 0
  const client = {$transaction: async () => { attempts++; throw Object.assign(new Error('Conflict'), {code: 'P2034'}) }}
  t.is((await t.throwsAsync(runCollectionTransaction(client, () => {}))).status, 409)
  t.is(attempts, 1)
})

test('résultats additionnent seulement les volumes de la réponse et distinguent zéro et absence', async t => {
  const responses = [
    {id: 'A', campaignId: 'C', exploitationId: 'EA', declarationId: 'DA', firstSubmittedAt: new Date(), publicationStatus: 'PUBLISHED'},
    {id: 'B', campaignId: 'C', exploitationId: 'EB', declarationId: 'DB', firstSubmittedAt: new Date(), publicationStatus: 'PENDING_REVIEW'},
    {id: 'C', campaignId: 'C', exploitationId: 'EC', firstSubmittedAt: null, publicationStatus: 'NOT_SUBMITTED'}
  ]
  const contribution = (responseId, exploitationId, volume) => ({volume,
    publication: {periodEnd: meterBusinessDateBoundary('2026-10-31'), stream: {scope: 'C'}},
    allocationVersion: {metadata: {collectionResponseId: responseId}, allocation: {exploitationId}}, chunkValue: {chunk: {exploitationId}}})
  const client = {
    chunkValue: {findMany: async query => {
      t.true(query.where.chunk.autoCalculateVolumes)
      return [{value: '0', periodEnd: new Date('2026-06-01T00:15:00Z'), chunk: {exploitationId: 'EA', source: {declarationId: 'DA'}}}]
    }},
    meterVolumeContribution: {findMany: async query => {
      t.true(query.where.publication.active)
      return [contribution('A', 'EA', '40'), contribution('B', 'EB', '20'), contribution('OTHER', 'EA', '900'), contribution('A', 'OTHER', '900')]
    }}
  }
  const results = await getCampaignResponseVolumes(responses, {client})
  t.deepEqual(results.get('A'), {offSeason: 0, season: 40, total: 40, partial: false, publicationStatus: 'PUBLISHED'})
  t.deepEqual(results.get('B'), {offSeason: null, season: 20, total: 20, partial: true, publicationStatus: 'PENDING_REVIEW'})
  t.deepEqual(results.get('C'), {offSeason: null, season: null, total: null, partial: true, publicationStatus: 'NOT_SUBMITTED'})
})
