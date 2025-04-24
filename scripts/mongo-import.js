import chain from 'lodash-es'
import mongo from '../lib/util/mongo.js'
import * as storage from '../lib/models/internal/in-memory.js'
import {
  getDocumentFromExploitationId,
  getExploitationsFromPointId,
  getModalitesFromExploitationId,
  getReglesFromExploitationId
} from '../lib/models/exploitation.js'

await mongo.connect()

async function preparePoint(pointId) {
  const point = storage.indexedPointsPrelevement[pointId]

  point.bss = point.id_bss ? ({
    id_bss: storage.indexedBss[point.id_bss].id_bss,
    lien: storage.indexedBss[point.id_bss].lien_infoterre
  }) : null

  delete point.id_bss

  point.bnpe = point.code_bnpe ? ({
    point: storage.indexedBnpe[point.code_bnpe]?.code_point_prelevement,
    lien: storage.indexedBnpe[point.code_bnpe]?.uri_ouvrage
  }) : null

  delete point.code_bnpe

  point.meso = point.code_meso ? ({
    code: storage.indexedMeso[point.code_meso].code,
    nom: storage.indexedMeso[point.code_meso].nom_provis
  }) : null

  delete point.code_meso

  point.meContinentalesBv = point.code_me_continentales_bv ? ({
    code: storage.indexedMeContinentalesBv[point.code_me_continentales_bv].code_dce,
    nom: storage.indexedMeContinentalesBv[point.code_me_continentales_bv].nom
  }) : null

  delete point.code_me_continentales_bv

  point.bvBdCarthage = point.code_bv_bdcarthage ? ({
    code: storage.indexedBvBdCarthage[point.code_bv_bdcarthage].code_cours,
    nom: storage.indexedBvBdCarthage[point.code_bv_bdcarthage].toponyme_t
  }) : null

  delete point.code_bv_bdcarthage

  point.commune = point.insee_com ? ({
    code: point.insee_com,
    nom: storage.indexedLibellesCommunes[point.insee_com].nom
  }) : null

  delete point.insee_com

  return point
}

async function prepareExploitation(idExploitation) {
  const exploitation = storage.indexedExploitations[idExploitation]

  exploitation.regles = await getReglesFromExploitationId(idExploitation)
  exploitation.documents = await getDocumentFromExploitationId(idExploitation)
  exploitation.modalites = await getModalitesFromExploitationId(idExploitation)

  delete exploitation.usage

  return exploitation
}

async function importPoints() {
  console.log('\n\u001B[35;1;4m%s\u001B[0m', '=> Importation des données points_prelevement')

  console.log('\n=> Nettoyage de la collection points_prelevement...')
  await mongo.db.collection('points_prelevement').deleteMany()
  console.log('...Ok !')

  const points = await Promise.all(storage.pointsPrelevement.map(({id_point}) => preparePoint(id_point)))
  const result = await mongo.db.collection('points_prelevement').insertMany(points)

  console.log('\u001B[32;1m%s\u001B[0m', '\n=> ' + result.insertedCount + ' documents insérés dans la collection points_prelevement\n\n')
}

async function importExploitations() {
  console.log('\n\u001B[35;1;4m%s\u001B[0m', '=> Importation des données exploitations')

  console.log('\n=> Nettoyage de la collection exploitations...')
  await mongo.db.collection('exploitations').deleteMany()
  console.log('...Ok !')

  const exploitations = await Promise.all(storage.exploitations.map(({id_exploitation}) => prepareExploitation(id_exploitation)))
  const result = await mongo.db.collection('exploitations').insertMany(exploitations)

  console.log('\u001B[32;1m%s\u001B[0m', '\n=> ' + result.insertedCount + ' documents insérés dans la collection exploitations\n\n')
}

async function importPreleveurs() {
  console.log('\n\u001B[35;1;4m%s\u001B[0m', '=> Importation des données preleveurs')

  console.log('\n=> Nettoyage de la collection preleveurs...')
  await mongo.db.collection('preleveurs').deleteMany()
  console.log('...Ok !')

  const result = await mongo.db.collection('preleveurs').insertMany(storage.beneficiaires)

  console.log('\u001B[32;1m%s\u001B[0m', '\n=> ' + result.insertedCount + ' documents insérés dans la collection preleveurs\n\n')
}

await importPreleveurs()
await importExploitations()
await importPoints()

await mongo.disconnect()
