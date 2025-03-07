/* eslint-disable no-await-in-loop */
import fs from 'node:fs/promises'
import {keyBy, orderBy, groupBy} from 'lodash-es'
import Papa from 'papaparse'

import mongo from '../../util/mongo.js'

import {extractGeometry} from '../../util/extract-geom.js'
import {typesMilieu, statutsExploitation, parametres, unites, contraintes, natures, frequences, traitements, precisionsGeom, usages} from '../../nomenclature.js'

import {insertVolumesPreleves} from '../volume-preleve.js'

/* Parsers */

function parseString(value) {
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function parseNumber(value) {
  return value === '' ? undefined : Number(value)
}

function parseBoolean(value) {
  switch (value.toLowerCase()) {
    case 't': {
      return true
    }

    case 'f': {
      return false
    }

    case '': {
      return undefined
    }

    default: {
      console.warn('Valeur booléenne inconnue', value)
    }
  }
}

function parseDate(value) {
  const simpleDateRegex = /^\d{4}-\d{2}-\d{2}$/
  const customDateTimeRegex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}$/

  if (simpleDateRegex.test(value)) {
    return value
  }

  if (customDateTimeRegex.test(value)) {
    return (new Date(value)).toISOString()
  }

  if (value) {
    console.warn(`Unknown date format: ${value}`)
  }
}

export function parseNomenclature(value, nomenclature) {
  if (value && !nomenclature[value]) {
    console.warn(`Valeur inconnue dans la nomenclature: ${value || 'VIDE'}`)
  }

  return nomenclature[value]
}

async function readDataFromCsvFile(filePath, tableDefinition) {
  const csvContent = await fs.readFile(filePath, 'utf8')
  const {data: inputRows} = Papa.parse(csvContent, {header: true, skipEmptyLines: true})

  const outputRows = []

  for (const inputRow of inputRows) {
    const outputRow = {}

    for (const [key, value] of Object.entries(inputRow)) {
      const fieldDefinition = tableDefinition.schema[key]
      if (fieldDefinition) {
        if (fieldDefinition.drop) {
          continue
        }

        outputRow[key] = fieldDefinition.parse ? fieldDefinition.parse(value) : value
      }
    }

    if (!tableDefinition.requiredFields || tableDefinition.requiredFields.every(field => outputRow[field] !== undefined)) {
      outputRows.push(outputRow)
    } else {
      console.warn('Dropping row because of missing required fields', outputRow)
    }
  }

  return outputRows
}

const POINTS_PRELEVEMENT_DEFINITION = {
  schema: {
    id_point: {parse: parseString},
    nom: {parse: parseString},
    autres_noms: {parse: parseString},
    code_bnpe: {parse: parseString},
    id_bss: {parse: parseString},
    code_aiot: {parse: parseString},
    type_milieu: {parse: value => parseNomenclature(value, typesMilieu)},
    profondeur: {parse: parseNumber},
    zre: {parse: parseBoolean},
    reservoir_biologique: {parse: parseBoolean},
    insee_com: {parse: parseString},
    code_bdlisa: {parse: parseString},
    code_meso: {parse: parseString},
    code_bv_bdcarthage: {parse: parseString},
    code_me_continentales_bv: {parse: parseString},
    cours_eau: {parse: parseString},
    detail_localisation: {parse: parseString},
    geom: {parse: extractGeometry},
    precision_geom: {parse: value => parseNomenclature(value, precisionsGeom)},
    remarque: {parse: parseString}
  },
  requiredFields: ['id_point', 'nom', 'geom']
}

const EXPLOITATIONS_DEFINITION = {
  schema: {
    id_exploitation: {parse: parseString},
    date_debut: {parse: parseDate},
    date_fin: {parse: parseDate},
    statut: {parse: value => parseNomenclature(value, statutsExploitation)},
    raison_abandon: {parse: parseString},
    remarque: {parse: parseString},
    id_point: {parse: parseString},
    id_beneficiaire: {parse: parseString}
  },
  requiredFields: ['id_exploitation', 'id_point']
}

const BENEFICIAIRES_DEFINITION = {
  schema: {
    id_beneficiaire: {parse: parseString},
    raison_sociale: {parse: parseString},
    sigle: {parse: parseString},
    civilite: {parse: parseString},
    nom: {parse: parseString},
    prenom: {parse: parseString},
    email: {parse: parseString},
    adresse_1: {parse: parseString},
    adresse_2: {parse: parseString},
    bp: {parse: parseString},
    code_postal: {parse: parseString},
    commune: {parse: parseString},
    numero_telephone: {parse: parseString}
  },
  requiredFields: ['id_beneficiaire']
}

const REGLES_DEFINITION = {
  schema: {
    id_regle: {parse: parseString},
    parametre: {parse: value => parseNomenclature(value, parametres)},
    unite: {parse: value => parseNomenclature(value, unites)},
    valeur: {parse: parseNumber},
    contrainte: {parse: value => parseNomenclature(value, contraintes)},
    debut_validite: {parse: parseDate},
    fin_validite: {parse: parseDate},
    debut_periode: {parse: parseDate},
    fin_periode: {parse: parseDate},
    remarque: {parse: parseString},
    id_document: {parse: parseString}
  },
  requiredFields: ['id_regle']
}

