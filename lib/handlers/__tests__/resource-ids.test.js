import test from 'ava'

import {prisma} from '../../../db/prisma.js'
import {createDeclarantLinkSchema} from '../admin-service-accounts.js'
import {handlePasswordActivationIssue, revokePasswordAccessHandler} from '../admin-password-accesses.js'
import {updateChunkInstructionSchema} from '../chunks.js'
import {getDashboardPointActorsHandler} from '../dashboard-point-actors.js'
import {validateCreateDataExportPayload} from '../data-exports.js'
import {addDeclarantDeclarationTypeHandler} from '../declaration-types.js'
import {
  createDeclarationSchema,
  createQuickDeclarationSchema,
  quickDeclarationContextSchema,
  reconcileDeclarationChunkSchema
} from '../declarations.js'
import {listSeriesMetadataSearch, validateListSeriesQuery} from '../series.js'
import {validateQueryParams} from '../series-aggregation.js'
import {validateOptionsQueryParams} from '../series-aggregation-options.js'
import {
  deleteZoneExploitationHandler,
  deleteZonePointPrelevementHandler,
  getZoneExploitationHandler,
  getZonePointPrelevementHandler,
  updateZoneExploitationHandler,
  updateZonePointPrelevementHandler
} from '../zone-resources.js'

const V4 = '11111111-1111-4111-8111-111111111111'
const V5 = '1b50db42-ca4b-5dd2-afc0-491ab70a704f'
const OTHER_V4 = '22222222-2222-4222-8222-222222222222'
const V1 = '11111111-1111-1111-8111-111111111111'

for (const [version, id] of [['v4', V4], ['v5', V5]]) {
  test(`séries acceptent les points et utilisateurs ${version}, sans convertir les identifiants`, t => {
    t.deepEqual(validateListSeriesQuery({pointId: id, preleveurId: id}), {pointId: id, preleveurId: id})
    const scope = {pointIds: `${V4},${id}`, preleveurId: id, collecteurId: id}
    t.like(validateQueryParams({...scope, metricTypeCode: 'volume'}), scope)
    t.deepEqual(validateOptionsQueryParams(scope), scope)
  })

  test(`la seconde validation du handler séries accepte aussi ${version}`, async t => {
    const error = await t.throwsAsync(() => listSeriesMetadataSearch({
      query: {pointId: id, preleveurId: id, startDate: '2026-02-31'},
      user: {role: 'ADMIN'}
    }, {}))
    t.is(error.status, 400)
    t.regex(error.message, /YYYY-MM-DD attendu/)
  })

  test(`déclarations et rapprochements acceptent les références ${version}`, t => {
    const actors = {declarantUserId: id, preleveurUserId: id, targetDeclarantUserId: id}
    for (const [schema, payload] of [
      [createDeclarationSchema, {...actors, type: 'test'}],
      [quickDeclarationContextSchema, actors],
      [reconcileDeclarationChunkSchema, {pointPrelevementId: id}],
      [createQuickDeclarationSchema, {...actors, entries: [{pointPrelevementId: id, index: 1, usageId: V4}], pointUsageNames: [{pointPrelevementId: id, usageName: 'Forage'}]}],
      [updateChunkInstructionSchema, {instructionStatus: 'PENDING', pointPrelevementId: id}],
      [createDeclarantLinkSchema, {declarantUserId: id}]
    ]) {
      const result = schema.validate(payload)
      t.is(result.error, undefined)
      t.like(result.value, payload)
    }
  })

  test(`dashboard transmet le point ${version} au service et conserve son refus d’accès`, async t => {
    const user = {id: OTHER_V4, role: 'INSTRUCTOR'}
    const forbidden = Object.assign(new Error('interdit'), {status: 403})
    const error = await t.throwsAsync(() => getDashboardPointActorsHandler({
      params: {dashboardPointId: id}, user
    }, {}, {
      async getPointActors(pointId, actor) {
        t.is(pointId, id)
        t.is(actor, user)
        throw forbidden
      }
    }))
    t.is(error, forbidden)
  })

  test(`activation mot de passe accepte la cible ${version} sans modifier la protection anti-autoaction`, async t => {
    const notFound = await t.throwsAsync(() => handlePasswordActivationIssue({
      body: {userId: id}, user: {id: OTHER_V4}
    }, {}, {
      async issue(userId, options) {
        t.is(userId, id)
        t.is(options.createdByUserId, OTHER_V4)
        return null
      }
    }))
    t.is(notFound.status, 404)
    const forbidden = await t.throwsAsync(() => revokePasswordAccessHandler({
      params: {userId: id}, user: {id}
    }, {}))
    t.is(forbidden.status, 403)
  })

  test(`types de déclaration acceptent le déclarant ${version} mais gardent leurs propres IDs v4`, async t => {
    const error = await t.throwsAsync(() => addDeclarantDeclarationTypeHandler({
      params: {declarantId: id}, body: {declarationTypeId: V5}
    }, {}))
    t.is(error.status, 400)
    t.regex(error.message, /declarationTypeId/)
    t.notRegex(error.message, /Identifiant de déclarant/)
  })
}

