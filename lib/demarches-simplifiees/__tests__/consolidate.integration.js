import test from 'ava'
import {ObjectId} from 'mongodb'
import mongo from '../../util/mongo.js'
import {setupTestMongo} from '../../util/test-helpers/mongo.js'
import {consolidateDossier} from '../consolidate.js'
import {createLogger} from '../../util/logger.js'

setupTestMongo(test)

// Logger silencieux pour les tests
const silentLogger = createLogger({log() {}, error() {}})

test.beforeEach(async () => {
  await mongo.db.collection('dossiers').deleteMany({})
  await mongo.db.collection('dossier_attachments').deleteMany({})
  await mongo.db.collection('series').deleteMany({})
  await mongo.db.collection('series_values').deleteMany({})
  await mongo.db.collection('integrations_journalieres').deleteMany({})
  await mongo.db.collection('preleveurs').deleteMany({})
  await mongo.db.collection('points_prelevement').deleteMany({})
})

/**
 * IDEMPOTENCE : vérifier que 2 consolidations successives produisent le même état
 */
test.serial('idempotence: 2 consolidations successives donnent le même résultat', async t => {
  // Données de base
  const pointId = new ObjectId()
  const preleveurId = new ObjectId()
  const dossierId = new ObjectId()
  const attachmentId = new ObjectId()

  await mongo.db.collection('points_prelevement').insertOne({
    _id: pointId,
    territoire: 'GUADELOUPE',
    id_point: 123
  })

  await mongo.db.collection('preleveurs').insertOne({
    _id: preleveurId,
    email: 'test@example.com'
  })

  await mongo.db.collection('dossiers').insertOne({
    _id: dossierId,
    numero: 12_345,
    status: 'accepte',
    territoire: 'GUADELOUPE',
    usager: {email: 'test@example.com'},
    declarant: {email: 'test@example.com'}
  })

  await mongo.db.collection('dossier_attachments').insertOne({
    _id: attachmentId,
    dossierId,
    filename: 'test.xlsx',
    processed: true,
    validationStatus: 'success'
  })

  const volumeSerieId = new ObjectId()
  await mongo.db.collection('series').insertOne({
    _id: volumeSerieId,
    dossierId,
    attachmentId,
    pointPrelevement: 123,
    parameter: 'volume prélevé',
    frequency: '1 day',
    minDate: '2025-01-01',
    maxDate: '2025-01-03'
  })

  await mongo.db.collection('series_values').insertMany([
    {seriesId: volumeSerieId, date: '2025-01-01', value: 100},
    {seriesId: volumeSerieId, date: '2025-01-02', value: 200},
    {seriesId: volumeSerieId, date: '2025-01-03', value: 300}
  ])

  // Première consolidation
  await consolidateDossier(dossierId, silentLogger)

  const dossier1 = await mongo.db.collection('dossiers').findOne({_id: dossierId})
  const series1 = await mongo.db.collection('series').find({dossierId}).toArray()
  const integrations1 = await mongo.db.collection('integrations_journalieres').find({dossierId}).toArray()

  t.truthy(dossier1.consolidatedAt)
  t.is(integrations1.length, 3)
  t.is(series1[0].computed.integratedDays.length, 3)

  // Réinitialiser consolidatedAt pour permettre une 2e consolidation
  await mongo.db.collection('dossiers').updateOne({_id: dossierId}, {$unset: {consolidatedAt: 1}})

  // Deuxième consolidation
  await consolidateDossier(dossierId, silentLogger)

  const series2 = await mongo.db.collection('series').find({dossierId}).toArray()
  const integrations2 = await mongo.db.collection('integrations_journalieres').find({dossierId}).toArray()

  // Vérifier que l'état est identique
  t.is(integrations2.length, integrations1.length)
  t.is(series2[0].computed.integratedDays.length, series1[0].computed.integratedDays.length)
  t.deepEqual(
    series2[0].computed.integratedDays.sort(),
    series1[0].computed.integratedDays.sort()
  )
})

/**
 * CAS 1 : Attachment sans série volume => suppression des intégrations orphelines
 */
