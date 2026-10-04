import {constants} from 'node:fs'
import {access, lstat, open, realpath} from 'node:fs/promises'
import path from 'node:path'

async function assertPrivateDirectory(directory) {
  const resolved = await realpath(directory)
  const info = await lstat(resolved)
  if (!info.isDirectory() || (info.mode & 0o077)) throw new Error('PRIVATE_DIRECTORY_REQUIRED')
  let current = resolved
  while (true) {
    try {
      await access(path.join(current, '.git'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('PRIVATE_PATH_UNVERIFIABLE', {cause: error})
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
      continue
    }
    throw new Error('PRIVATE_FILE_INSIDE_GIT')
  }
  return resolved
}

export async function readPrivateFile(filename) {
  if (!path.isAbsolute(filename)) throw new Error('PRIVATE_PATH_MUST_BE_ABSOLUTE')
  await assertPrivateDirectory(path.dirname(filename))
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || (info.mode & 0o077)) throw new Error('PRIVATE_FILE_MODE_REQUIRED')
    if (info.size > 1_000_000) throw new Error('PRIVATE_FILE_TOO_LARGE')
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

export async function reservePrivateReport(filename) {
  if (!path.isAbsolute(filename)) throw new Error('PRIVATE_PATH_MUST_BE_ABSOLUTE')
  const directory = await assertPrivateDirectory(path.dirname(filename))
  const handle = await open(path.join(directory, path.basename(filename)), 'wx', 0o600)
  return {
    async write(report) {
      const text = `${JSON.stringify(report, null, 2)}\n`
      await handle.truncate(0)
      await handle.write(text, 0, 'utf8')
      await handle.sync()
      return text
    },
    close: () => handle.close()
  }
}
