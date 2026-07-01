import {prisma} from '../../db/prisma.js'
import {getRootWaterUseCode} from '../constants/sandre-water-uses.js'

const ACTIVE_STATUS = 'EN_ACTIVITE'
const OPEN_STATUSES = ['EN_ACTIVITE', 'NON_RENSEIGNE']
const SURFACE_WATER_BODY_TYPES = new Set(['SURFACE', 'SUPERFICIELLE'])

function getExploitationUsageValues(exploitation) {
  if (Array.isArray(exploitation.usages)) {
    return exploitation.usages
  }

  return exploitation.usage ? [exploitation.usage] : []
}

function getUsageLabels(value) {
  if (value && typeof value === 'object') {
    return [
      value.label,
      value.mnemonic,
      value.code
    ].filter(Boolean)
  }

  return value ? [String(value)] : []
}

function isConcernedByUsage(exploitation, {codes = [], labels = []}) {
  return getExploitationUsageValues(exploitation).some(value => {
    const code = value && typeof value === 'object'
      ? getRootWaterUseCode(value.code)
      : getRootWaterUseCode(value)

    if (code && codes.includes(code)) {
      return true
    }

    const normalizedLabels = new Set(getUsageLabels(value).map(label => label.toLocaleLowerCase('fr-FR')))
    return labels.some(label => normalizedLabels.has(label.toLocaleLowerCase('fr-FR')))
  })
}

function isDocumentValidToday(document, now = new Date()) {
  return document.validityEndDate === null
    || document.validityEndDate === undefined
    || document.validityEndDate > now
}

function hasAuthorizationDocument(exploitation, matcher, now = new Date()) {
  return (exploitation.documents ?? []).some(document =>
    (document.deletedAt === null || document.deletedAt === undefined)
    && matcher(document)
    && isDocumentValidToday(document, now)
  )
}

function getPointGlobalStatus(exploitations = []) {
  const statuses = exploitations
    .map(exploitation => exploitation.status)
    .filter(Boolean)

  if (statuses.includes('EN_ACTIVITE')) {
    return 'EN_ACTIVITE'
  }

  if (statuses.includes('NON_RENSEIGNE') || statuses.length === 0) {
    return 'NON_RENSEIGNE'
  }

  if (statuses.includes('TERMINEE')) {
    return 'TERMINEE'
  }

  if (statuses.includes('ABANDONNEE')) {
    return 'ABANDONNEE'
  }

  return 'NON_RENSEIGNE'
}

export function computePointStatusCounts(points = []) {
  const counters = {
    enActivitePoints: 0,
    termineePoints: 0,
    abandoneePoints: 0,
    nonRenseignePoints: 0
  }

  for (const point of points) {
    const status = getPointGlobalStatus(point.declarants ?? [])

    switch (status) {
      case 'EN_ACTIVITE': {
        counters.enActivitePoints++
        break
      }

      case 'TERMINEE': {
        counters.termineePoints++
        break
      }

      case 'ABANDONNEE': {
        counters.abandoneePoints++
        break
      }

      default: {
        counters.nonRenseignePoints++
      }
    }
  }

  return counters
}

export function computeDocumentsStats(documents = []) {
  return documents
    .filter(document => document.nature && document.signatureDate)
    .map(document => ({
      id: document.id,
      nature: document.nature,
      annee: String(document.signatureDate.getUTCFullYear())
    }))
    .sort((a, b) => a.nature.localeCompare(b.nature, 'fr') || a.annee.localeCompare(b.annee))
}