test.serial('orphelins: supprime les intégrations quand la série volume disparaît', async t => {
  const pointId = new ObjectId()
  const preleveurId = new ObjectId()
  const dossierId = new ObjectId()
  const attachmentId = new ObjectId()

  await mongo.db.collection('points_prelevement').insertOne({
    _id: pointId,
    territoire: 'GUADELOUPE',
    id_point: 123
  })

  await mongo.db.collection('preleveurs').insertOne({
    _id: preleveurId,
    email: 'test@example.com'
  })

  await mongo.db.collection('dossiers').insertOne({
    _id: dossierId,
    numero: 12_345,
    status: 'accepte',
    territoire: 'GUADELOUPE',
    usager: {email: 'test@example.com'},
    declarant: {email: 'test@example.com'}
  })

  await mongo.db.collection('dossier_attachments').insertOne({
    _id: attachmentId,
    dossierId,
    filename: 'test.xlsx',
    processed: true,
    validationStatus: 'error' // Fichier en erreur, pas de série volume
  })

  // Série sans volume (ex: température)
  const tempSerieId = new ObjectId()
  await mongo.db.collection('series').insertOne({
    _id: tempSerieId,
    dossierId,
    attachmentId,
    pointPrelevement: 123,
    parameter: 'température',
    frequency: '1 day',
    minDate: '2025-01-01',
    maxDate: '2025-01-03'
  })

  // Intégrations orphelines (restes d'une ancienne version du fichier)
  await mongo.db.collection('integrations_journalieres').insertMany([
    {preleveurId, pointId, date: '2025-01-01', dossierId, attachmentId},
    {preleveurId, pointId, date: '2025-01-02', dossierId, attachmentId},
    {preleveurId, pointId, date: '2025-01-03', dossierId, attachmentId}
  ])

  // Consolidation
  await consolidateDossier(dossierId, silentLogger)

  // Vérifications
  const integrations = await mongo.db.collection('integrations_journalieres').find({attachmentId}).toArray()
  const series = await mongo.db.collection('series').findOne({_id: tempSerieId})

  t.is(integrations.length, 0, 'Les intégrations orphelines doivent être supprimées')
  t.deepEqual(series.computed.integratedDays, [], 'computed.integratedDays doit être vide')
})

/**
 * CAS 2 : Dossier non accepté => suppression de toutes les intégrations
 */
test.serial('orphelins: supprime les intégrations quand le dossier passe à non-accepté', async t => {
  const pointId = new ObjectId()
  const preleveurId = new ObjectId()
  const dossierId = new ObjectId()
  const attachmentId = new ObjectId()

  await mongo.db.collection('points_prelevement').insertOne({
    _id: pointId,
    territoire: 'GUADELOUPE',
    id_point: 123
  })

  await mongo.db.collection('preleveurs').insertOne({
    _id: preleveurId,
    email: 'test@example.com'
  })

  await mongo.db.collection('dossiers').insertOne({
    _id: dossierId,
    numero: 12_345,
    status: 'refuse', // Statut non-accepté
    territoire: 'GUADELOUPE',
    usager: {email: 'test@example.com'},
    declarant: {email: 'test@example.com'}
  })

  await mongo.db.collection('dossier_attachments').insertOne({
    _id: attachmentId,
    dossierId,
    filename: 'test.xlsx',
    processed: true,
    validationStatus: 'success'
  })

  const volumeSerieId = new ObjectId()
  await mongo.db.collection('series').insertOne({
    _id: volumeSerieId,
    dossierId,
    attachmentId,
    pointPrelevement: 123,
    parameter: 'volume prélevé',
    frequency: '1 day',
    minDate: '2025-01-01',
    maxDate: '2025-01-03'
  })

  await mongo.db.collection('series_values').insertMany([
    {seriesId: volumeSerieId, date: '2025-01-01', value: 100},
    {seriesId: volumeSerieId, date: '2025-01-02', value: 200},
    {seriesId: volumeSerieId, date: '2025-01-03', value: 300}
  ])

  // Intégrations existantes (d'avant que le dossier soit refusé)
  await mongo.db.collection('integrations_journalieres').insertMany([
    {preleveurId, pointId, date: '2025-01-01', dossierId, attachmentId},
    {preleveurId, pointId, date: '2025-01-02', dossierId, attachmentId}
  ])

  // Consolidation
  await consolidateDossier(dossierId, silentLogger)

  // Vérifications
  const integrations = await mongo.db.collection('integrations_journalieres').find({attachmentId}).toArray()
  const series = await mongo.db.collection('series').findOne({_id: volumeSerieId})

  t.is(integrations.length, 0, 'Toutes les intégrations doivent être supprimées')
  t.deepEqual(series.computed.integratedDays, [], 'computed.integratedDays doit être vide')
})

