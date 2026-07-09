import test from 'ava'

import {buildChunkActorData} from '../chunk-actors.js'

function createClient(rolesByDeclarantId = {}) {
  return {
    declarant: {
      async findUnique({where}) {
        const role = rolesByDeclarantId[where.userId]

        return role ? {declarantRole: role} : null
      }
    }
  }
}

test('buildChunkActorData historise un dépôt direct sans collecteur', async t => {
  const actorData = await buildChunkActorData({
    preleveurUserId: 'preleveur-id',
    submittedByDeclarantUserId: 'preleveur-id',
    client: createClient({'preleveur-id': 'PRELEVEUR'})
  })

  t.deepEqual(actorData, {
    preleveurUserId: 'preleveur-id',
    submittedByDeclarantUserId: 'preleveur-id',
    collecteurUserId: null
  })
})

test('buildChunkActorData historise un dépôt collecteur pour un préleveur', async t => {
  const actorData = await buildChunkActorData({
    preleveurUserId: 'preleveur-id',
    submittedByDeclarantUserId: 'collecteur-id',
    client: createClient({'collecteur-id': 'COLLECTEUR'})
  })

  t.deepEqual(actorData, {
    preleveurUserId: 'preleveur-id',
    submittedByDeclarantUserId: 'collecteur-id',
    collecteurUserId: 'collecteur-id'
  })
})

test('buildChunkActorData rattache le volume au préleveur résolu pendant le rapprochement', async t => {
  const actorData = await buildChunkActorData({
    preleveurUserId: null,
    matchedPreleveurUserId: 'preleveur-id',
    submittedByDeclarantUserId: 'collecteur-id',
    client: createClient({'collecteur-id': 'COLLECTEUR'})
  })

  t.deepEqual(actorData, {
    preleveurUserId: 'preleveur-id',
    submittedByDeclarantUserId: 'collecteur-id',
    collecteurUserId: 'collecteur-id'
  })
})

test('buildChunkActorData historise un dépôt collecteur sans préleveur résolu', async t => {
  const actorData = await buildChunkActorData({
    preleveurUserId: null,
    submittedByDeclarantUserId: 'collecteur-id',
    client: createClient({'collecteur-id': 'COLLECTEUR'})
  })

  t.deepEqual(actorData, {
    preleveurUserId: null,
    submittedByDeclarantUserId: 'collecteur-id',
    collecteurUserId: 'collecteur-id'
  })
})

test('buildChunkActorData ne marque pas collecteur un auteur non collecteur', async t => {
  const actorData = await buildChunkActorData({
    preleveurUserId: 'preleveur-id',
    submittedByDeclarantUserId: 'other-preleveur-id',
    client: createClient({'other-preleveur-id': 'PRELEVEUR'})
  })

  t.deepEqual(actorData, {
    preleveurUserId: 'preleveur-id',
    submittedByDeclarantUserId: 'other-preleveur-id',
    collecteurUserId: null
  })
})
