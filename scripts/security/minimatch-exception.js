// Temporary, explicit exception for the locked legacy dependency paths only.
// 2026-11-08 23:00 UTC is 2026-11-09 00:00 Europe/Paris.
export const MINIMATCH_EXCEPTION = Object.freeze({
  packageName: 'minimatch', version: '3.1.5 / 5.1.9', developmentOnly: false,
  advisoryUrl: 'https://github.com/advisories/GHSA-g3hv-75wg-m249',
  expiresAt: '2026-11-08T23:00:00Z'
})

const PATHS = {
  '@rollup/plugin-commonjs': {'nodes':[['node_modules/@rollup/plugin-commonjs','22.0.2',true]],'via':['glob']},
  '@stoplight/spectral-cli': {'nodes':[['node_modules/@stoplight/spectral-cli','6.16.3',true]],'via':['@stoplight/spectral-core','@stoplight/spectral-formatters','@stoplight/spectral-ruleset-bundler']},
  '@stoplight/spectral-core': {'nodes':[['node_modules/@stoplight/spectral-core','1.23.1',true]],'via':['minimatch']},
  '@stoplight/spectral-formats': {'nodes':[['node_modules/@stoplight/spectral-formats','1.8.5',true]],'via':['@stoplight/spectral-core']},
  '@stoplight/spectral-formatters': {'nodes':[['node_modules/@stoplight/spectral-formatters','1.5.1',true]],'via':['@stoplight/spectral-core']},
  '@stoplight/spectral-functions': {'nodes':[['node_modules/@stoplight/spectral-functions','1.10.5',true]],'via':['@stoplight/spectral-core','@stoplight/spectral-formats']},
  '@stoplight/spectral-ruleset-bundler': {'nodes':[['node_modules/@stoplight/spectral-ruleset-bundler','1.7.0',true]],'via':['@rollup/plugin-commonjs','@stoplight/spectral-core','@stoplight/spectral-formats']},
  '@stoplight/spectral-ruleset-migrator': {'nodes':[['node_modules/@stoplight/spectral-ruleset-migrator','1.12.1',true]],'via':['@stoplight/spectral-functions']},
  '@stoplight/spectral-rulesets': {'nodes':[['node_modules/@stoplight/spectral-rulesets','1.22.6',true]],'via':['@stoplight/spectral-core','@stoplight/spectral-formats','@stoplight/spectral-functions']},
  'archiver': {'nodes':[['node_modules/archiver','5.3.2',false]],'via':['archiver-utils','readdir-glob','zip-stream']},
  'archiver-utils': {'nodes':[['node_modules/archiver-utils','2.1.0',false],['node_modules/zip-stream/node_modules/archiver-utils','3.0.4',false]],'via':['glob']},
  'exceljs': {'nodes':[['node_modules/exceljs','4.4.0',false]],'via':['archiver']},
  'glob': {'nodes':[['node_modules/glob','7.2.3',false]],'via':['minimatch']},
  'minimatch': {'nodes':[['node_modules/minimatch','3.1.5',false],['node_modules/readdir-glob/node_modules/minimatch','5.1.9',false]],'via':[]},
  'readdir-glob': {'nodes':[['node_modules/readdir-glob','1.1.3',false]],'via':['minimatch']},
  'rimraf': {'nodes':[['node_modules/rimraf','2.7.1',false]],'via':['glob']},
  'zip-stream': {'nodes':[['node_modules/zip-stream','4.1.1',false]],'via':['archiver-utils']}
}

function matchesMinimatchAdvisory(via) {
  const [advisory] = via
  return via.length === 1 && advisory !== null && typeof advisory === 'object'
    && advisory.source === 1244012 && advisory.name === 'minimatch' && advisory.dependency === 'minimatch'
    && advisory.url === MINIMATCH_EXCEPTION.advisoryUrl && advisory.severity === 'moderate'
    && advisory.range === '<11.0.1'
}

export function isTemporaryMinimatchPath(name, report, lockfile, now, visiting = new Set()) {
  if (!Number.isFinite(Number(now)) || Number(now) >= Date.parse(MINIMATCH_EXCEPTION.expiresAt)
    || visiting.has(name) || !Object.hasOwn(PATHS, name) || !Object.hasOwn(report.vulnerabilities, name)) return false
  const expected = PATHS[name]
  const vulnerability = report.vulnerabilities[name]
  if (vulnerability.severity !== 'moderate' || vulnerability.nodes.length !== expected.nodes.length
    || new Set(vulnerability.nodes).size !== expected.nodes.length
    || !vulnerability.nodes.every(node => {
      const approved = expected.nodes.find(([path]) => path === node)
      const installed = lockfile.packages[node]
      return approved && installed?.version === approved[1] && (installed.dev === true) === approved[2]
    })) return false
  if (name === 'minimatch') return matchesMinimatchAdvisory(vulnerability.via)
  const next = new Set([...visiting, name])
  return vulnerability.via.length === expected.via.length && new Set(vulnerability.via).size === expected.via.length
    && vulnerability.via.every(dependency => typeof dependency === 'string' && expected.via.includes(dependency)
      && isTemporaryMinimatchPath(dependency, report, lockfile, now, next))
}
