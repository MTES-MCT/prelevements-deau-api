import test from 'ava'
import {digest, stableId} from '../epidropt.js'
import {validateReviewedApplicationInput, validateReviewedBackupEvidence} from '../apply-reviewed.js'

const pointId = stableId('reviewed-unit-point')
const otherPointId = stableId('reviewed-unit-other-point')
const exploitationId = stableId('reviewed-unit-exploitation')
const hash = 'a'.repeat(64)
const sign = ({manifestHash, ...payload}) => ({...payload, manifestHash: digest(payload)})
const plan = {scope: 'epidropt', merges: [], retirePointIds: [], retireExploitationIds: [], resetMeterIds: [], discardMeterVolumes: false}
const manifest = () => sign({formatVersion: 1, scope: 'epidropt', points: [{id: pointId}], declarants: [],
  exploitations: [{id: exploitationId}], meters: [], allocations: [], issues: [], reviewedConsolidationPlan: plan})
const evidence = () => ({target: 'testing', backup: {sha256: hash}, restore: {success: true, matchesPreflight: true}, reviewedStateHash: hash})

test('le plan durable du manifeste suffit, sans fichier temporaire', t => {
  t.deepEqual(validateReviewedApplicationInput(manifest(), {target: 'testing'}), plan)
})

test('cibles restreintes et activation, date de correction, compte de service interdits', t => {
  for (const target of ['testing', 'restored-copy', 'disposable']) {
    t.notThrows(() => validateReviewedApplicationInput(manifest(), {target}))
  }
  for (const target of ['prod', 'production', 'demo', 'local', undefined]) {
    t.throws(() => validateReviewedApplicationInput(manifest(), {target}), {message: 'REVIEWED_TARGET_FORBIDDEN'})
  }
  for (const option of ['activateAt', 'effectiveAt', 'serviceAccountId']) {
    t.throws(() => validateReviewedApplicationInput(manifest(), {target: 'testing', [option]: 'forbidden'}),
      {message: 'REVIEWED_ACTIVATION_OR_RECOMPUTATION_FORBIDDEN'})
  }
})

test('manifeste incohérent, vide ou explicitement incomplet refusé avant transaction', t => {
  const input = manifest()
  t.throws(() => validateReviewedApplicationInput({...input, manifestHash: hash}, {target: 'testing'}), {message: /Empreinte/})
  for (const replacement of [{points: []}, {complete: false}]) {
    t.throws(() => validateReviewedApplicationInput(sign({...input, ...replacement}), {target: 'testing'}),
      {message: 'REVIEWED_MANIFEST_INCOMPLETE'})
  }
})

test('aucun PP ou exploitation explicitement retiré ne peut être réimporté', t => {
  for (const consolidationPlan of [
    {...plan, retirePointIds: [pointId]},
    {...plan, retireExploitationIds: [exploitationId]},
    {...plan, merges: [{sourcePointId: pointId, targetPointId: otherPointId, exploitationMerges: []}]}
  ]) {
    t.throws(() => validateReviewedApplicationInput(manifest(), {target: 'testing', consolidationPlan}),
      {message: 'REVIEWED_MANIFEST_REINTRODUCES_RETIRED_OBJECT'})
  }
})

test('une cible de fusion exclue du manifeste par un conflit bloque toute application', t => {
  const consolidationPlan = {...plan, merges: [{sourcePointId: otherPointId, targetPointId: pointId,
    exploitationMerges: [{sourceId: stableId('old-exploitation'), targetId: stableId('missing-survivor')}]}]}
  t.throws(() => validateReviewedApplicationInput(manifest(), {target: 'testing', consolidationPlan}),
    {message: 'REVIEWED_MANIFEST_MERGE_TARGET_MISSING'})
})

test('application exige une simulation complète, non appliquée, de la même cible et des mêmes entrées', t => {
  const input = manifest()
  const expectedReport = {operation: 'apply-reviewed', target: 'testing', manifestHash: input.manifestHash,
    consolidationPlanHash: digest(plan), complete: true, applied: false, planHash: hash, stateHash: hash}
  t.notThrows(() => validateReviewedApplicationInput(input, {target: 'testing', apply: true, expectedReport}))
  t.throws(() => validateReviewedApplicationInput(input, {target: 'testing', apply: true}), {message: 'REVIEWED_SIMULATION_REQUIRED'})
  for (const replacement of [{operation: 'apply'}, {target: 'restored-copy'}, {manifestHash: 'b'.repeat(64)},
    {consolidationPlanHash: 'b'.repeat(64)}, {complete: false}, {applied: true}, {planHash: ''}, {stateHash: ''}]) {
    t.throws(() => validateReviewedApplicationInput(input, {target: 'testing', apply: true, expectedReport: {...expectedReport, ...replacement}}),
      {message: 'REVIEWED_SIMULATION_INCOMPATIBLE'})
  }
})

test('preuve de restauration liée à l’état revu, jamais à un simple booléen backup', t => {
  t.is(validateReviewedBackupEvidence(evidence(), hash), hash)
  t.is(validateReviewedBackupEvidence({target: 'testing', backupSha256: hash,
    restoreVerification: {success: true, matchesPreflight: true}, reviewedStateHash: hash}, hash), hash)
  for (const invalid of [null, {}, {...evidence(), target: 'prod'}, {...evidence(), reviewedStateHash: undefined},
    {...evidence(), reviewedStateHash: 'b'.repeat(64)}, {...evidence(), backup: {sha256: 'invalid'}},
    {...evidence(), restore: {success: false, matchesPreflight: true}}, {...evidence(), restore: {success: true, matchesPreflight: false}}]) {
    t.throws(() => validateReviewedBackupEvidence(invalid, hash), {message: 'REVIEWED_VERIFIED_RESTORED_BACKUP_REQUIRED'})
  }
})
