import {readFile} from 'node:fs'
import {parseEnv, promisify} from 'node:util'

const read = promisify(readFile)

export async function readTargetEnvironment(filename) {
  const match = /^\/proc\/self\/fd\/(\d+)$/.exec(filename)
  const descriptor = match ? Number(match[1]) : undefined
  if (match && (!Number.isSafeInteger(descriptor) || descriptor < 3)) {
    throw new Error('Descripteur privé de configuration cible invalide.')
  }
  // Read the descriptor directly: Node child stdio may use sockets, whose
  // /proc paths cannot be reopened as ordinary files.
  return parseEnv(await read(match ? descriptor : filename, 'utf8'))
}
