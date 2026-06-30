import createHttpError from 'http-errors'

import {prisma} from '../../db/prisma.js'
import {
  getRootWaterUseCode,
  legacyUsageToDeclarationUsageCode,
  legacyUsageToRootUsageCode,
  normalizeWaterUseCode
} from '../constants/sandre-water-uses.js'

const UNKNOWN_WATER_USE_CODE = '0'
const INDUSTRIAL_WATER_USE_CODE = '4'
const GIDAF_DECLARATION_TYPE_CODE = 'gidaf'
const fallbackWaterUseByCode = new Map()

function waterUseSortKey(waterUse) {
  const match = /^(\d+)(.*)$/u.exec(waterUse?.code ?? '')
  const numericPart = match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
  const suffix = match?.[2] ?? String(waterUse?.code ?? '')

  return [numericPart, suffix]
}

export function sortSandreWaterUses(waterUses = []) {
  return [...waterUses].sort((left, right) => {
    const [leftNumber, leftSuffix] = waterUseSortKey(left)
    const [rightNumber, rightSuffix] = waterUseSortKey(right)

    return leftNumber - rightNumber || leftSuffix.localeCompare(rightSuffix, 'fr')
  })
}

export function serializeWaterUse(waterUse) {
  if (!waterUse) {
    return null
  }

  return {
    id: waterUse.id,
    code: waterUse.code,
    kind: waterUse.kind,
    parentId: waterUse.parentId ?? null,
    mnemonic: waterUse.mnemonic ?? null,
    label: waterUse.label,
    definition: waterUse.definition ?? null,
    status: waterUse.status ?? null,
    color: waterUse.color,
    dashboardVisible: waterUse.dashboardVisible
  }
}

export function serializeWaterUses(waterUses = []) {
  return sortSandreWaterUses(waterUses).map(serializeWaterUse)
}

export function getWaterUseRootId(waterUse) {
  if (!waterUse) {
    return null
  }

  return waterUse.kind === 'USAGE'
    ? waterUse.id
    : waterUse.parentId ?? null
}

export async function listSandreWaterUses() {
  const waterUses = await prisma.sandreWaterUse.findMany()
  return sortSandreWaterUses(waterUses)
}

export async function getWaterUseById(usageId, {rootOnly = false} = {}) {
  if (!usageId) {
    return null
  }

  const waterUse = await prisma.sandreWaterUse.findUnique({
    where: {id: usageId}
  })

  if (!waterUse || (rootOnly && waterUse.kind !== 'USAGE')) {
    throw createHttpError(400, rootOnly ? 'Cet usage est invalide.' : 'Cet usage ou sous-usage est invalide.')
  }

  return waterUse
}

export async function getWaterUseByCode(code, {rootOnly = false} = {}) {
  const normalizedCode = normalizeWaterUseCode(code)

  if (!normalizedCode) {
    throw createHttpError(400, rootOnly ? 'Cet usage est invalide.' : 'Cet usage ou sous-usage est invalide.')
  }

  const waterUse = await prisma.sandreWaterUse.findUnique({
    where: {code: normalizedCode}
  })

  if (!waterUse || (rootOnly && waterUse.kind !== 'USAGE')) {
    throw createHttpError(400, rootOnly ? 'Cet usage est invalide.' : 'Cet usage ou sous-usage est invalide.')
  }

  return waterUse
}

async function getFallbackWaterUseByCode(code) {
  if (!fallbackWaterUseByCode.has(code)) {
    fallbackWaterUseByCode.set(code, getWaterUseByCode(code))
  }

  return fallbackWaterUseByCode.get(code)
}

export async function getFallbackChunkWaterUse({declarationType = null} = {}) {
  const normalizedDeclarationType = String(declarationType ?? '')
    .trim()
    .toLocaleLowerCase('fr-FR')

  const code = normalizedDeclarationType === GIDAF_DECLARATION_TYPE_CODE
    ? INDUSTRIAL_WATER_USE_CODE
    : UNKNOWN_WATER_USE_CODE

  return getFallbackWaterUseByCode(code)
}

export async function getWaterUseByLegacyUsage(legacyUsage, {declaration = false, rootOnly = false} = {}) {
  const code = declaration
    ? legacyUsageToDeclarationUsageCode(legacyUsage)
    : legacyUsageToRootUsageCode(legacyUsage)

  if (!code) {
    throw createHttpError(400, rootOnly ? 'Cet usage est invalide.' : 'Cet usage ou sous-usage est invalide.')
  }

  return getWaterUseByCode(code, {rootOnly})
}

export async function resolveWaterUseInput(input, {
  declaration = false,
  rootOnly = false,
  required = true
} = {}) {
  const usageId = input?.usageId ?? input?.id
  const usage = input?.usage
  const normalizedCode = normalizeWaterUseCode(input?.code ?? usage)
  const legacyUsage = normalizedCode ? null : usage

  if (usageId) {
    return getWaterUseById(usageId, {rootOnly})
  }

  if (normalizedCode) {
    return getWaterUseByCode(normalizedCode, {rootOnly})
  }

  if (legacyUsage) {
    return getWaterUseByLegacyUsage(legacyUsage, {declaration, rootOnly})
  }

  if (required) {
    throw createHttpError(400, rootOnly ? 'Un usage est obligatoire.' : 'Un usage ou sous-usage est obligatoire.')
  }

  return null
}

export function getDeclarationUsageOptionsForRoot(rootWaterUse, waterUses = []) {
  if (!rootWaterUse) {
    return serializeWaterUses(waterUses)
  }

  const rootId = rootWaterUse.kind === 'USAGE'
    ? rootWaterUse.id
    : rootWaterUse.parentId

  return serializeWaterUses(
    waterUses.filter(waterUse => waterUse.id === rootId || waterUse.parentId === rootId)
  )
}

export function getRootUsageCodeFromWaterUse(waterUse) {
  if (!waterUse) {
    return null
  }

  return waterUse.kind === 'USAGE'
    ? waterUse.code
    : getRootWaterUseCode(waterUse.code)
}