/**
 * CAS 3 : Pas de préleveur => aucune intégration
 */
test.serial('orphelins: supprime les intégrations quand le préleveur est introuvable', async t => {
  const pointId = new ObjectId()
  const dossierId = new ObjectId()
  const attachmentId = new ObjectId()

  await mongo.db.collection('points_prelevement').insertOne({
    _id: pointId,
    territoire: 'GUADELOUPE',
    id_point: 123
  })

  // PAS de préleveur créé

  await mongo.db.collection('dossiers').insertOne({
    _id: dossierId,
    numero: 12_345,
    status: 'accepte',
    territoire: 'GUADELOUPE',
    usager: {email: 'inconnu@example.com'},
    declarant: {email: 'inconnu@example.com'}
  })

  await mongo.db.collection('dossier_attachments').insertOne({
    _id: attachmentId,
    dossierId,
    filename: 'test.xlsx',
    processed: true,
    validationStatus: 'success'
  })

  const volumeSerieId = new ObjectId()
  await mongo.db.collection('series').insertOne({
    _id: volumeSerieId,
    dossierId,
    attachmentId,
    pointPrelevement: 123,
    parameter: 'volume prélevé',
    frequency: '1 day',
    minDate: '2025-01-01',
    maxDate: '2025-01-03'
  })

  await mongo.db.collection('series_values').insertMany([
    {seriesId: volumeSerieId, date: '2025-01-01', value: 100},
    {seriesId: volumeSerieId, date: '2025-01-02', value: 200}
  ])

  // Consolidation
  await consolidateDossier(dossierId, silentLogger)

  // Vérifications
  const integrations = await mongo.db.collection('integrations_journalieres').find({attachmentId}).toArray()
  const series = await mongo.db.collection('series').findOne({_id: volumeSerieId})

  t.is(integrations.length, 0, 'Aucune intégration sans préleveur')
  t.deepEqual(series.computed.integratedDays, [], 'computed.integratedDays doit être vide')
})

/**
 * CAS 4 : Intégrations correctes et computed.integratedDays synchronisé
 */
test.serial('intégrité: computed.integratedDays contient tous les jours intégrés', async t => {
  const pointId = new ObjectId()
  const preleveurId = new ObjectId()
  const dossierId = new ObjectId()
  const attachmentId = new ObjectId()

  await mongo.db.collection('points_prelevement').insertOne({
    _id: pointId,
    territoire: 'GUADELOUPE',
    id_point: 123
  })

  await mongo.db.collection('preleveurs').insertOne({
    _id: preleveurId,
    email: 'test@example.com'
  })

  await mongo.db.collection('dossiers').insertOne({
    _id: dossierId,
    numero: 12_345,
    status: 'accepte',
    territoire: 'GUADELOUPE',
    usager: {email: 'test@example.com'},
    declarant: {email: 'test@example.com'}
  })

  await mongo.db.collection('dossier_attachments').insertOne({
    _id: attachmentId,
    dossierId,
    filename: 'test.xlsx',
    processed: true,
    validationStatus: 'success'
  })

  const volumeSerieId = new ObjectId()
  await mongo.db.collection('series').insertOne({
    _id: volumeSerieId,
    dossierId,
    attachmentId,
    pointPrelevement: 123,
    parameter: 'volume prélevé',
    frequency: '1 day',
    minDate: '2025-01-01',
    maxDate: '2025-01-05'
  })

  await mongo.db.collection('series_values').insertMany([
    {seriesId: volumeSerieId, date: '2025-01-01', value: 100},
    {seriesId: volumeSerieId, date: '2025-01-02', value: 200},
    {seriesId: volumeSerieId, date: '2025-01-03', value: 300},
    {seriesId: volumeSerieId, date: '2025-01-04', value: 400},
    {seriesId: volumeSerieId, date: '2025-01-05', value: 500}
  ])

  // Consolidation
  await consolidateDossier(dossierId, silentLogger)

  // Vérifications
  const integrations = await mongo.db.collection('integrations_journalieres')
    .find({attachmentId})
    .toArray()
  const series = await mongo.db.collection('series').findOne({_id: volumeSerieId})

  t.is(integrations.length, 5, '5 jours doivent être intégrés')
  t.is(series.computed.integratedDays.length, 5, 'computed.integratedDays doit avoir 5 jours')

  const integratedDates = integrations.map(i => i.date).sort()
  const computedDates = series.computed.integratedDays.sort()

  t.deepEqual(computedDates, integratedDates, 'Les dates doivent correspondre exactement')
  t.deepEqual(computedDates, [
    '2025-01-01',
    '2025-01-02',
    '2025-01-03',
    '2025-01-04',
    '2025-01-05'
  ])
})

