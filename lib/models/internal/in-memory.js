
import fs from 'node:fs/promises'
import {keyBy} from 'lodash-es'
import Papa from 'papaparse'

import {extractGeometry} from '../../util/extract-geom.js'

async function loadPointsPrelevement() {
  const csvContent = await fs.readFile('data/point-prelevement.csv', 'utf8')
  const {data: rows} = Papa.parse(csvContent, {header: true, skipEmptyLines: true})

  return rows.map(row => {
    const geom = extractGeometry(row.geom)

    return {
      ...row,
      geom
    }
  })
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
export const pointsPrelevement = await loadPointsPrelevement()
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
