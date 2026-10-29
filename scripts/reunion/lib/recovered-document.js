import {partitionDocuments, readManifestContent, stableSourceId, deterministicStorageKey,
  safeFilename, toDate, sha256, compareData} from './core.js'
import {historyPlanHash} from './history-target.js'

export const RECOVER_DOCUMENT_OPERATION = 'reunion-recovered-document'

export function recoveredDocumentScope(content, {legacyDocumentId, file, sourceUrl}) {
  const {header, records} = readManifestContent(content)
  if (header.territory !== 'DEP-974') throw new Error('Référentiel hors Réunion')
  const url = new URL(sourceUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('URL publique HTTPS sans authentification requise')
  }
  const rows = kind => records.filter(row => row.kind === kind).map(row => row.data)
  const documents = rows('document').filter(row => row._id === legacyDocumentId)
  if (documents.length !== 1 || !documents[0].s3?.missing || !documents[0].s3?.excluded) {
    throw new Error('Document source unique explicitement manquant et exclu requis')
  }
  const document = documents[0]
  const digest = sha256(file)
  const hashPrefix = String(document.objectKey).split('/').at(-2)
  if (!file.subarray(0, 5).equals(Buffer.from('%PDF-')) || file.length !== document.taille
    || !/^[a-f\d]{8,64}$/.test(hashPrefix) || !digest.startsWith(hashPrefix)) {
    throw new Error('PDF différent de la taille ou de l’empreinte source attendue')
  }
  const plans = partitionDocuments({documents, exploitations: rows('exploitation'), rules: rows('rule')})
  if (plans.length !== 1) throw new Error('Propriétaire source unique requis')
  const plan = plans[0]
  const declarants = rows('declarant').filter(row => row._id === plan.ownerId)
  if (declarants.length !== 1) throw new Error('Préleveur source unique requis')
  const exploitations = rows('exploitation').filter(row => plan.exploitationIds.includes(row._id))
  const rules = rows('rule').filter(row => row.document === legacyDocumentId)
  if (rules.some(rule => rule.preleveur !== plan.ownerId
    || rule.exploitations.some(id => !plan.exploitationIds.includes(id)))) {
    throw new Error('Règles source hors du périmètre du document')
  }
  return {
    version: 1, referenceSha256: sha256(content), legacyDocumentId, ownerId: plan.ownerId,
    sourceUrl: url.href, sha256: digest, size: file.length,
    ownerSourceId: stableSourceId('declarant', declarants[0].id_preleveur),
    documentSourceId: stableSourceId('document', legacyDocumentId, plan.ownerId),
    storageKey: deterministicStorageKey({ownerLegacyId: plan.ownerId, documentLegacyId: legacyDocumentId, filename: document.nom_fichier}),
    exploitationSourceIds: plan.exploitationIds.map(id => stableSourceId('exploitation', exploitations.find(row => row._id === id).id_exploitation)),
    ruleSourceIds: rules.map(row => stableSourceId('rule', row._id, plan.ownerId)).sort(),
    document: {contentSha256: digest, title: document.reference || document.nature || safeFilename(document.nom_fichier),
      reference: document.reference || null, nature: document.nature || null, comment: document.remarque || null,
      signatureDate: toDate(document.date_signature)?.toISOString() ?? null, validityEndDate: toDate(document.date_fin_validite)?.toISOString() ?? null,
      filename: safeFilename(document.nom_fichier), mimeType: 'application/pdf', size: file.length,
      deletedAt: toDate(document.deletedAt)?.toISOString() ?? null}
  }
}

const plain = value => JSON.parse(JSON.stringify(value))

export async function captureRecoveredDocumentState(client, scope) {
  const [owner, exploitations, rules, documents] = await Promise.all([
    client.declarant.findUnique({where: {sourceId: scope.ownerSourceId}, include: {user: {select: {id: true, deletedAt: true}}}}),
    client.declarantPointPrelevement.findMany({where: {sourceId: {in: scope.exploitationSourceIds}}, orderBy: {id: 'asc'}}),
    client.resourceRule.findMany({where: {sourceId: {in: scope.ruleSourceIds}}, orderBy: {id: 'asc'}, include: {exploitations: true}}),
    client.resourceDocument.findMany({where: {OR: [{sourceId: scope.documentSourceId}, {storageKey: scope.storageKey}]}, include: {exploitations: true}, orderBy: {id: 'asc'}})
  ])
  return plain({owner, exploitations, rules, documents})
}

