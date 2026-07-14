import test from 'ava'

import {
  instructorSourceScopeWhere,
  visibleSourceWhere
} from '../instructor-sources.js'

test('instructorSourceScopeWhere refuse tout périmètre vide', t => {
  t.deepEqual(instructorSourceScopeWhere(), {id: {in: []}})
})

test('instructorSourceScopeWhere combine les points et les déclarants des zones autorisées', t => {
  t.deepEqual(
    instructorSourceScopeWhere({
      pointIds: ['point-1'],
      zoneIds: ['zone-1']
    }),
    {
      OR: [
        {
          chunks: {
            some: {pointPrelevementId: {in: ['point-1']}}
          }
        },
        {
          declaration: {
            is: {
              OR: [
                {declarant: {zones: {some: {zoneId: {in: ['zone-1']}}}}},
                {createdByDeclarant: {zones: {some: {zoneId: {in: ['zone-1']}}}}}
              ]
            }
          }
        }
      ]
    }
  )
})

test('visibleSourceWhere masque les sources API terminées sans donnée', t => {
  t.deepEqual(visibleSourceWhere(), {
    NOT: {
      type: 'API',
      status: 'COMPLETED',
      chunks: {none: {}}
    }
  })
})