const DOCUMENTS_DEFINITION = {
  schema: {
    id_document: {parse: parseString},
    nom_fichier: {parse: parseString},
    reference: {parse: parseString},
    nature: {parse: value => parseNomenclature(value, natures)},
    date_signature: {parse: parseDate},
    date_fin_validite: {parse: parseDate},
    date_ajout: {parse: parseDate},
    remarque: {parse: parseString}
  },
  requiredFields: ['id_document']
}

const MODALITES_DEFINITION = {
  schema: {
    id_modalite: {parse: parseString},
    freq_volume_preleve: {parse: value => parseNomenclature(value, frequences)},
    freq_debit_preleve: {parse: value => parseNomenclature(value, frequences)},
    freq_debit_reserve: {parse: value => parseNomenclature(value, frequences)},
    freq_conductivite: {parse: value => parseNomenclature(value, frequences)},
    freq_temperature: {parse: value => parseNomenclature(value, frequences)},
    freq_niveau_eau: {parse: value => parseNomenclature(value, frequences)},
    freq_ph: {parse: value => parseNomenclature(value, frequences)},
    freq_chlorure: {parse: value => parseNomenclature(value, frequences)},
    freq_nitrates: {parse: value => parseNomenclature(value, frequences)},
    freq_sulfates: {parse: value => parseNomenclature(value, frequences)},
    remarque: {parse: parseString}
  },
  requiredFields: ['id_modalite']
}

const SERIES_DEFINITION = {
  schema: {
    id_serie: {parse: parseString},
    detail_point_suivi: {parse: parseString},
    profondeur: {parse: parseNumber},
    parametre: {parse: value => parseNomenclature(value, parametres)},
    unite: {parse: value => parseNomenclature(value, unites)},
    frequence_acquisition: {parse: value => parseNomenclature(value, frequences)},
    traitement: {parse: value => parseNomenclature(value, traitements)},
    frequence_traitement: {parse: value => parseNomenclature(value, frequences)},
    etat_prelevement: {parse: parseBoolean},
    debut_periode: {parse: parseDate},
    fin_periode: {parse: parseDate},
    remarque: {parse: parseString},
    id_declaration: {parse: parseString},
    id_fichier: {parse: parseString}
  },
  requiredFields: ['id_serie']
}

const RESULTATS_DEFINITION = {
  schema: {
    id_resultat: {parse: parseString},
    id_origine: {parse: parseString},
    date_heure_mesure: {parse: parseDate},
    valeur: {parse: parseNumber},
    remarque: {parse: parseString},
    id_serie: {parse: parseString}
  },
  requiredFields: ['id_resultat']
}

const BSS_DEFINITION = {
  schema: {
    id_bss: {parse: parseString},
    lien_infoterre: {parse: parseString}
  },
  requiredFields: ['id_bss']
}

const BNPE_DEFINITION = {
  schema: {
    code_point_prelevement: {parse: parseString},
    uri_ouvrage: {parse: parseString}
  },
  requiredFields: ['code_point_prelevement']
}

const ME_CONTINENTALES_BV_DEFINITION = {
  schema: {
    code_dce: {parse: parseString},
    nom: {parse: parseString}
  },
  requiredFields: ['code_dce']
}

const BV_BDCARTHAGE_DEFINITION = {
  schema: {
    code_cours: {parse: parseString},
    toponyme_t: {parse: parseString}
  },
  requiredFields: ['code_cours']
}

const MESO_DEFINITION = {
  schema: {
    code: {parse: parseString},
    nom_provis: {parse: parseString}
  },
  requiredFields: ['code']
}

const LIBELLES_DEFINITION = {
  schema: {
    id: {parse: parseString},
    insee_com: {parse: parseString},
    nom: {parse: parseString}
  },
  requiredFields: ['id']
}

async function loadExploitationsRegles() {
  const csvContent = await fs.readFile('data/exploitation-regle.csv', 'utf8')
  const {data: rows} = Papa.parse(csvContent, {header: true, skipEmptyLines: true})

  return rows
}

async function loadExploitationsModalitesSuivis() {
  const csvContent = await fs.readFile('data/exploitation-modalite-suivi.csv', 'utf8')
  const {data: rows} = Papa.parse(csvContent, {header: true, skipEmptyLines: true})

  return rows
}

async function loadExploitationsUsage() {
  const csvContent = await fs.readFile('data/exploitation-usage.csv', 'utf8')
  const {data: rows} = Papa.parse(csvContent, {header: true, skipEmptyLines: true})

  return rows
}

async function loadExploitationsSerie() {
  const csvContent = await fs.readFile('data/exploitation-serie.csv', 'utf8')
  const {data: rows} = Papa.parse(csvContent, {header: true, skipEmptyLines: true})

  return rows
}

