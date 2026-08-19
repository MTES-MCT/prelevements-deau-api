import test from 'ava'

import {
  buildInstructorOptionsWhere,
  countZoneDeclarants,
  instructorOptionsQuerySchema
} from '../zones.js'

test('la recherche d’instructeurs répartit les termes entre les champs', t => {
  const contains = term => ({contains: term, mode: 'insensitive'})
  const termWhere = term => ({
    OR: [
      {email: contains(term)},
      {firstName: contains(term)},
      {lastName: contains(term)},
      {instructor: {is: {phoneNumber: contains(term)}}},
      {instructor: {is: {jobTitle: contains(term)}}}
    ]
  })

  t.deepEqual(buildInstructorOptionsWhere('  jean   dupont jean  '), {
    AND: [termWhere('jean'), termWhere('dupont')]
  })
  t.deepEqual(buildInstructorOptionsWhere('   '), {})
})

test('la recherche d’instructeurs borne la saisie et le nombre de termes', t => {
  const terms = Array.from({length: 13}, (_, index) => `terme${index + 1}`)
  const where = buildInstructorOptionsWhere(terms.join(' '))

  t.is(where.AND.length, 12)
  t.is(where.AND[11].OR[0].email.contains, 'terme12')
  t.truthy(instructorOptionsQuerySchema.validate({search: 'a'.repeat(201)}).error)
  t.falsy(instructorOptionsQuerySchema.validate({search: 'a'.repeat(200)}).error)
})

test('countZoneDeclarants compte uniquement les identifiants effectifs dédupliqués', async t => {
  let countQuery
  const client = {
    declarant: {
      async count(query) {
        countQuery = query
        return 2
      }
    }
  }

  t.is(await countZoneDeclarants([
    'declarant-1',
    'declarant-1',
    'declarant-2'
  ], 'PRELEVEUR', {client}), 2)
  t.deepEqual(countQuery.where, {
    userId: {in: ['declarant-1', 'declarant-2']},
    declarantRole: 'PRELEVEUR',
    user: {deletedAt: null}
  })
})

test('countZoneDeclarants reste fermé et évite la base sans identifiant effectif', async t => {
  const client = {
    declarant: {
      async count() {
        t.fail('Une zone vide ne doit pas déclencher un comptage global.')
      }
    }
  }

  t.is(await countZoneDeclarants([], 'COLLECTEUR', {client}), 0)
})