/**
 * CAS 5 : Plusieurs séries sur le même attachment => toutes ont integratedDays
 */
test.serial('intégrité: toutes les séries du même attachment ont computed.integratedDays', async t => {
  const pointId = new ObjectId()
  const preleveurId = new ObjectId()
  const dossierId = new ObjectId()
  const attachmentId = new ObjectId()

  await mongo.db.collection('points_prelevement').insertOne({
    _id: pointId,
    territoire: 'GUADELOUPE',
    id_point: 123
  })

  await mongo.db.collection('preleveurs').insertOne({
    _id: preleveurId,
    email: 'test@example.com'
  })

  await mongo.db.collection('dossiers').insertOne({
    _id: dossierId,
    numero: 12_345,
    status: 'accepte',
    territoire: 'GUADELOUPE',
    usager: {email: 'test@example.com'},
    declarant: {email: 'test@example.com'}
  })

  await mongo.db.collection('dossier_attachments').insertOne({
    _id: attachmentId,
    dossierId,
    filename: 'test.xlsx',
    processed: true,
    validationStatus: 'success'
  })

  // Série volume
  const volumeSerieId = new ObjectId()
  await mongo.db.collection('series').insertOne({
    _id: volumeSerieId,
    dossierId,
    attachmentId,
    pointPrelevement: 123,
    parameter: 'volume prélevé',
    frequency: '1 day',
    minDate: '2025-01-01',
    maxDate: '2025-01-03'
  })

  // Série température (même plage de dates)
  const tempSerieId = new ObjectId()
  await mongo.db.collection('series').insertOne({
    _id: tempSerieId,
    dossierId,
    attachmentId,
    pointPrelevement: 123,
    parameter: 'température',
    frequency: '1 day',
    minDate: '2025-01-01',
    maxDate: '2025-01-03'
  })

  await mongo.db.collection('series_values').insertMany([
    {seriesId: volumeSerieId, date: '2025-01-01', value: 100},
    {seriesId: volumeSerieId, date: '2025-01-02', value: 200},
    {seriesId: volumeSerieId, date: '2025-01-03', value: 300},
    {seriesId: tempSerieId, date: '2025-01-01', value: 20},
    {seriesId: tempSerieId, date: '2025-01-02', value: 21},
    {seriesId: tempSerieId, date: '2025-01-03', value: 22}
  ])

  // Consolidation
  await consolidateDossier(dossierId, silentLogger)

  // Vérifications
  const volumeSerie = await mongo.db.collection('series').findOne({_id: volumeSerieId})
  const tempSerie = await mongo.db.collection('series').findOne({_id: tempSerieId})

  t.truthy(volumeSerie.computed.integratedDays, 'Volume série doit avoir integratedDays')
  t.truthy(tempSerie.computed.integratedDays, 'Température série doit avoir integratedDays')

  t.is(volumeSerie.computed.integratedDays.length, 3)
  t.is(tempSerie.computed.integratedDays.length, 3)

  t.deepEqual(
    volumeSerie.computed.integratedDays.sort(),
    tempSerie.computed.integratedDays.sort(),
    'Les deux séries doivent avoir les mêmes jours intégrés'
  )
})

/**
 * CAS MARGE 1 : Série avec dates en dehors de minDate/maxDate (ne doivent pas être dans integratedDays)
 */
