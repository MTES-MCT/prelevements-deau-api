import test from 'ava'
import {spawn} from 'node:child_process'
import {mkdtemp, writeFile, rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {readTargetEnvironment} from '../target-environment.js'

test('la configuration cible conserve la lecture des fichiers privés', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dropt-target-env-'))
  t.teardown(() => rm(directory, {recursive: true, force: true}))
  const filename = path.join(directory, 'synthetic.env')
  await writeFile(filename, 'DATABASE_URL="postgresql://synthetic.invalid/example"\nMULTIPLE_EXPLOITATIONS_ENABLED=true\n', {mode: 0o600})
  t.deepEqual(await readTargetEnvironment(filename), {DATABASE_URL: 'postgresql://synthetic.invalid/example', MULTIPLE_EXPLOITATIONS_ENABLED: 'true'})
})

test('la configuration cible lit le descripteur hérité sans rouvrir son chemin proc', async t => {
  const moduleUrl = new URL('../target-environment.js', import.meta.url).href
  const script = `import {readTargetEnvironment} from ${JSON.stringify(moduleUrl)};
    const value = await readTargetEnvironment('/proc/self/fd/3');
    if (value.DATABASE_URL !== 'postgresql://synthetic.invalid/example' || value.MULTIPLE_EXPLOITATIONS_ENABLED !== 'false') process.exitCode = 1;`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {stdio: ['ignore', 'pipe', 'pipe', 'pipe']})
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdio[3].on('error', () => {})
  child.stdio[3].end('DATABASE_URL=postgresql://synthetic.invalid/example\nMULTIPLE_EXPLOITATIONS_ENABLED=false\n')
  const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  t.is(status, 0, stderr)
  t.is(stdout, '')
})

test('les descripteurs standard ne peuvent pas être consommés comme configuration privée', async t => {
  for (const descriptor of ['0', '1', '2']) {
    await t.throwsAsync(readTargetEnvironment(`/proc/self/fd/${descriptor}`), {message: 'Descripteur privé de configuration cible invalide.'})
  }
})