async function loadExploitationsDocuments() {
  const csvContent = await fs.readFile('data/exploitation-document.csv', 'utf8')
  const {data: rows} = Papa.parse(csvContent, {header: true, skipEmptyLines: true})

  return rows
}

// Initialisation
export const beneficiaires = await readDataFromCsvFile(
  'data/beneficiaire-email.csv',
  BENEFICIAIRES_DEFINITION
)

const exploitationsRaw = await readDataFromCsvFile(
  'data/exploitation.csv',
  EXPLOITATIONS_DEFINITION
)

export const exploitations = orderBy(exploitationsRaw, 'date_debut', 'asc')

export const pointsPrelevement = await readDataFromCsvFile(
  'data/point-prelevement.csv',
  POINTS_PRELEVEMENT_DEFINITION
)
export const regles = await readDataFromCsvFile(
  'data/regle.csv',
  REGLES_DEFINITION
)
export const documents = await readDataFromCsvFile(
  'data/document.csv',
  DOCUMENTS_DEFINITION
)

export const modalitesSuivis = await readDataFromCsvFile(
  'data/modalite-suivi.csv',
  MODALITES_DEFINITION
)

export const bss = await readDataFromCsvFile(
  'data/bss.csv',
  BSS_DEFINITION
)

export const bnpe = await readDataFromCsvFile(
  'data/bnpe.csv',
  BNPE_DEFINITION
)

export const libellesCommunes = await readDataFromCsvFile(
  'data/commune.csv',
  LIBELLES_DEFINITION
)

export const meContinentalesBv = await readDataFromCsvFile(
  'data/me-continentales-bv.csv',
  ME_CONTINENTALES_BV_DEFINITION
)

export const bvBdCarthage = await readDataFromCsvFile(
  'data/bv-bdcarthage.csv',
  BV_BDCARTHAGE_DEFINITION
)

export const meso = await readDataFromCsvFile(
  'data/meso.csv',
  MESO_DEFINITION
)

export const exploitationsRegles = await loadExploitationsRegles()
export const exploitationsDocuments = await loadExploitationsDocuments()
export const exploitationModalites = await loadExploitationsModalitesSuivis()
export const exploitationsUsage = await loadExploitationsUsage()

/* Decorate exploitations with usages */

for (const exploitation of exploitations) {
  exploitation.usages = exploitationsUsage
    .filter(u => u.id_exploitation === exploitation.id_exploitation)
    .map(u => parseNomenclature(u.id_usage, usages))

  exploitation.usage = exploitation.usages[0]
}

/* Load volumes prélevés in database */

async function loadVolumesPrelevesInDatabase() {
  await mongo.ensureConnected()

  const exploitationsSerie = await loadExploitationsSerie()
  const seriesGroups = groupBy(exploitationsSerie, 'id_serie')

  const resultatsSuivi = await readDataFromCsvFile(
    'data/resultat-suivi.csv',
    RESULTATS_DEFINITION
  )
  const indexedResultats = groupBy(resultatsSuivi, 'id_serie')

  const series = await readDataFromCsvFile(
    'data/serie-donnees.csv',
    SERIES_DEFINITION
  )
  const seriesVolumesPreleves = series.filter(s => s.parametre === 'Volume journalier')

  for (const serie of seriesVolumesPreleves) {
    const exploitationIds = (seriesGroups[serie.id_serie] || []).map(s => s.id_exploitation)
    const resultats = (indexedResultats[serie.id_serie] || [])

    for (const exploitationId of exploitationIds) {
      const volumesPreleves = resultats.map(r => {
        const volume = Number.parseFloat(r.valeur)

        return {
          date: r.date_heure_mesure.slice(0, 10),
          volume: Number.isNaN(volume) ? null : volume,
          remarque: r.remarque
        }
      })

      await insertVolumesPreleves(exploitationId, volumesPreleves)
    }
  }
}

await loadVolumesPrelevesInDatabase()

export const indexedExploitations = keyBy(exploitations, 'id_exploitation')
export const indexedPointsPrelevement = keyBy(pointsPrelevement, 'id_point')
export const indexedBeneficiaires = keyBy(beneficiaires, 'id_beneficiaire')
export const indexedRegles = keyBy(regles, 'id_regle')
export const indexedDocuments = keyBy(documents, 'id_document')
export const indexedModalitesSuivis = keyBy(modalitesSuivis, 'id_modalite')
export const indexedBss = keyBy(bss, 'id_bss')
// Le champ est nommé "code_point_prelevement" mais c'est bien le code bnpe
export const indexedBnpe = keyBy(bnpe, 'code_point_prelevement')
export const indexedLibellesCommunes = keyBy(libellesCommunes, 'insee_com')

export const exploitationsIndexes = {
  beneficiaire: groupBy(exploitations, 'id_beneficiaire'),
  point: groupBy(exploitations, 'id_point')
}

export const indexedMeContinentalesBv = keyBy(meContinentalesBv, 'code_dce')
export const indexedBvBdCarthage = keyBy(bvBdCarthage, 'code_cours')
export const indexedMeso = keyBy(meso, 'code')
