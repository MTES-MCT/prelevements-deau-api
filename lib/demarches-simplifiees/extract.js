/* eslint-disable complexity */
import {set} from 'lodash-es'

import {DESCRIPTORS_MAPPING} from './champs.js'

const IGNORED_TYPES = new Set([
  'HeaderSectionChampDescriptor',
  'ExplicationChampDescriptor'
])

function getId(champ) {
  return champ.champDescriptorId || champ.id
}

export function extractFromChamps(champs, definitions = DESCRIPTORS_MAPPING) {
  const result = {}

  for (const champ of champs) {
    if (IGNORED_TYPES.has(champ.__typename)) {
      continue
    }

    const definition = definitions[getId(champ)]

    const value = parseChamp(champ, definition)

    if (value !== undefined) {
      set(result, definition.target, value)
    }
  }

  return result
}

function parseChamp(champ, definition) {
  if (!definition) {
    console.log(champ)
    throw new Error(`Champ descriptor ${getId(champ)} is not defined`)
  }

  if (definition.type === 'ignore') {
    return
  }

  // Special case: array + string
  if (definition.array && definition.type === 'string' && champ.values) {
    return champ.values.map(value => parseChamp({stringValue: value}, definition))
  }

  if (definition.array && definition.type === 'object') {
    return champ.rows.map(row => extractFromChamps(row.champs, definition.itemDefinition))
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
      throw new TypeError(`Champ descriptor ${getId(champ)} has an invalid integer value ${champ.stringValue}`)
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
