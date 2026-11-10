import {execFileSync} from 'node:child_process'
import {parseVersion} from './clamd.mjs'

const output = execFileSync('clamd', ['--version'], {encoding: 'utf8'}).trim()
console.log(JSON.stringify(parseVersion(output)))
