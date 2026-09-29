import process from 'node:process'
import {pathToFileURL} from 'node:url'
import {createEnvironmentDeployment} from './ci-environment-deploy.js'

export const TESTING = Object.freeze({
  projectId: '8b2f67a8-b474-4596-967f-fe1e0adba1b3',
  namespaceId: 'bfb37e50-4bd4-42dc-94ca-2064f8b46898',
  namespaceName: 'testing-partageons-leau',
  privateNetworkId: '106f8ec1-1be9-4f0e-826b-a9fdcc157319',
  vpcId: '7403f50f-fcc0-4a98-bbb4-733e4ca316a7',
  apiId: '1b950c5c-6318-4f93-b6b6-63ef5b96954d',
  workerId: '97584187-27a0-4cc5-8403-473b6df383a4',
  registry: 'rg.fr-par.scw.cloud/prelevements-deau-api/prelevements-deau-api',
  migrationNamespaceName: 'testing-partageons-leau-migrations',
  migrationName: 'testing-api-migrations'
})

const {readConfiguration: readTestingConfiguration, deploy: deployTesting} = createEnvironmentDeployment({
  environmentName: 'testing',
  resources: TESTING,
  migrationCommand: ['node', 'scripts/network/testing-migration-service.js'],
  apiName: 'testing-prelevement-deau-api',
  workerName: 'testing-prelevement-deau-api-worke',
  // Preserve testing's existing rollout probes and worker command; demo/prod remain image-only.
  apiPatch: {
    liveness_probe: {http: {path: '/healthz'}, interval: '10s', timeout: '2s', failure_threshold: 5},
    startup_probe: {http: {path: '/healthz'}, interval: '5s', timeout: '2s', failure_threshold: 30}
  },
  workerPatch: {command: ['node', 'worker.js']}
})

export {readTestingConfiguration, deployTesting}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await deployTesting(readTestingConfiguration(process.env))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
