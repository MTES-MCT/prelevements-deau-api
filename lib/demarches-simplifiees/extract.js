/* eslint-disable complexity, unicorn/numeric-separators-style */
import {set, kebabCase} from 'lodash-es'

import {DESCRIPTORS_MAPPING} from './champs.js'

const IGNORED_TYPES = new Set([
  'HeaderSectionChampDescriptor',
  'ExplicationChampDescriptor'
])

function getId(champ) {
  return champ.champDescriptorId || champ.id
}

const OVERRIDES = {
  17792570: {numeroArreteAot: '2017-094'},
  18230367: {anneePrelevement: '2023'},
  18503570: {numeroArreteAot: '2024-026'},
  19011918: {numeroArreteAot: '2022-063'}
}

function extractDataFromChamps(champs, context) {
  const {dossierNumber} = context
  const result = {}

  const definitions = context.definitions || DESCRIPTORS_MAPPING

  for (const champ of champs) {
    if (IGNORED_TYPES.has(champ.__typename)) {
      continue
    }

    const definition = definitions[getId(champ)]

    // Override some values
    const overrideEntry = OVERRIDES[dossierNumber]

    if (overrideEntry && definition?.target && definition.target in overrideEntry) {
      set(result, definition.target, overrideEntry[definition.target])
      continue
    }

    const value = parseChamp(champ, {definition, dossierNumber: context.dossierNumber})

    if (value !== undefined) {
      set(result, definition.target, value)
    }
  }

  return result
}

function parseChamp(champ, {definition, dossierNumber}) {
  if (!definition) {
    throw new Error(`Champ descriptor ${getId(champ)} is not defined`)
  }

  if (definition.type === 'ignore') {
    return
  }

  // Special case: array + string
  if (definition.array && definition.type === 'string' && champ.values) {
    return champ.values.map(value => parseChamp({stringValue: value}, {definition, dossierNumber}))
  }

  if (definition.array && definition.type === 'object') {
    return champ.rows.map(row => extractDataFromChamps(row.champs, {
      definitions: definition.itemDefinition,
      dossierNumber
    }))
  }

  if (definition.parse) {
    return definition.parse(champ.stringValue)
  }

  if (definition.type === 'string') {
    return (champ.stringValue && champ.stringValue.trim()) || null
  }

  if (definition.type === 'enum') {
    if (!(champ.stringValue in definition.valuesMapping)) {
      throw new Error(`Champ descriptor ${getId(champ)} has an unknown value ${champ.stringValue}`)
    }

    return definition.valuesMapping[champ.stringValue]
  }

  if (definition.type === 'file') {
    if (champ.files.length === 0) {
      return null
    }

    if (champ.files.length > 1) {
      throw new Error(`Champ descriptor ${getId(champ)} has more than one file`)
    }

    return champ.files[0]
  }

  if (definition.type === 'boolean') {
    return champ.stringValue === 'true'
  }

  if (definition.type === 'integer') {
    const value = Number.parseInt(champ.stringValue, 10)

    if (Number.isNaN(value)) {
      console.log(`Champ descriptor ${getId(champ)} has an invalid integer value ${champ.stringValue}`)
      return
    }

    return value
  }

  if (definition.type === 'float') {
    const value = Number.parseFloat(champ.stringValue)

    if (Number.isNaN(value)) {
      throw new TypeError(`Champ descriptor ${getId(champ)} has an invalid float value ${champ.stringValue}`)
    }

    return value
  }

  if (definition.type === 'date') {
    return champ.date
  }

  throw new Error(`Champ descriptor ${getId(champ)} has an unknown type ${definition.type}`)
}

export function normalizeDossier(dossier) {
  const result = {...dossier}

  if (result.moisCalendairePrelevementsDeclares && result.anneePrelevement) {
    result.moisDeclaration = `${result.anneePrelevement}-${result.moisCalendairePrelevementsDeclares}`
    delete result.moisCalendairePrelevementsDeclares
    delete result.anneePrelevement
  }

  if (result.anneePrelevement) {
    result.moisDebutDeclaration = `${result.anneePrelevement}-01`
    result.moisFinDeclaration = `${result.anneePrelevement}-12`
    delete result.anneePrelevement
  }

  if (result.dateDebutSaisie) {
    result.moisDebutDeclaration = result.dateDebutSaisie.slice(0, 7)
    result.moisFinDeclaration = result.dateFinSaisie.slice(0, 7)
    delete result.dateDebutSaisie
    delete result.dateFinSaisie
  }

  switch (result.typePrelevement) {
    case 'autre': {
      result.typeDonnees = result.relevesIndex && result.relevesIndex.length > 0
        ? 'saisie-manuelle'
        : 'vide'
      break
    }

    case 'camion-citerne': {
      result.typeDonnees = (result.volumesPompes?.length > 0 || result.registrePrelevementsTableur || result.tableauSuiviPrelevements)
        ? 'tableur'
        : 'vide'
      break
    }

    case 'aep-zre': {
      result.typeDonnees = result.donneesPrelevements?.some(d => d.fichier)
        ? 'tableur'
        : 'vide'
      break
    }

    case 'icpe-hors-zre': {
      result.typeDonnees = result.donneesPrelevements?.length > 0
        ? 'tableur'
        : 'vide'
      break
    }

    default: {
      result.typeDonnees = 'vide'
    }
  }

  return result
}

export function extractDossier(dossier) {
  const dossierNumber = dossier.number

  const result = {
    number: dossierNumber,
    status: kebabCase(dossier.state),
    usager: dossier.usager,
    demandeur: dossier.demandeur,
    dateDepot: dossier.dateDepot,
    dateTraitement: dossier.dateTraitement,
    deposeParUnTiers: dossier.deposeParUnTiers
  }

  const extractedAttributes = extractDataFromChamps(dossier.champs, {dossierNumber})

  return normalizeDossier({
    ...result,
    ...extractedAttributes
  })
}
