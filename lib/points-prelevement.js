/* eslint-disable no-await-in-loop */
import fs from 'node:fs/promises'
import {keyBy} from 'lodash-es'
import Papa from 'papaparse'

import {extractGeometry} from './util/extract-geom.js'
import {typesMilieu, usages} from './util/nomenclature.js'

// Loaders
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
const beneficiaires = await loadBeneficiaires()
const exploitations = await loadExploitations()
const pointsPrelevement = await loadPointsPrelevement()
const regles = await loadRegles()
const exploitationsRegles = await loadExploitationsRegles()
const documents = await loadDocuments()
const exploitationModalites = await loadExploitationsModalitesSuivis()
const modalitesSuivis = await loadModalitesSuivis()
const exploitationsUsage = await loadExploitationsUsage()
const exploitationsSerie = await loadExploitationsSerie()
const serieDonnees = await loadSerieDonnees()
const resultatsSuivi = await loadResultatsSuivi()

const indexedExploitations = keyBy(exploitations, 'id_exploitation')
const indexedPointsPrelevement = keyBy(pointsPrelevement, 'id_point')
const indexedBeneficiaires = keyBy(beneficiaires, 'id_beneficiaire')
const indexedRegles = keyBy(regles, 'id_regle')
const indexedDocuments = keyBy(documents, 'id_document')

// Getters
export function getBenificiairesFromPoint(idPoint) {
  const beneficiairesIds = exploitations.filter(e => e.id_point === idPoint)
  const beneficiairesFromPoint = []

  for (const beneficiaireId of beneficiairesIds) {
    const beneficiaire = beneficiaires.find(b => b.id_beneficiaire === beneficiaireId.id_beneficiaire)

    beneficiairesFromPoint.push(beneficiaire)
  }

  return beneficiairesFromPoint
}

export function getBeneficiaireFromExploitationId(idExploitation) {
  return beneficiaires.find(b => b.id_beneficiaire === idExploitation)
}

export function getExploitationFromPoint(idPoint) {
  const exploitationsFromPointIs = exploitations.filter(e => e.id_point === idPoint)

  for (const exploitation of exploitationsFromPointIs) {
    // Importation des règles dans exploitation
    exploitation.regles = exploitationsRegles.filter(r => r.id_exploitation === exploitation.id_exploitation) || []
    exploitation.regles = exploitation.regles.map(r => (
      regles.find(re => re.id_regle === r.id_regle)
    ))

    // Importation des documents dans les règles
    for (const r of exploitation.regles) {
      r.document = documents.find(d => d.id_document === r.id_document) || []
    }

    // Importation des modalités dans exploitation
    exploitation.modalites = exploitationModalites.filter(e => e.id_exploitation === exploitation.id_exploitation) || []
    exploitation.modalites = exploitation.modalites.map(m => (
      modalitesSuivis.find(ms => ms.id_modalite === m.id_modalite)
    ))

    // Importations des usages dans exploitation
    exploitation.usage = exploitationsUsage.find(u => u.id_exploitation === exploitation.id_exploitation).id_usage

    // Importation des séries dans exploitation
    exploitation.series = exploitationsSerie.filter(e => e.id_exploitation === exploitation.id_exploitation) || []
    exploitation.series = exploitation.series.map(s => (
      serieDonnees.find(sd => sd.id_serie === s.id_serie)
    ))

    // Importation des résultats de suivi dans les séries
    for (const s of exploitation.series) {
      s.resultats = resultatsSuivi.filter(rs => rs.id_serie === s.id_serie) || []
    }
  }

  return exploitationsFromPointIs
}

export async function getExploitation(idExploitation) {
  const exploitation = indexedExploitations[idExploitation]

  return exploitation
}

export async function getBeneficiaire(idBeneficiaire) {
  const beneficiaire = indexedBeneficiaires[idBeneficiaire]

  return beneficiaire
}

export async function getRegle(idRegle) {
  const regle = indexedRegles[idRegle]

  return regle
}

export async function getDocument(idDocument) {
  const document = indexedDocuments[idDocument]

  return document
}

export async function getPointsPrelevement() {
  for (const point of pointsPrelevement) {
    point.beneficiaires = getBenificiairesFromPoint(point.id_point)
    point.exploitation = getExploitationFromPoint(point.id_point)
    point.usage = usages[point?.exploitation[0]?.usage]
    point.typeMilieu = typesMilieu[point.type_milieu]
  }

  return pointsPrelevement
}

export async function getPointPrelevement(idPoint) {
  const point = await indexedPointsPrelevement[idPoint]

  point.beneficiaires = getBenificiairesFromPoint(idPoint)
  point.exploitation = getExploitationFromPoint(idPoint)
  point.usage = usages[point?.exploitation[0]?.usage]

  return point
}
