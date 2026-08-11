import test from 'ava'

import {processAuthTokenVerification} from '../auth.js'

test('processAuthTokenVerification refuse le magic link d’un utilisateur supprimé', async t => {
  const dependencies = {
    async getAuthTokenByToken() {
      return {userId: 'deleted-user'}
    },
    async getUserById() {
      return {
        id: 'deleted-user',
        role: 'DECLARANT',
        deletedAt: new Date('2026-08-11T12:00:00.000Z')
      }
    },
    async createSessionToken() {
      t.fail('Aucune session ne doit être créée pour un utilisateur supprimé.')
    },
    async updateLastLoginAt() {
      t.fail('La dernière connexion ne doit pas être mise à jour pour un utilisateur supprimé.')
    }
  }

  const error = await t.throwsAsync(() => processAuthTokenVerification(
    'magic-link-token',
    {},
    dependencies
  ))

  t.is(error.status, 401)
  t.is(error.message, 'Utilisateur non trouvé')
})