test.serial('marges: les jours hors plage min/max ne sont pas dans computed.integratedDays', async t => {
  const pointId = new ObjectId()
  const preleveurId = new ObjectId()
  const dossierId = new ObjectId()
  const attachmentId = new ObjectId()

  await mongo.db.collection('points_prelevement').insertOne({
    _id: pointId,
    territoire: 'GUADELOUPE',
    id_point: 123
  })

  await mongo.db.collection('preleveurs').insertOne({
    _id: preleveurId,
    email: 'test@example.com'
  })

  await mongo.db.collection('dossiers').insertOne({
    _id: dossierId,
    numero: 12_345,
    status: 'accepte',
    territoire: 'GUADELOUPE',
    usager: {email: 'test@example.com'},
    declarant: {email: 'test@example.com'}
  })

  await mongo.db.collection('dossier_attachments').insertOne({
    _id: attachmentId,
    dossierId,
    filename: 'test.xlsx',
    processed: true,
    validationStatus: 'success'
  })

  const volumeSerieId = new ObjectId()
  await mongo.db.collection('series').insertOne({
    _id: volumeSerieId,
    dossierId,
    attachmentId,
    pointPrelevement: 123,
    parameter: 'volume prélevé',
    frequency: '1 day',
    minDate: '2025-01-02', // Plage restreinte : seulement 02 et 03
    maxDate: '2025-01-03'
  })

  // Valeurs de 01 à 04 (mais série limitée à 02-03)
  await mongo.db.collection('series_values').insertMany([
    {seriesId: volumeSerieId, date: '2025-01-01', value: 100}, // Hors plage
    {seriesId: volumeSerieId, date: '2025-01-02', value: 200}, // Dans plage
    {seriesId: volumeSerieId, date: '2025-01-03', value: 300}, // Dans plage
    {seriesId: volumeSerieId, date: '2025-01-04', value: 400} // Hors plage
  ])

  // Consolidation
  await consolidateDossier(dossierId, silentLogger)

  // Vérifications
  const integrations = await mongo.db.collection('integrations_journalieres').find({attachmentId}).toArray()
  const series = await mongo.db.collection('series').findOne({_id: volumeSerieId})

  // Les intégrations doivent contenir toutes les dates (pas de filtrage ici)
  t.is(integrations.length, 4, '4 intégrations créées')

  // Mais computed.integratedDays ne doit contenir QUE les dates dans la plage min/max
  t.is(series.computed.integratedDays.length, 2, 'Seulement 2 jours dans computed.integratedDays')
  t.deepEqual(series.computed.integratedDays.sort(), ['2025-01-02', '2025-01-03'])
})

/**
 * CAS MARGE 2 : Conflit entre attachments (premier arrivé, premier servi)
 */
test.serial('marges: conflit entre 2 attachments sur même jour/point/préleveur', async t => {
  const pointId = new ObjectId()
  const preleveurId = new ObjectId()
  const dossierId1 = new ObjectId()
  const dossierId2 = new ObjectId()
  const attachment1Id = new ObjectId()
  const attachment2Id = new ObjectId()

  await mongo.db.collection('points_prelevement').insertOne({
    _id: pointId,
    territoire: 'GUADELOUPE',
    id_point: 123
  })

  await mongo.db.collection('preleveurs').insertOne({
    _id: preleveurId,
    email: 'test@example.com'
  })

  // Dossier 1
  await mongo.db.collection('dossiers').insertOne({
    _id: dossierId1,
    numero: 11_111,
    status: 'accepte',
    territoire: 'GUADELOUPE',
    usager: {email: 'test@example.com'},
    declarant: {email: 'test@example.com'},
    ds: {demarcheNumber: 111, dossierNumber: 11_111}
  })

  await mongo.db.collection('dossier_attachments').insertOne({
    _id: attachment1Id,
    dossierId: dossierId1,
    filename: 'test1.xlsx',
    processed: true,
    validationStatus: 'success'
  })

  const volumeSerie1Id = new ObjectId()
  await mongo.db.collection('series').insertOne({
    _id: volumeSerie1Id,
    dossierId: dossierId1,
    attachmentId: attachment1Id,
    pointPrelevement: 123,
    parameter: 'volume prélevé',
    frequency: '1 day',
    minDate: '2025-01-01',
    maxDate: '2025-01-02'
  })

  await mongo.db.collection('series_values').insertMany([
    {seriesId: volumeSerie1Id, date: '2025-01-01', value: 100},
    {seriesId: volumeSerie1Id, date: '2025-01-02', value: 200}
  ])

  // Dossier 2 (même préleveur, même point, mêmes dates)
  await mongo.db.collection('dossiers').insertOne({
    _id: dossierId2,
    numero: 22_222,
    status: 'accepte',
    territoire: 'GUADELOUPE',
    usager: {email: 'test@example.com'},
    declarant: {email: 'test@example.com'},
    ds: {demarcheNumber: 222, dossierNumber: 22_222}
  })

  await mongo.db.collection('dossier_attachments').insertOne({
    _id: attachment2Id,
    dossierId: dossierId2,
    filename: 'test2.xlsx',
    processed: true,
    validationStatus: 'success'
  })

  const volumeSerie2Id = new ObjectId()
  await mongo.db.collection('series').insertOne({
    _id: volumeSerie2Id,
    dossierId: dossierId2,
    attachmentId: attachment2Id,
    pointPrelevement: 123,
    parameter: 'volume prélevé',
    frequency: '1 day',
    minDate: '2025-01-01',
    maxDate: '2025-01-02'
  })

  await mongo.db.collection('series_values').insertMany([
    {seriesId: volumeSerie2Id, date: '2025-01-01', value: 150},
    {seriesId: volumeSerie2Id, date: '2025-01-02', value: 250}
  ])

  // Consolidation du dossier 1 (premier arrivé)
  await consolidateDossier(dossierId1, silentLogger)

  // Consolidation du dossier 2 (conflit)
  await consolidateDossier(dossierId2, silentLogger)

  // Vérifications
  const integrations1 = await mongo.db.collection('integrations_journalieres').find({attachmentId: attachment1Id}).toArray()
  const integrations2 = await mongo.db.collection('integrations_journalieres').find({attachmentId: attachment2Id}).toArray()
  const series1 = await mongo.db.collection('series').findOne({_id: volumeSerie1Id})
  const series2 = await mongo.db.collection('series').findOne({_id: volumeSerie2Id})

  // Dossier 1 doit avoir ses 2 intégrations
  t.is(integrations1.length, 2, 'Dossier 1 a ses 2 intégrations')
  t.is(series1.computed.integratedDays.length, 2)

  // Dossier 2 ne doit avoir AUCUNE intégration (conflit sur tout)
  t.is(integrations2.length, 0, 'Dossier 2 n\'a aucune intégration (conflit)')
  t.is(series2.computed.integratedDays.length, 0, 'computed.integratedDays vide pour dossier 2')
})

