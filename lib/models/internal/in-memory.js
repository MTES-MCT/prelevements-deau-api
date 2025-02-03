/* eslint-disable camelcase */
import fs from 'node:fs/promises'
import {keyBy} from 'lodash-es'
import Papa from 'papaparse'

import {extractGeometry} from '../../util/extract-geom.js'
import {typesMilieu, statutsExploitation, parametres, unites, contraintes, natures, frequences, traitements} from '../../nomenclature.js'

/* Parsers */

function parseString(value) {
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function parseNumber(value) {
  return value === '' ? undefined : Number(value)
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
    autres_noms: {drop: true},
    code_bnpe: {parse: parseString},
    id_bss: {parse: parseString},
    code_aiot: {parse: parseString},
    type_milieu: {parse: value => typesMilieu[value] || null},
    profondeur: {parse: parseNumber},
    zre: {parse: parseString},
    reservoir_biologique: {parse: parseString},
    insee_com: {parse: parseString},
    code_bdlisa: {parse: parseString},
    code_meso: {parse: parseString},
    code_bv_bdcarthage: {parse: parseString},
    code_me_continentales_bv: {parse: parseString},
    cours_eau: {parse: parseString},
    detail_localisation: {parse: parseString},
    geom: {parse: extractGeometry},
    precision_geom: {drop: true},
    remarque: {parse: parseString}
  },
  requiredFields: ['id_point', 'nom', 'geom']
}

async function loadExploitations() {
  const csvContent = await fs.readFile('data/exploitation.csv', 'utf8')
  const {data: rows} = Papa.parse(csvContent, {header: true, skipEmptyLines: true})

  return rows
}

async function loadBeneficiaires() {
  const csvContent = await fs.readFile('data/beneficiaire.csv', 'utf8')
  const {data: rows} = Papa.parse(csvContent, {header: true, skipEmptyLines: true})

  return rows
}

async function loadRegles() {
  const csvContent = await fs.readFile('data/regle.csv', 'utf8')
  const {data: rows} = Papa.parse(csvContent, {header: true, skipEmptyLines: true})

  return rows
}

async function loadExploitationsRegles() {
  const csvContent = await fs.readFile('data/exploitation-regle.csv', 'utf8')
  const {data: rows} = Papa.parse(csvContent, {header: true, skipEmptyLines: true})

  return rows
}

async function loadDocuments() {
  const csvContent = await fs.readFile('data/document.csv', 'utf8')
  const {data: rows} = Papa.parse(csvContent, {header: true, skipEmptyLines: true})

  return rows
}

async function loadExploitationsModalitesSuivis() {
  const csvContent = await fs.readFile('data/exploitation-modalite-suivi.csv', 'utf8')
  const {data: rows} = Papa.parse(csvContent, {header: true, skipEmptyLines: true})

  return rows
}

async function loadModalitesSuivis() {
  const csvContent = await fs.readFile('data/modalite-suivi.csv', 'utf8')
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

async function loadSerieDonnees() {
  const csvContent = await fs.readFile('data/serie-donnees.csv', 'utf8')
  const {data: rows} = Papa.parse(csvContent, {header: true, skipEmptyLines: true})

  return rows
}

async function loadResultatsSuivi() {
  const csvContent = await fs.readFile('data/resultat-suivi.csv', 'utf8')
  const {data: rows} = Papa.parse(csvContent, {header: true, skipEmptyLines: true})

  return rows
}

// Initialisation
export const beneficiaires = await loadBeneficiaires()
export const exploitations = await loadExploitations()
export const pointsPrelevement = await readDataFromCsvFile(
  'data/point-prelevement.csv',
  POINTS_PRELEVEMENT_DEFINITION
)
export const regles = await loadRegles()
export const exploitationsRegles = await loadExploitationsRegles()
export const documents = await loadDocuments()
export const exploitationModalites = await loadExploitationsModalitesSuivis()
export const modalitesSuivis = await loadModalitesSuivis()
export const exploitationsUsage = await loadExploitationsUsage()
export const exploitationsSerie = await loadExploitationsSerie()
export const serieDonnees = await loadSerieDonnees()
export const resultatsSuivi = await loadResultatsSuivi()

export const indexedExploitations = keyBy(exploitations, 'id_exploitation')
export const indexedPointsPrelevement = keyBy(pointsPrelevement, 'id_point')
export const indexedBeneficiaires = keyBy(beneficiaires, 'id_beneficiaire')
export const indexedRegles = keyBy(regles, 'id_regle')
export const indexedDocuments = keyBy(documents, 'id_document')
export const indexedModalitesSuivis = keyBy(modalitesSuivis, 'id_modalite')
export const indexedSeriesDonnees = keyBy(serieDonnees, 'id_serie')
