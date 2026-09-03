import test from 'ava'

import {assertConnectedDatabaseIdentity} from '../lib/seed-database.js'

const ATTESTATION = Object.freeze({
  database: Object.freeze({
    name: 'prelevements_demo',
    user: 'prelevements_demo_app',
    port: '17063',
    tls: true
  })
})

function databaseWithIdentity(identity) {
  return {
    async $queryRawUnsafe(query) {
      if (!query.includes('inet_server_port')) {
        throw new Error('requête d’identité inattendue')
      }

      return [identity]
    }
  }
}

function connectedIdentity(overrides = {}) {
  return {
    databaseName: 'prelevements_demo',
    databaseUser: 'prelevements_demo_app',
    serverAddress: '10.0.0.42',
    // Scalingo/Scaleway expose un port proxy distinct du port du backend.
    serverPort: 5432,
    serverVersionNumber: 160_004,
    tls: true,
    ...overrides
  }
}

test('accepte un port backend distinct du port public déjà attesté', async t => {
  const identity = connectedIdentity()

  t.deepEqual(
    await assertConnectedDatabaseIdentity({
      database: databaseWithIdentity(identity),
      attestation: ATTESTATION
    }),
    {
      verified: true,
      databaseName: identity.databaseName,
      databaseUser: identity.databaseUser,
      tls: true,
      serverAddress: identity.serverAddress,
      serverPort: identity.serverPort,
      serverVersionNumber: identity.serverVersionNumber
    }
  )
})

test('refuse une dérive vérifiable de l’identité connectée', async t => {
  for (const [field, value, mismatch] of [
    ['databaseName', 'prod-partageons-leau-api', 'name'],
    ['databaseUser', 'prod_app', 'user'],
    ['tls', false, 'tls']
  ]) {
    await t.throwsAsync(assertConnectedDatabaseIdentity({
      database: databaseWithIdentity(connectedIdentity({[field]: value})),
      attestation: ATTESTATION
    }), {message: new RegExp(`attestation \\(${mismatch}\\)`)})
  }
})