test.serial('fiches et mutations en zone acceptent les ressources v5 mais refusent toujours les acteurs sans droit', async t => {
  const original = prisma.instructorZone.findFirst
  let permissionChecks = 0
  prisma.instructorZone.findFirst = async query => {
    t.is(query.where.zoneId, V4)
    permissionChecks++
    return null
  }
  t.teardown(() => {
    prisma.instructorZone.findFirst = original
  })

  await Promise.all([
    getZonePointPrelevementHandler,
    updateZonePointPrelevementHandler,
    deleteZonePointPrelevementHandler,
    getZoneExploitationHandler,
    updateZoneExploitationHandler,
    deleteZoneExploitationHandler
  ].map(async handler => {
    const error = await t.throwsAsync(() => handler({
      params: {zoneId: V4, pointId: V5, exploitationId: V5},
      user: {id: OTHER_V4, role: 'INSTRUCTOR'},
      body: {}
    }, {}))
    t.is(error.status, 403)
  }))
  t.is(permissionChecks, 6)
})

test('les identifiants malformés et les versions non prises en charge restent refusés', t => {
  for (const id of ['not-an-id', '1234', V1]) {
    t.is(t.throws(() => validateListSeriesQuery({pointId: id})).status, 400)
    t.is(t.throws(() => validateQueryParams({pointIds: id, metricTypeCode: 'volume'})).status, 400)
    t.is(t.throws(() => validateOptionsQueryParams({preleveurId: id})).status, 400)
    t.truthy(createDeclarantLinkSchema.validate({declarantUserId: id}).error)
    t.truthy(updateChunkInstructionSchema.validate({instructionStatus: 'PENDING', pointPrelevementId: id}).error)
    t.truthy(reconcileDeclarationChunkSchema.validate({pointPrelevementId: id}).error)
  }
})

test('les sources, usages et zones techniques restent limités aux UUID v4', t => {
  t.is(t.throws(() => validateListSeriesQuery({sourceId: V5})).status, 400)
  t.is(t.throws(() => validateQueryParams({sourceId: V5, metricTypeCode: 'volume'})).status, 400)
  t.is(t.throws(() => validateOptionsQueryParams({sourceId: V5})).status, 400)
  t.truthy(createQuickDeclarationSchema.validate({entries: [{pointPrelevementId: V5, index: 1, usageId: V5}]}).error)
  for (const field of ['zoneIds', 'sandreZoneIds', 'usageIds']) {
    t.is(t.throws(() => validateCreateDataExportPayload({startDate: '2020-01-01', endDate: '2020-01-02', [field]: [V5]})).status, 400)
  }
})

test('le retrait d’un rapprochement reste possible avec null ou chaîne vide selon le contrat existant', t => {
  for (const pointPrelevementId of [null, '']) {
    t.is(updateChunkInstructionSchema.validate({instructionStatus: 'PENDING', pointPrelevementId}).error, undefined)
  }
  t.is(reconcileDeclarationChunkSchema.validate({pointPrelevementId: null}).error, undefined)
})