/**
 * CAS MARGE 3 : Suppression partielle (fichier re-téléversé avec moins de jours)
 */
test.serial('marges: suppression partielle quand fichier re-téléversé avec moins de données', async t => {
  const pointId = new ObjectId()
  const preleveurId = new ObjectId()
  const dossierId = new ObjectId()
  const attachmentId = new ObjectId()

  await mongo.db.collection('points_prelevement').insertOne({
    _id: pointId,
    territoire: 'GUADELOUPE',
    id_point: 123
  })

  await mongo.db.collection('preleveurs').insertOne({
    _id: preleveurId,
    email: 'test@example.com'
  })

  await mongo.db.collection('dossiers').insertOne({
    _id: dossierId,
    numero: 12_345,
    status: 'accepte',
    territoire: 'GUADELOUPE',
    usager: {email: 'test@example.com'},
    declarant: {email: 'test@example.com'}
  })

  await mongo.db.collection('dossier_attachments').insertOne({
    _id: attachmentId,
    dossierId,
    filename: 'test.xlsx',
    processed: true,
    validationStatus: 'success'
  })

  const volumeSerieId = new ObjectId()
  await mongo.db.collection('series').insertOne({
    _id: volumeSerieId,
    dossierId,
    attachmentId,
    pointPrelevement: 123,
    parameter: 'volume prélevé',
    frequency: '1 day',
    minDate: '2025-01-01',
    maxDate: '2025-01-05'
  })

  // Version initiale : 5 jours
  await mongo.db.collection('series_values').insertMany([
    {seriesId: volumeSerieId, date: '2025-01-01', value: 100},
    {seriesId: volumeSerieId, date: '2025-01-02', value: 200},
    {seriesId: volumeSerieId, date: '2025-01-03', value: 300},
    {seriesId: volumeSerieId, date: '2025-01-04', value: 400},
    {seriesId: volumeSerieId, date: '2025-01-05', value: 500}
  ])

  // Première consolidation
  await consolidateDossier(dossierId, silentLogger)

  let integrations = await mongo.db.collection('integrations_journalieres').find({attachmentId}).toArray()
  let series = await mongo.db.collection('series').findOne({_id: volumeSerieId})

  t.is(integrations.length, 5, '5 intégrations initiales')
  t.is(series.computed.integratedDays.length, 5)

  // Simule un re-téléversement avec MOINS de données (fichier corrigé)
  await mongo.db.collection('series_values').deleteMany({
    seriesId: volumeSerieId,
    date: {$in: ['2025-01-04', '2025-01-05']}
  })

  await mongo.db.collection('series').updateOne(
    {_id: volumeSerieId},
    {$set: {maxDate: '2025-01-03'}} // Plage réduite
  )

  // Réinitialiser consolidatedAt
  await mongo.db.collection('dossiers').updateOne({_id: dossierId}, {$unset: {consolidatedAt: 1}})

  // Reconsolidation
  await consolidateDossier(dossierId, silentLogger)

  integrations = await mongo.db.collection('integrations_journalieres').find({attachmentId}).toArray()
  series = await mongo.db.collection('series').findOne({_id: volumeSerieId})

  // Les 2 derniers jours doivent être supprimés
  t.is(integrations.length, 3, 'Seulement 3 intégrations restantes')
  t.is(series.computed.integratedDays.length, 3, 'computed.integratedDays mis à jour')
  t.deepEqual(series.computed.integratedDays.sort(), ['2025-01-01', '2025-01-02', '2025-01-03'])
})

