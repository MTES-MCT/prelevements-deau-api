export const DEFAULT_DATASET = 'grivaise-v1'

export const SEED_COMMANDS = Object.freeze(['preflight', 'apply', 'verify'])
export const SEED_TARGETS = Object.freeze(['local', 'demo', 'custom'])

const COMMANDS = new Set(SEED_COMMANDS)
const TARGETS = new Set(SEED_TARGETS)
const OPTIONS_WITH_VALUE = new Map([
  ['--dataset', 'dataset'],
  ['--target', 'target'],
  ['--target-env', 'targetEnv'],
  ['--accounts', 'accounts'],
  ['--target-policy', 'targetPolicy'],
  ['--report', 'report'],
  ['--confirm-target', 'confirmTarget']
])

export const SEED_USAGE = `Usage :
  node scripts/demo/seed-demo.js <preflight|apply|verify> \\
    --dataset ${DEFAULT_DATASET} \\
    --target <local|demo|custom> \\
    --target-env <fichier.env> \\
    --accounts <fichier.json> [options]

Options :
  --target-policy <fichier.json>  Obligatoire uniquement pour une cible custom
  --report <fichier.json>         Rapport JSON expurgé écrit atomiquement en 0600
  --apply                         Autorise les écritures de la commande apply
  --confirm-target <valeur>       Confirmation exacte affichée par le préflight
  --help                          Affiche cette aide

Sans --apply, la commande apply reste une simulation sans écriture.
Les cibles de production sont toujours refusées.`

function readOptionValue(arguments_, index, argument) {
  const separatorIndex = argument.indexOf('=')
  const optionName = separatorIndex === -1 ? argument : argument.slice(0, separatorIndex)
  const inlineValue = separatorIndex === -1 ? undefined : argument.slice(separatorIndex + 1)
  const optionKey = OPTIONS_WITH_VALUE.get(optionName)

  if (!optionKey) {
    return null
  }

  const value = inlineValue ?? arguments_[index + 1]
  if (!value || (inlineValue === undefined && value.startsWith('--'))) {
    throw new Error(`Option ${optionName} attend une valeur`)
  }

  return {
    optionKey,
    value,
    consumedNextArgument: inlineValue === undefined
  }
}

function assertRequiredOptions(options) {
  if (!options.command) {
    throw new Error(`Commande attendue : ${SEED_COMMANDS.join(', ')}`)
  }

  if (!options.target) {
    throw new Error('--target est requis')
  }

  if (!TARGETS.has(options.target)) {
    throw new Error(`Cible invalide : ${options.target}; utiliser ${SEED_TARGETS.join(', ')}`)
  }

  if (!options.targetEnv) {
    throw new Error('--target-env est requis')
  }

  if (!options.accounts) {
    throw new Error('--accounts est requis')
  }

  if (options.dataset !== DEFAULT_DATASET) {
    throw new Error(`Jeu de données non supporté : ${options.dataset}`)
  }

  if (options.target === 'custom' && !options.targetPolicy) {
    throw new Error('--target-policy est requis pour une cible custom')
  }

  if (options.target !== 'custom' && options.targetPolicy) {
    throw new Error('--target-policy est réservé à la cible custom')
  }

  if (options.apply && options.command !== 'apply') {
    throw new Error('--apply est réservé à la commande apply')
  }

  if (options.confirmTarget && (!options.apply || options.command !== 'apply')) {
    throw new Error('--confirm-target exige la commande apply avec --apply')
  }

  if (options.apply && options.target !== 'local' && !options.report) {
    throw new Error('--report est requis pour une application hors local')
  }
}

export function parseArguments(arguments_) {
  const options = {
    command: undefined,
    dataset: DEFAULT_DATASET,
    target: undefined,
    targetEnv: undefined,
    accounts: undefined,
    targetPolicy: undefined,
    report: undefined,
    apply: false,
    confirmTarget: undefined,
    help: false
  }
  const seenOptions = new Set()

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]

    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }

    if (!options.command && COMMANDS.has(argument)) {
      options.command = argument
      continue
    }

    if (argument === '--apply') {
      if (options.apply) {
        throw new Error('Option dupliquée : --apply')
      }

      options.apply = true
      continue
    }

    const parsedOption = readOptionValue(arguments_, index, argument)
    if (parsedOption) {
      if (seenOptions.has(parsedOption.optionKey)) {
        throw new Error(`Option dupliquée : ${argument.split('=')[0]}`)
      }

      seenOptions.add(parsedOption.optionKey)
      options[parsedOption.optionKey] = parsedOption.value
      if (parsedOption.consumedNextArgument) {
        index += 1
      }

      continue
    }

    if (argument.startsWith('--')) {
      throw new Error(`Option inconnue : ${argument}`)
    }

    if (COMMANDS.has(argument)) {
      throw new Error(`Commande dupliquée : ${argument}`)
    }

    throw new Error(`Argument inattendu : ${argument}`)
  }

  if (!options.help) {
    assertRequiredOptions(options)
  }

  return options
}
