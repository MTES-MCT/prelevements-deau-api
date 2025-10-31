import {chain, minBy} from 'lodash-es'
import createHttpError from 'http-errors'

// Import des models
import * as PointModel from '../models/point-prelevement.js'
import {getPreleveursByIds} from '../models/preleveur.js'
import {getPreleveurExploitations, pointHasActiveExploitation, getExploitationsFromPointId} from '../models/exploitation.js'
import {getBss, getBnpe, getMeso, getMeContinentalesBv, getBvBdcarthage} from '../models/referentiels.js'

// Import de la validation
import {validateCreation, validateChanges} from '../validation/point-validation.js'

/**
 * Service layer pour les points de prélèvement
 * Contient la logique métier et l'orchestration entre models
 */

/* Récupération avec logique métier */

export async function getPointsFromPreleveur(preleveurId, includeDeleted = false) {
  const exploitations = await getPreleveurExploitations(preleveurId, {point: 1})
  const pointIds = chain(exploitations)
    .map('point')
    .uniqBy(id => id.toString())
    .value()

  return PointModel.getPointsPrelevementByIds(pointIds, includeDeleted)
}

/* Création avec enrichissement */

export async function createPointPrelevement(payload, codeTerritoire) {
  const point = validateCreation(payload)
  const enrichedPoint = await enrichPointPrelevement(payload, point)

  return PointModel.insertPointPrelevement(enrichedPoint, codeTerritoire)
}

/* Mise à jour avec enrichissement */

export async function updatePointPrelevement(pointId, payload) {
  const changes = validateChanges(payload)

  if (Object.keys(changes).length === 0) {
    throw createHttpError(400, 'Aucun champ valide trouvé.')
  }

  const enrichedPoint = await enrichPointPrelevement(payload, changes)

  return PointModel.updatePointPrelevementById(pointId, enrichedPoint)
}

/* Suppression avec validation métier */

export async function deletePointPrelevement(pointId) {
  if (await pointHasActiveExploitation(pointId)) {
    throw createHttpError(409, 'Ce point a des exploitations actives.')
  }

  return PointModel.deletePointPrelevementById(pointId)
}

/* Décorateur */

export async function decoratePointPrelevement(point) {
  const exploitations = await getExploitationsFromPointId(point._id)

  const hasExploitations = exploitations.length > 0

  const preleveursIds = chain(exploitations)
    .map(e => e.preleveur)
    .uniqBy(id => id.toString())
    .value()

  const preleveurs = await getPreleveursByIds(preleveursIds)

  const oldestExploitation = minBy(exploitations, e => e.date_debut)

  return {
    ...point,
    preleveurs,
    exploitationsStatus: hasExploitations ? getStatut(exploitations) : null,
    exploitationsStartDate: hasExploitations ? oldestExploitation.date_debut : null,
    usages: chain(exploitations).map('usages').flatten().uniq().value()
  }
}

/* Helpers privés */

function getStatut(exploitations) {
  if (exploitations.some(e => e.statut === 'En activité')) {
    return 'En activité'
  }

  if (exploitations.some(e => e.statut === 'Non renseigné')) {
    return 'Non renseigné'
  }

  if (exploitations.some(e => e.statut === 'Abandonnée')) {
    return 'Abandonnée'
  }

  if (exploitations.some(e => e.statut === 'Terminée')) {
    return 'Terminée'
  }
}

async function enrichPointPrelevement(payload, point) {
  if (payload.bss) {
    const bss = await getBss(payload.bss)

    if (!bss) {
      throw createHttpError(400, 'Code BSS inconnu.')
    }

    point.bss = {
      id_bss: bss.id_bss,
      lien: bss.lien_infoterre
    }
  }

  if (payload.bnpe) {
    const bnpe = await getBnpe(payload.bnpe)

    if (!bnpe) {
      throw createHttpError(400, 'Code BNPE inconnu.')
    }

    point.bnpe = {
      point: bnpe.code_point_prelevement,
      lien: bnpe.uri_ouvrage,
      nom: bnpe.nom_ouvrage
    }
  }

  if (payload.meso) {
    const meso = await getMeso(payload.meso)

    if (!meso) {
      throw createHttpError(400, 'Code MESO inconnu.')
    }

    point.meso = {
      code: meso.code,
      nom: meso.nom_provis
    }
  }

  if (payload.meContinentalesBv) {
    const meContinentalesBv = await getMeContinentalesBv(payload.meContinentalesBv)

    if (!meContinentalesBv) {
      throw createHttpError(400, 'Code meContinentalesBv inconnu.')
    }

    point.meContinentalesBv = {
      code: meContinentalesBv.code_dce,
      nom: meContinentalesBv.nom
    }
  }

  if (payload.bvBdCarthage) {
    const bvBdCarthage = await getBvBdcarthage(payload.bvBdCarthage)

    if (!bvBdCarthage) {
      throw createHttpError(400, 'Code bvBdCarthage inconnu.')
    }

    point.bvBdCarthage = {
      code: bvBdCarthage.code_cours,
      nom: bvBdCarthage.toponyme_t
    }
  }

  if (payload.commune) {
    const response = await fetch(`https://geo.api.gouv.fr/communes/${payload.commune}`)

    if (response.status === 404) {
      throw createHttpError(400, 'Ce code commune est inconnu')
    }

    const data = await response.json()

    point.commune = {
      code: data.code,
      nom: data.nom
    }
  }

  return point
}