export function computeRegularisationsStats(exploitations = [], now = new Date()) {
  const regimes = [
    {
      nom: 'AOT',
      concerne: () => true,
      autorise: doc => doc.nature === 'Autorisation AOT'
    },
    {
      nom: 'IOTA',
      concerne: exploitation => isConcernedByUsage(exploitation, {
        codes: ['0', '2', '3', '5'],
        labels: ['Eau potable', 'Agriculture', 'Autre', 'Non renseigné']
      }),
      autorise: doc => doc.nature === 'Autorisation IOTA' || doc.nature === 'Autorisation CSP - IOTA'
    },
    {
      nom: 'CSP',
      concerne: exploitation => isConcernedByUsage(exploitation, {
        codes: ['5'],
        labels: ['Eau potable']
      }),
      autorise: doc => doc.nature === 'Autorisation CSP' || doc.nature === 'Autorisation CSP - IOTA'
    },
    {
      nom: 'ICPE',
      concerne: exploitation => isConcernedByUsage(exploitation, {
        codes: ['4', '8', '9'],
        labels: ['Eau embouteillée', 'Industrie', 'Thermalisme']
      }),
      autorise: doc => doc.nature === 'Autorisation ICPE'
    },
    {
      nom: 'Hydroélectricité',
      concerne: exploitation => isConcernedByUsage(exploitation, {
        codes: ['6'],
        labels: ['Hydroélectricité']
      }),
      autorise: doc => doc.nature === 'Autorisation hydroélectricité'
    }
  ]

  return regimes.map(regime => {
    const concernees = exploitations.filter(exploitation => regime.concerne(exploitation))
    const autorisees = concernees.filter(exploitation =>
      hasAuthorizationDocument(exploitation, regime.autorise, now)
    )

    return {
      regime: regime.nom,
      nb_exploitations_concernees: concernees.length,
      nb_exploitations_autorisees: autorisees.length,
      nb_exploitations_non_autorisees: concernees.length - autorisees.length
    }
  })
}

export function computeDebitsReservesStats(exploitations = []) {
  const surfaceExploitations = exploitations.filter(exploitation =>
    SURFACE_WATER_BODY_TYPES.has(exploitation.pointPrelevement?.waterBodyType)
    && !exploitation.pointPrelevement?.name?.toLocaleLowerCase('fr-FR').includes('source')
  )

  const withDebitReserve = surfaceExploitations.filter(exploitation =>
    (exploitation.rules ?? []).some(link => {
      const rule = link.resourceRule

      return (rule?.deletedAt === null || rule?.deletedAt === undefined)
        && rule.parameter === 'Débit réservé'
        && isDocumentValidToday({validityEndDate: rule.validityEndDate})
    })
  )

  return [
    {
      debitReserve: 'Débit réservé défini',
      nbExploitations: withDebitReserve.length
    },
    {
      debitReserve: 'Pas de débit réservé',
      nbExploitations: surfaceExploitations.length - withDebitReserve.length
    }
  ]
}

export async function getStats(db = prisma) {
  const [
    pointsCount,
    points,
    activeExploitations,
    openExploitations,
    documents
  ] = await Promise.all([
    db.pointPrelevement.count({
      where: {deletedAt: null}
    }),
    db.pointPrelevement.findMany({
      where: {deletedAt: null},
      select: {
        id: true,
        declarants: {
          select: {
            status: true
          }
        }
      }
    }),
    db.declarantPointPrelevement.findMany({
      where: {
        status: ACTIVE_STATUS,
        pointPrelevement: {
          deletedAt: null
        }
      },
      select: {
        declarantUserId: true,
        pointPrelevementId: true,
        pointPrelevement: {
          select: {
            waterBodyType: true
          }
        }
      }
    }),
    db.declarantPointPrelevement.findMany({
      where: {
        status: {in: OPEN_STATUSES},
        pointPrelevement: {
          deletedAt: null
        }
      },
      include: {
        usage: true,
        documents: {
          where: {deletedAt: null}
        },
        pointPrelevement: {
          select: {
            name: true,
            waterBodyType: true
          }
        },
        rules: {
          include: {
            resourceRule: true
          }
        }
      }
    }),
    db.resourceDocument.findMany({
      where: {
        deletedAt: null,
        nature: {not: null},
        signatureDate: {not: null}
      },
      select: {
        id: true,
        nature: true,
        signatureDate: true
      }
    })
  ])

  return {
    debitsReserves: computeDebitsReservesStats(openExploitations),
    regularisations: computeRegularisationsStats(openExploitations),
    documents: computeDocumentsStats(documents),
    pointsCount,
    activPointsPrelevementCount: new Set(activeExploitations.map(exploitation => exploitation.pointPrelevementId)).size,
    activPreleveursCount: new Set(activeExploitations.map(exploitation => exploitation.declarantUserId)).size,
    activPointsSurfaceCount: new Set(
      activeExploitations
        .filter(exploitation => SURFACE_WATER_BODY_TYPES.includes(exploitation.pointPrelevement?.waterBodyType))
        .map(exploitation => exploitation.pointPrelevementId)
    ).size,
    activPointsSouterrainCount: new Set(
      activeExploitations
        .filter(exploitation => exploitation.pointPrelevement?.waterBodyType === 'SOUTERRAIN')
        .map(exploitation => exploitation.pointPrelevementId)
    ).size,
    ...computePointStatusCounts(points)
  }
}
