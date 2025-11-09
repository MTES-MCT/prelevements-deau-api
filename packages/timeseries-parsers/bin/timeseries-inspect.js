#!/usr/bin/env node

import {readFile} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import yargs from 'yargs'
import {hideBin} from 'yargs/helpers'
import {extractCamionCiterne, extractMultiParamFile} from '../index.js'

const PARSER_TYPES = {
  'camion-citerne': extractCamionCiterne,
  'multi-params': extractMultiParamFile
}

function displayErrors(errors) {
  if (!errors || errors.length === 0) {
    return
  }

  const errorList = errors.filter(e => e.severity === 'error')
  const warnings = errors.filter(e => e.severity === 'warning')

  if (errorList.length > 0) {
    console.log('❌ ERREURS:')
    for (const error of errorList) {
      console.log(`   • ${error.message}`)
      if (error.explanation) {
        console.log(`     → ${error.explanation}`)
      }
    }

    console.log()
  }

  if (warnings.length > 0) {
    console.log('⚠️  AVERTISSEMENTS:')
    for (const warning of warnings) {
      console.log(`   • ${warning.message}`)
      if (warning.explanation) {
        console.log(`     → ${warning.explanation}`)
      }
    }

    console.log()
  }
}

function displaySerieInfo(serie, index) {
  console.log(`\n📊 Série #${index + 1}`)
  console.log('─'.repeat(80))

  if (serie.pointPrelevement) {
    console.log(`   Point de prélèvement: ${serie.pointPrelevement}`)
  }

  console.log(`   Paramètre:            ${serie.parameter}`)
  console.log(`   Unité:                ${serie.unit}`)
  console.log(`   Fréquence:            ${serie.frequency}`)
  console.log(`   Type de valeur:       ${serie.valueType}`)

  if (serie.originalFrequency) {
    console.log(`   Fréquence d'origine:  ${serie.originalFrequency} (expansé en ${serie.frequency})`)
  }

  console.log(`   Date min:             ${serie.minDate}`)
  console.log(`   Date max:             ${serie.maxDate}`)
  console.log(`   Nombre de valeurs:    ${serie.data.length}`)

  if (serie.extras) {
    console.log('   Informations complémentaires:')
    if (serie.extras.detailPointSuivi) {
      console.log(`     • Détail point suivi: ${serie.extras.detailPointSuivi}`)
    }

    if (typeof serie.extras.profondeur === 'number') {
      console.log(`     • Profondeur: ${serie.extras.profondeur} m`)
    }

    if (serie.extras.commentaire) {
      console.log(`     • Commentaire: ${serie.extras.commentaire}`)
    }
  }

  displayDataSample(serie.data)
}

function displayDataSample(data) {
  if (data.length === 0) {
    return
  }

  console.log('   Échantillon de données:')
  const sampleSize = Math.min(3, data.length)
  for (let i = 0; i < sampleSize; i++) {
    const dataPoint = data[i]
    let line = `     • ${dataPoint.date}`
    if (dataPoint.time) {
      line += ` ${dataPoint.time}`
    }

    line += `: ${dataPoint.value}`

    if (dataPoint.remark) {
      line += ` (remarque: ${dataPoint.remark})`
    }

    if (dataPoint.originalValue !== undefined) {
      line += ` [original: ${dataPoint.originalValue}]`
    }

    console.log(line)
  }

  if (data.length > sampleSize) {
    console.log(`     ... et ${data.length - sampleSize} autre(s) valeur(s)`)
  }
}

function displaySeries(series) {
  console.log(`✅ ${series.length} série(s) extraite(s):\n`)
  console.log('═'.repeat(80))

  for (const [index, serie] of series.entries()) {
    displaySerieInfo(serie, index)
  }

  console.log('\n' + '═'.repeat(80) + '\n')
}

async function listSeries(filePath, parserType) {
  const absolutePath = path.resolve(filePath)

  console.log(`\n📁 Fichier: ${absolutePath}`)
  console.log(`🔧 Type de parser: ${parserType}\n`)

  const buffer = await readFile(absolutePath)
  const parser = PARSER_TYPES[parserType]

  if (!parser) {
    throw new Error(`Type de parser invalide: ${parserType}. Types supportés: ${Object.keys(PARSER_TYPES).join(', ')}`)
  }

  const result = await parser(buffer)

  displayErrors(result.errors)

  if (!result.data || !result.data.series || result.data.series.length === 0) {
    console.log('⚠️  Aucune série n\'a pu être extraite du fichier.\n')
    return
  }

  displaySeries(result.data.series)
}

// CLI
yargs(hideBin(process.argv))
  .command(
    '$0 <file>',
    'Lister les séries temporelles extraites d\'un fichier',
    yargs => {
      yargs.positional('file', {
        describe: 'Chemin vers le fichier à analyser',
        type: 'string',
        demandOption: true
      })
      yargs.option('type', {
        alias: 't',
        describe: 'Type de parser à utiliser',
        choices: Object.keys(PARSER_TYPES),
        demandOption: true
      })
    },
    async argv => {
      try {
        await listSeries(argv.file, argv.type)
      } catch (error) {
        console.error(`\n❌ Erreur: ${error.message}\n`)
        process.exit(1)
      }
    }
  )
  .help()
  .alias('help', 'h')
  .version(false)
  .strict()
  .parse()
