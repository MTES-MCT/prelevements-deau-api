import process from 'node:process'
import {pathToFileURL} from 'node:url'
import {createEnvironmentDeployment} from './ci-environment-deploy.js'

export const DEMO = Object.freeze({
  projectId: '8b2f67a8-b474-4596-967f-fe1e0adba1b3',
  namespaceId: 'c90182ec-fb81-4fca-ad36-0e37ce351466',
  namespaceName: 'demo-partageons-leau',
  privateNetworkId: 'a600027e-6936-4538-acd7-3f2860113fc3',
  vpcId: '08c7f480-5428-40fb-889c-525755061d84',
  apiId: 'd49a3dc0-7ee8-4777-9408-067540bb601b',
  workerId: '383f440d-12b5-452e-8be3-a6c0c84e639b',
  registry: 'rg.fr-par.scw.cloud/prelevements-deau-api/prelevements-deau-api',
  migrationNamespaceName: 'demo-partageons-leau-migrations',
  migrationName: 'demo-api-migrations'
})

const {readConfiguration: readDemoConfiguration, deploy: deployDemo} = createEnvironmentDeployment({
  environmentName: 'demo',
  resources: DEMO,
  migrationCommand: ['node', 'scripts/network/migration-service.js'],
  apiName: 'demo-prelevement-deau-api',
  workerName: 'demo-prelevement-deau-api-worker'
})

export {readDemoConfiguration, deployDemo}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await deployDemo(readDemoConfiguration(process.env))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
