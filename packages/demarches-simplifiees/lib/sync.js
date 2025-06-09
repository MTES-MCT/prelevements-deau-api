import {fetchData} from './graphql/request.js'

export async function * fetchDossiersGenerator(demarcheNumber, {includeChamps = true, cursor = null} = {}) {
  const variables = {
    demarcheNumber,
    first: 100,
    includeDossiers: true,
    includeChamps
  }

  if (cursor) {
    variables.after = cursor
  }

  const {demarche: {dossiers}} = await fetchData('getDemarche', variables)

  for (const dossier of dossiers.nodes) {
    yield dossier
  }

  if (dossiers.pageInfo.hasNextPage) {
    yield * fetchDossiersGenerator(demarcheNumber, {includeChamps, cursor: dossiers.pageInfo.endCursor})
  }
}
