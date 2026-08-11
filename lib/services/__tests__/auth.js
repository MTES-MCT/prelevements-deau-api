import test from 'ava'

import {authenticateByToken} from '../auth.js'

function serviceAccountTokenLookupMustNotRun(t) {
  return async () => {
    t.fail('Un token de compte de service ne doit pas être recherché lorsqu’une session existe.')
  }
}

test('authenticateByToken refuse la session d’un utilisateur supprimé', async t => {
  const auth = await authenticateByToken('session-token', {
    async getSessionByToken() {
      return {userId: 'deleted-user'}
    },
    async getUserById() {
      return {
        id: 'deleted-user',
        role: 'DECLARANT',
        deletedAt: new Date('2026-08-11T12:00:00.000Z')
      }
    },
    getServiceAccountTokenByToken: serviceAccountTokenLookupMustNotRun(t)
  })

  t.is(auth, null)
})

test('authenticateByToken refuse la session dont l’acteur d’impersonation est supprimé', async t => {
  const auth = await authenticateByToken('session-token', {
    async getSessionByToken() {
      return {
        userId: 'active-user',
        impersonatedByUserId: 'deleted-actor',
        impersonatedByRole: 'ADMIN'
      }
    },
    async getUserById(userId) {
      return userId === 'active-user'
        ? {id: userId, role: 'DECLARANT', deletedAt: null}
        : {
          id: userId,
          role: 'ADMIN',
          deletedAt: new Date('2026-08-11T12:00:00.000Z')
        }
    },
    getServiceAccountTokenByToken: serviceAccountTokenLookupMustNotRun(t)
  })

  t.is(auth, null)
})

test('authenticateByToken refuse l’impersonation de compte de service vers un déclarant supprimé', async t => {
  const auth = await authenticateByToken('service-account-token', {
    async getSessionByToken() {
      return null
    },
    async getUserById() {
      t.fail('Aucun utilisateur de session ne doit être recherché sans session.')
    },
    async getServiceAccountTokenByToken() {
      return {
        type: 'IMPERSONATION',
        serviceAccount: {
          id: 'service-account-1',
          name: 'Compte de service',
          isActive: true,
          deletedAt: null
        },
        declarant: {
          user: {
            id: 'deleted-declarant',
            role: 'DECLARANT',
            deletedAt: new Date('2026-08-11T12:00:00.000Z')
          }
        }
      }
    }
  })

  t.is(auth, null)
})
