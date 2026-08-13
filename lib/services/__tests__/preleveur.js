import test from 'ava'

import {createPreleveur, updatePreleveur} from '../preleveur.js'

const naturalPerson = {
  firstName: 'Jean',
  lastName: 'Dupont'
}

function creationModel(t) {
  return {
    async insertDeclarant(payload) {
      t.pass()
      return payload
    }
  }
}

function updateModel(existing, onUpdate = () => {}) {
  return {
    async getDeclarantById() {
      return existing
    },
    async updateDeclarantById(id, changes) {
      onUpdate(id, changes)
      return {...existing, ...changes}
    }
  }
}

test('createPreleveur exige explicitement le type en mode strict', async t => {
  const error = await t.throwsAsync(
    createPreleveur(naturalPerson, {}, {
      declarantModel: creationModel(t)
    }),
    {name: 'ValidationError'}
  )

  t.true(error.details.some(detail =>
    detail.path === 'preleveurType' && detail.type === 'any.required'))
})

test('createPreleveur conserve la compatibilité en affectant AUTRE', async t => {
  const result = await createPreleveur(naturalPerson, {}, {
    strictPreleveurType: false,
    declarantModel: creationModel(t)
  })

  t.is(result.preleveurType, 'AUTRE')
  t.is(result.declarantRole, 'PRELEVEUR')
})

test('createPreleveur force null pour un collecteur et refuse un type non nul', async t => {
  const collecteur = {
    ...naturalPerson,
    declarantRole: 'COLLECTEUR',
    email: 'collecteur@example.fr'
  }
  const result = await createPreleveur(collecteur, {}, {
    declarantModel: creationModel(t)
  })

  t.is(result.preleveurType, null)

  const error = await t.throwsAsync(
    createPreleveur({...collecteur, preleveurType: 'ICPE'}, {}, {
      declarantModel: creationModel(t)
    })
  )
  t.is(error.statusCode, 400)
  t.regex(error.message, /collecteurs/)
})

test('updatePreleveur refuse de supprimer le type d’un préleveur', async t => {
  const existing = {
    ...naturalPerson,
    declarantRole: 'PRELEVEUR',
    preleveurType: 'IRRIGANT'
  }

  const error = await t.throwsAsync(updatePreleveur(
    'preleveur-1',
    {preleveurType: null},
    {
      declarantModel: updateModel(existing)
    }
  ))

  t.is(error.statusCode, 400)
  t.regex(error.message, /obligatoire/)
})

test('updatePreleveur efface le type lors du passage en collecteur', async t => {
  const existing = {
    ...naturalPerson,
    email: 'collecteur@example.fr',
    declarantRole: 'PRELEVEUR',
    preleveurType: 'IRRIGANT'
  }
  let persistedChanges

  await updatePreleveur('preleveur-1', {declarantRole: 'COLLECTEUR'}, {
    declarantModel: updateModel(existing, (id, changes) => {
      t.is(id, 'preleveur-1')
      persistedChanges = changes
    })
  })

  t.deepEqual(persistedChanges, {
    declarantRole: 'COLLECTEUR',
    preleveurType: null
  })
})

test('updatePreleveur exige le type lors du passage en préleveur', async t => {
  const existing = {
    ...naturalPerson,
    email: 'collecteur@example.fr',
    declarantRole: 'COLLECTEUR',
    preleveurType: null
  }

  const error = await t.throwsAsync(updatePreleveur(
    'collecteur-1',
    {declarantRole: 'PRELEVEUR'},
    {
      declarantModel: updateModel(existing)
    }
  ))
  t.is(error.statusCode, 400)

  let persistedChanges
  await updatePreleveur('collecteur-1', {
    declarantRole: 'PRELEVEUR',
    preleveurType: 'GESTIONNAIRE_AEP'
  }, {
    declarantModel: updateModel(existing, (id, changes) => {
      persistedChanges = changes
    })
  })

  t.deepEqual(persistedChanges, {
    declarantRole: 'PRELEVEUR',
    preleveurType: 'GESTIONNAIRE_AEP'
  })
})
