import {buildGrivaiseDataset as buildDataset} from '../../lib/grivaise-dataset.js'

// Test anchors are synthetic. Tests never depend on the private data submodule.
const historicalPointsUrl = new URL('../fixtures/synthetic-location-anchors.csv', import.meta.url)

export function buildGrivaiseDataset() {
  return buildDataset({historicalPointsUrl})
}
