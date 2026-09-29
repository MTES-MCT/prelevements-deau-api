import process from 'node:process'
import {pathToFileURL} from 'node:url'
import {createEnvironmentDeployment} from './ci-environment-deploy.js'

export const PROD = Object.freeze({
  projectId: '8b2f67a8-b474-4596-967f-fe1e0adba1b3',
  namespaceId: 'fa4179ac-8658-4440-963b-66d669a452d5',
  namespaceName: 'prod-partageons-leau',
  privateNetworkId: '3a4a5621-4e6a-4195-b202-af3fc351e81c',
  vpcId: 'cdee708c-cc94-4a7b-a8cd-6307173d38ac',
  apiId: 'e14e4839-6b22-4483-9ce1-dc972e469025',
  workerId: '5034a60c-20f3-4ba4-af85-168dfe5b2037',
  registry: 'rg.fr-par.scw.cloud/prelevements-deau-api/prelevements-deau-api',
  migrationNamespaceName: 'prod-partageons-leau-migrations',
  migrationName: 'prod-api-migrations'
})

const {readConfiguration: readProdConfiguration, deploy: deployProd} = createEnvironmentDeployment({
  environmentName: 'prod',
  resources: PROD,
  migrationCommand: ['node', 'scripts/network/prod-migration-service.js'],
  apiName: 'prod-prelevement-deau-api',
  workerName: 'prod-partageons-leau-api-workers'
})

export {readProdConfiguration, deployProd}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await deployProd(readProdConfiguration(process.env))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
