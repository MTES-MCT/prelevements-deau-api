import test from 'ava'

import {authenticateByToken} from '../auth.js'

test('une session email partagée applique les droits du profil choisi et conserve son auteur', async t => {
  const email = 'shared@example.test'
  const anchor = {id: 'anchor', role: 'DECLARANT', authVersion: 3, declarant: {declarantRole: 'PRELEVEUR', email}}
  const selected = {...anchor, id: 'selected', authVersion: 5}
  const session = {userId: anchor.id, authVersion: 3, role: 'DECLARANT', loginEmail: email,
    profileUserId: selected.id, profileAuthVersion: 5, profileSelectionRequired: false, availableProfileCount: 2}
  const lookup = {async getSessionByToken() { return session },
    async getUserById(id) { return id === anchor.id ? anchor : selected }}
  const auth = await authenticateByToken('synthetic', lookup)
  t.is(auth.user.id, selected.id)
  t.is(auth.actor.id, anchor.id)
  t.deepEqual(auth.preleveurProfiles, {enabled: true, canSwitch: true, selectionRequired: false, canManageAccount: false})
  selected.declarant = {...selected.declarant, email: 'changed@example.test'}
  t.is(await authenticateByToken('synthetic', lookup), null)
  selected.declarant.email = email
  selected.authVersion++
  t.is(await authenticateByToken('synthetic', lookup), null)
})

test('un principal partagé ne traverse ni les rôles ni une session d’assistance', async t => {
  const email = 'shared@example.test'
  const user = {id: 'owner', role: 'DECLARANT', authVersion: 1, declarant: {declarantRole: 'COLLECTEUR', email}}
  const session = {userId: user.id, role: 'DECLARANT', authVersion: 1, loginEmail: email,
    profileUserId: user.id, profileAuthVersion: 1}
  const lookup = {async getSessionByToken() { return session }, async getUserById() { return user }}
  t.is(await authenticateByToken('synthetic', lookup), null)
  user.declarant.declarantRole = 'PRELEVEUR'
  session.impersonatedByUserId = 'admin'
  t.is(await authenticateByToken('synthetic', lookup), null)
})

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

test('authenticateByToken conserve l’expiration de la session utilisateur', async t => {
  const expiresAt = new Date('2026-08-21T20:00:00.000Z')
  const auth = await authenticateByToken('session-token', {
    async getSessionByToken() {
      return {
        userId: 'active-user',
        role: 'DECLARANT',
        authVersion: 4,
        expiresAt
      }
    },
    async getUserById() {
      return {
        id: 'active-user',
        role: 'DECLARANT',
        authVersion: 4,
        deletedAt: null
      }
    },
    getServiceAccountTokenByToken: serviceAccountTokenLookupMustNotRun(t)
  })

  t.is(auth.type, 'USER_SESSION')
  t.is(auth.expiresAt, expiresAt)
})

test('authenticateByToken refuse une session dont la génération utilisateur est obsolète', async t => {
  const auth = await authenticateByToken('session-token', {
    async getSessionByToken() {
      return {
        userId: 'active-user',
        role: 'DECLARANT',
        authVersion: 3
      }
    },
    async getUserById() {
      return {
        id: 'active-user',
        role: 'DECLARANT',
        authVersion: 4,
        deletedAt: null
      }
    },
    getServiceAccountTokenByToken: serviceAccountTokenLookupMustNotRun(t)
  })

  t.is(auth, null)
})

test('authenticateByToken refuse une ancienne session sans génération utilisateur', async t => {
  const auth = await authenticateByToken('session-token', {
    async getSessionByToken() {
      return {
        userId: 'active-user',
        role: 'DECLARANT',
        authVersion: null
      }
    },
    async getUserById() {
      return {
        id: 'active-user',
        role: 'DECLARANT',
        authVersion: 0,
        deletedAt: null
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
        authVersion: 2,
        impersonatedByUserId: 'deleted-actor',
        impersonatedByRole: 'ADMIN',
        impersonatedByAuthVersion: 5
      }
    },
    async getUserById(userId) {
      return userId === 'active-user'
        ? {id: userId, role: 'DECLARANT', authVersion: 2, deletedAt: null}
        : {
          id: userId,
          role: 'ADMIN',
          authVersion: 5,
          deletedAt: new Date('2026-08-11T12:00:00.000Z')
        }
    },
    getServiceAccountTokenByToken: serviceAccountTokenLookupMustNotRun(t)
  })

  t.is(auth, null)
})