/**
 * CAS MARGE 4 : Attachment null (séries sans pièce jointe)
 */
test.serial('marges: gestion des séries sans attachmentId (null)', async t => {
  const pointId = new ObjectId()
  const preleveurId = new ObjectId()
  const dossierId = new ObjectId()

  await mongo.db.collection('points_prelevement').insertOne({
    _id: pointId,
    territoire: 'GUADELOUPE',
    id_point: 123
  })

  await mongo.db.collection('preleveurs').insertOne({
    _id: preleveurId,
    email: 'test@example.com'
  })

  await mongo.db.collection('dossiers').insertOne({
    _id: dossierId,
    numero: 12_345,
    status: 'accepte',
    territoire: 'GUADELOUPE',
    usager: {email: 'test@example.com'},
    declarant: {email: 'test@example.com'}
  })

  // Série sans attachmentId (cas possible dans la base)
  const volumeSerieId = new ObjectId()
  await mongo.db.collection('series').insertOne({
    _id: volumeSerieId,
    dossierId,
    attachmentId: null, // Pas d'attachment
    pointPrelevement: 123,
    parameter: 'volume prélevé',
    frequency: '1 day',
    minDate: '2025-01-01',
    maxDate: '2025-01-02'
  })

  await mongo.db.collection('series_values').insertMany([
    {seriesId: volumeSerieId, date: '2025-01-01', value: 100},
    {seriesId: volumeSerieId, date: '2025-01-02', value: 200}
  ])

  // Consolidation (ne doit pas planter)
  await t.notThrowsAsync(async () => {
    await consolidateDossier(dossierId, silentLogger)
  })

  // Vérifications
  const series = await mongo.db.collection('series').findOne({_id: volumeSerieId})

  // La série doit avoir computed mis à jour
  t.truthy(series.computed, 'computed doit exister')

  // Sans attachmentId, on n'a pas pu créer d'intégrations donc integratedDays doit être vide
  t.deepEqual(series.computed.integratedDays, [], 'integratedDays doit être vide (pas d\'attachment)')

  // Le dossierStatus doit être mis à jour (fait au niveau dossier)
  t.is(series.computed.dossierStatus, 'accepte', 'dossierStatus mis à jour')
})

/**
 * CAS MARGE 5 : Passage de accepté à refusé (nettoyage complet)
 */
test.serial('marges: passage de accepté à refusé supprime toutes les intégrations', async t => {
  const pointId = new ObjectId()
  const preleveurId = new ObjectId()
  const dossierId = new ObjectId()
  const attachmentId = new ObjectId()

  await mongo.db.collection('points_prelevement').insertOne({
    _id: pointId,
    territoire: 'GUADELOUPE',
    id_point: 123
  })

  await mongo.db.collection('preleveurs').insertOne({
    _id: preleveurId,
    email: 'test@example.com'
  })

  // Dossier accepté
  await mongo.db.collection('dossiers').insertOne({
    _id: dossierId,
    numero: 12_345,
    status: 'accepte',
    territoire: 'GUADELOUPE',
    usager: {email: 'test@example.com'},
    declarant: {email: 'test@example.com'}
  })

  await mongo.db.collection('dossier_attachments').insertOne({
    _id: attachmentId,
    dossierId,
    filename: 'test.xlsx',
    processed: true,
    validationStatus: 'success'
  })

  const volumeSerieId = new ObjectId()
  await mongo.db.collection('series').insertOne({
    _id: volumeSerieId,
    dossierId,
    attachmentId,
    pointPrelevement: 123,
    parameter: 'volume prélevé',
    frequency: '1 day',
    minDate: '2025-01-01',
    maxDate: '2025-01-03'
  })

  await mongo.db.collection('series_values').insertMany([
    {seriesId: volumeSerieId, date: '2025-01-01', value: 100},
    {seriesId: volumeSerieId, date: '2025-01-02', value: 200},
    {seriesId: volumeSerieId, date: '2025-01-03', value: 300}
  ])

  // Première consolidation (accepté)
  await consolidateDossier(dossierId, silentLogger)

  let integrations = await mongo.db.collection('integrations_journalieres').find({attachmentId}).toArray()
  t.is(integrations.length, 3, '3 intégrations quand accepté')

  // Changement de statut à refusé
  await mongo.db.collection('dossiers').updateOne(
    {_id: dossierId},
    {$set: {status: 'refuse'}, $unset: {consolidatedAt: 1}}
  )

  // Reconsolidation
  await consolidateDossier(dossierId, silentLogger)

  integrations = await mongo.db.collection('integrations_journalieres').find({attachmentId}).toArray()
  const series = await mongo.db.collection('series').findOne({_id: volumeSerieId})

  t.is(integrations.length, 0, 'Toutes les intégrations supprimées quand refusé')
  t.deepEqual(series.computed.integratedDays, [], 'computed.integratedDays vidé')
  t.is(series.computed.dossierStatus, 'refuse', 'dossierStatus mis à jour')
})

