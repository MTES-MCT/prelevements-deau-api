#!/usr/bin/env node
/* eslint-disable no-await-in-loop */
import 'dotenv/config'

import process from 'node:process'
import path from 'node:path'

import {groupBy} from 'lodash-es'

import mongo from '../lib/util/mongo.js'
import {readDataFromCsvFile} from '../lib/import/csv.js'
import {parseString, parseNomenclature, parseDate, parseBoolean, parseNumber} from '../lib/import/generic.js'
import {parametres, unites, frequences, traitements} from '../lib/nomenclature.js'
import {insertVolumesPreleves} from '../lib/models/volume-preleve.js'

if (!process.argv[2]) {
  console.error('Le chemin vers le dossier contenant les données est obligatoire.')
  process.exit(1)
}

const dataPath = path.resolve(process.argv[2])

function getFilePath(fileName) {
  return path.join(dataPath, fileName)
}

await mongo.connect()

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

const exploitationsSerie = await readDataFromCsvFile(getFilePath('exploitation-serie.csv'))
const seriesGroups = groupBy(exploitationsSerie, 'id_serie')

const resultatsSuivi = await readDataFromCsvFile(
  getFilePath('resultat-suivi.csv'),
  RESULTATS_DEFINITION
)
const indexedResultats = groupBy(resultatsSuivi, 'id_serie')

const series = await readDataFromCsvFile(
  getFilePath('serie-donnees.csv'),
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

await mongo.disconnect()