test('authenticateByToken accepte une impersonation dont les deux générations sont courantes', async t => {
  const auth = await authenticateByToken('session-token', {
    async getSessionByToken() {
      return {
        userId: 'active-user',
        role: 'DECLARANT',
        authVersion: 2,
        impersonatedByUserId: 'active-actor',
        impersonatedByRole: 'ADMIN',
        impersonatedByAuthVersion: 5
      }
    },
    async getUserById(userId) {
      return userId === 'active-user'
        ? {id: userId, role: 'DECLARANT', authVersion: 2, deletedAt: null}
        : {
          id: userId,
          email: 'admin@example.com',
          role: 'ADMIN',
          authVersion: 5,
          deletedAt: null
        }
    },
    getServiceAccountTokenByToken: serviceAccountTokenLookupMustNotRun(t)
  })

  t.is(auth.type, 'USER_SESSION')
  t.is(auth.user.id, 'active-user')
  t.is(auth.actor.id, 'active-actor')
})

test('authenticateByToken refuse une impersonation dont la génération de l’acteur est obsolète', async t => {
  const auth = await authenticateByToken('session-token', {
    async getSessionByToken() {
      return {
        userId: 'active-user',
        role: 'DECLARANT',
        authVersion: 2,
        impersonatedByUserId: 'active-actor',
        impersonatedByRole: 'ADMIN',
        impersonatedByAuthVersion: 4
      }
    },
    async getUserById(userId) {
      return userId === 'active-user'
        ? {id: userId, role: 'DECLARANT', authVersion: 2, deletedAt: null}
        : {id: userId, role: 'ADMIN', authVersion: 5, deletedAt: null}
    },
    getServiceAccountTokenByToken: serviceAccountTokenLookupMustNotRun(t)
  })

  t.is(auth, null)
})

test('authenticateByToken refuse une ancienne impersonation sans génération de l’acteur', async t => {
  const auth = await authenticateByToken('session-token', {
    async getSessionByToken() {
      return {
        userId: 'active-user',
        role: 'DECLARANT',
        authVersion: 2,
        impersonatedByUserId: 'active-actor',
        impersonatedByRole: 'ADMIN',
        impersonatedByAuthVersion: null
      }
    },
    async getUserById(userId) {
      return userId === 'active-user'
        ? {id: userId, role: 'DECLARANT', authVersion: 2, deletedAt: null}
        : {id: userId, role: 'ADMIN', authVersion: 0, deletedAt: null}
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

test('authenticateByToken ne soumet pas les comptes de service aux générations utilisateur', async t => {
  const serviceAccount = {
    id: 'service-account-1',
    name: 'Compte de service',
    isActive: true,
    deletedAt: null
  }
  const auth = await authenticateByToken('service-account-token', {
    async getSessionByToken() {
      return null
    },
    async getUserById() {
      t.fail('Aucun utilisateur de session ne doit être recherché sans session.')
    },
    async getServiceAccountTokenByToken() {
      return {
        type: 'ACCESS',
        serviceAccount
      }
    }
  })

  t.is(auth.type, 'SERVICE_ACCOUNT_ACCESS')
  t.is(auth.serviceAccount, serviceAccount)
})

test('authenticateByToken conserve l’impersonation des comptes de service', async t => {
  const declarantUser = {
    id: 'active-declarant',
    role: 'DECLARANT',
    authVersion: 9,
    deletedAt: null
  }
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
        declarant: {user: declarantUser}
      }
    }
  })

  t.is(auth.type, 'SERVICE_ACCOUNT_IMPERSONATION')
  t.is(auth.user, declarantUser)
})
