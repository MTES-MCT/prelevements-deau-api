import {prisma} from '../../db/prisma.js'
import {activeWindowWhere} from './point-prelevement.js'

export const TEMPLATE_DECLARATION_TYPE_CODE = 'template-file'
export const TEMPLATE_DECLARATION_TYPE_NAME = 'Modèle de déclaration de volumes'

export function normalizeDeclarationTypeCode(code) {
  return String(code ?? '').trim().toLocaleLowerCase('fr-FR')
}

function toDateOnly(value) {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date
}

export function serializeDeclarationType(declarationType) {
  if (!declarationType) {
    return null
  }

  return {
    id: declarationType.id,
    code: declarationType.code,
    name: declarationType.name,
    version: declarationType.version,
    isAvailable: declarationType.isAvailable
  }
}

export async function ensureDeclarationType({
  code,
  name,
  version = 1,
  isAvailable = true
}, db = prisma) {
  const normalizedCode = normalizeDeclarationTypeCode(code)

  if (!normalizedCode) {
    throw new Error('code de type de déclaration requis')
  }

  const displayName = name || normalizedCode

  return db.declarationType.upsert({
    where: {
      code: normalizedCode
    },
    create: {
      code: normalizedCode,
      name: displayName,
      version,
      isAvailable
    },
    update: {
      name: displayName,
      version,
      isAvailable
    }
  })
}

export async function allowDeclarationTypeForDeclarant({
  declarantUserId,
  code,
  name,
  version = 1,
  isAvailable = true,
  startDate = null,
  endDate = null
}, db = prisma) {
  const declarationType = await ensureDeclarationType({
    code,
    name,
    version,
    isAvailable
  }, db)

  const existingLink = await db.declarantDeclarationType.findFirst({
    where: {
      declarantUserId,
      declarationTypeId: declarationType.id,
      startDate
    }
  })

  if (existingLink) {
    return db.declarantDeclarationType.update({
      where: {
        id: existingLink.id
      },
      data: {
        endDate
      }
    })
  }

  return db.declarantDeclarationType.create({
    data: {
      declarantUserId,
      declarationTypeId: declarationType.id,
      startDate,
      endDate
    }
  })
}

export async function allowTemplateDeclarationTypeForDeclarant(declarantUserId, db = prisma) {
  return allowDeclarationTypeForDeclarant({
    declarantUserId,
    code: TEMPLATE_DECLARATION_TYPE_CODE,
    name: TEMPLATE_DECLARATION_TYPE_NAME,
    version: 1,
    isAvailable: true
  }, db)
}

export async function listAllowedDeclarationTypesForDeclarant(
  declarantUserId,
  now = new Date()
) {
  const referenceDate = toDateOnly(now)

  const links = await prisma.declarantDeclarationType.findMany({
    where: {
      declarantUserId,
      ...activeWindowWhere(referenceDate),
      declarationType: {
        isAvailable: true
      }
    },
    include: {
      declarationType: true
    },
    orderBy: [
      {
        declarationType: {
          name: 'asc'
        }
      },
      {startDate: 'asc'}
    ]
  })

  const byCode = new Map()

  for (const link of links) {
    const declarationType = serializeDeclarationType(link.declarationType)

    if (!declarationType || byCode.has(declarationType.code)) {
      continue
    }

    byCode.set(declarationType.code, declarationType)
  }

  return [...byCode.values()]
}

export async function findAllowedDeclarationTypeForDeclarant(
  declarantUserId,
  code,
  now = new Date()
) {
  const referenceDate = toDateOnly(now)
  const normalizedCode = normalizeDeclarationTypeCode(code)

  if (!normalizedCode) {
    return null
  }

  const link = await prisma.declarantDeclarationType.findFirst({
    where: {
      declarantUserId,
      ...activeWindowWhere(referenceDate),
      declarationType: {
        code: normalizedCode,
        isAvailable: true
      }
    },
    include: {
      declarationType: true
    },
    orderBy: [
      {startDate: 'desc'},
      {createdAt: 'desc'}
    ]
  })

  return serializeDeclarationType(link?.declarationType)
}

export async function getDeclarationTypesByCodes(codes) {
  const normalizedCodes = [
    ...new Set(
      (codes ?? [])
        .map(code => normalizeDeclarationTypeCode(code))
        .filter(Boolean)
    )
  ]

  if (normalizedCodes.length === 0) {
    return new Map()
  }

  const declarationTypes = await prisma.declarationType.findMany({
    where: {
      code: {
        in: normalizedCodes
      }
    }
  })

  return new Map(
    declarationTypes.map(declarationType => [
      declarationType.code,
      serializeDeclarationType(declarationType)
    ])
  )
}

export async function decorateDeclarationsWithDeclarationTypes(declarations) {
  if (!Array.isArray(declarations) || declarations.length === 0) {
    return declarations
  }

  const declarationTypesByCode = await getDeclarationTypesByCodes(
    declarations.map(declaration => declaration?.type)
  )

  return declarations.map(declaration => ({
    ...declaration,
    declarationType: declarationTypesByCode.get(
      normalizeDeclarationTypeCode(declaration?.type)
    ) ?? null
  }))
}