export function planRecoveredDocument(scope, before, object) {
  const {owner, exploitations, rules, documents} = before
  if (!owner || owner.user?.deletedAt || owner.declarantRole !== 'PRELEVEUR'
    || exploitations.length !== scope.exploitationSourceIds.length || rules.length !== scope.ruleSourceIds.length
    || exploitations.some(row => row.declarantUserId !== owner.userId || row.deletedAt)
    || rules.some(row => row.declarantUserId !== owner.userId || row.deletedAt)) {
    throw new Error('Préleveur, exploitations ou règles cibles absents ou contradictoires')
  }
  const exploitationIds = exploitations.map(row => row.id).sort()
  if (rules.some(row => row.exploitations.some(link => !exploitationIds.includes(link.declarantPointPrelevementId)))) {
    throw new Error('Liens des règles hors des exploitations source')
  }
  if (!object.missing && (object.sha256 !== scope.sha256 || object.size !== scope.size)) {
    throw new Error('Objet cible différent : remplacement interdit')
  }
  const expected = {...scope.document, sourceId: scope.documentSourceId, storageKey: scope.storageKey,
    declarantUserId: owner.userId, declarantPointPrelevementId: exploitations.find(row => row.sourceId === scope.exploitationSourceIds[0])?.id ?? null}
  if (documents.length > 1) throw new Error('Collision de document cible')
  const document = documents[0]
  if (document && (!compareData(document, plain(expected))
    || historyPlanHash(document.exploitations.map(row => row.declarantPointPrelevementId).sort()) !== historyPlanHash(exploitationIds))) {
    throw new Error('Document ou liens existants différents : remplacement interdit')
  }
  if (rules.some(row => row.documentId && row.documentId !== document?.id)) {
    throw new Error('Une règle est déjà liée à un autre document')
  }
  const changes = {document: document ? 0 : 1, exploitationLinks: document ? 0 : exploitationIds.length,
    ruleLinks: rules.filter(row => !row.documentId).length, object: object.missing ? 1 : 0}
  const state = plain({scope, before, object: {missing: Boolean(object.missing), sha256: object.sha256 ?? null, size: object.size ?? null}})
  return {before, expected, exploitationIds, changes, planHash: historyPlanHash(state)}
}

export function assertRecoveredDocumentBackup(evidence, snapshot, plan, sourceHash) {
  if (evidence?.operation !== RECOVER_DOCUMENT_OPERATION || evidence.sourceHash !== sourceHash
    || evidence.planHash !== plan.planHash || evidence.rowsSha256 !== historyPlanHash(plan.before)
    || snapshot?.operation !== RECOVER_DOCUMENT_OPERATION || snapshot.sourceHash !== sourceHash
    || historyPlanHash(snapshot.rows) !== evidence.rowsSha256) {
    throw new Error('Sauvegarde restaurée du même document et du même état obligatoire')
  }
}

export async function applyRecoveredDocument(client, plan) {
  let document = plan.before.documents[0]
  if (!document) {
    document = await client.resourceDocument.create({data: plan.expected})
    if (plan.exploitationIds.length) await client.resourceDocumentExploitation.createMany({data: plan.exploitationIds.map(id => ({
      resourceDocumentId: document.id, declarantPointPrelevementId: id
    }))})
  }
  const ruleIds = plan.before.rules.filter(row => !row.documentId).map(row => row.id)
  if (ruleIds.length) {
    const updated = await client.resourceRule.updateMany({where: {id: {in: ruleIds}, documentId: null}, data: {documentId: document.id}})
    if (updated.count !== ruleIds.length) throw new Error('Les règles ont changé pendant la reprise')
  }
  return document.id
}