/**
 * CAS 6 : Reconsolidation après ajout de données => mise à jour incrémentale
 */
test.serial('idempotence: reconsolidation après ajout de données intègre les nouveaux jours', async t => {
  const pointId = new ObjectId()
  const preleveurId = new ObjectId()
  const dossierId = new ObjectId()
  const attachmentId = new ObjectId()

  await mongo.db.collection('points_prelevement').insertOne({
    _id: pointId,
    territoire: 'GUADELOUPE',
    id_point: 123
  })

  await mongo.db.collection('preleveurs').insertOne({
    _id: preleveurId,
    email: 'test@example.com'
  })

  await mongo.db.collection('dossiers').insertOne({
    _id: dossierId,
    numero: 12_345,
    status: 'accepte',
    territoire: 'GUADELOUPE',
    usager: {email: 'test@example.com'},
    declarant: {email: 'test@example.com'}
  })

  await mongo.db.collection('dossier_attachments').insertOne({
    _id: attachmentId,
    dossierId,
    filename: 'test.xlsx',
    processed: true,
    validationStatus: 'success'
  })

  const volumeSerieId = new ObjectId()
  await mongo.db.collection('series').insertOne({
    _id: volumeSerieId,
    dossierId,
    attachmentId,
    pointPrelevement: 123,
    parameter: 'volume prélevé',
    frequency: '1 day',
    minDate: '2025-01-01',
    maxDate: '2025-01-02'
  })

  await mongo.db.collection('series_values').insertMany([
    {seriesId: volumeSerieId, date: '2025-01-01', value: 100},
    {seriesId: volumeSerieId, date: '2025-01-02', value: 200}
  ])

  // Première consolidation
  await consolidateDossier(dossierId, silentLogger)

  let integrations = await mongo.db.collection('integrations_journalieres').find({attachmentId}).toArray()
  let series = await mongo.db.collection('series').findOne({_id: volumeSerieId})

  t.is(integrations.length, 2)
  t.is(series.computed.integratedDays.length, 2)

  // Ajout de nouvelles données (simule un re-téléversement avec plus de données)
  await mongo.db.collection('series').updateOne(
    {_id: volumeSerieId},
    {$set: {maxDate: '2025-01-04'}}
  )

  await mongo.db.collection('series_values').insertMany([
    {seriesId: volumeSerieId, date: '2025-01-03', value: 300},
    {seriesId: volumeSerieId, date: '2025-01-04', value: 400}
  ])

  // Réinitialiser consolidatedAt
  await mongo.db.collection('dossiers').updateOne({_id: dossierId}, {$unset: {consolidatedAt: 1}})

  // Reconsolidation
  await consolidateDossier(dossierId, silentLogger)

  integrations = await mongo.db.collection('integrations_journalieres').find({attachmentId}).toArray()
  series = await mongo.db.collection('series').findOne({_id: volumeSerieId})

  t.is(integrations.length, 4, 'Doit avoir 4 intégrations au total')
  t.is(series.computed.integratedDays.length, 4, 'Doit avoir 4 jours dans computed.integratedDays')
  t.deepEqual(series.computed.integratedDays.sort(), [
    '2025-01-01',
    '2025-01-02',
    '2025-01-03',
    '2025-01-04'
  ])
})
