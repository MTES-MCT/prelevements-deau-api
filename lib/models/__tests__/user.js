import test from 'ava'
import {setupTestMongo, cleanupCollections} from '../../util/test-helpers/mongo.js'
import {
  insertUser,
  getUserByEmail,
  getUserById,
  getUsersByTerritoire,
  updateUserById,
  deleteUser,
  addRoleToUser,
  removeRoleFromUser
} from '../user.js'

setupTestMongo(test)
cleanupCollections(test, ['users'])

test.serial('insertUser / crée un utilisateur', async t => {
  const user = {
    email: 'alice.dupont@example.com',
    nom: 'Dupont',
    prenom: 'Alice',
    structure: 'DREAL Réunion',
    roles: [{territoire: 'DEP-974', role: 'editor'}]
  }

  const inserted = await insertUser(user)

  t.truthy(inserted._id)
  t.is(inserted.email, 'alice.dupont@example.com')
  t.is(inserted.nom, 'Dupont')
  t.is(inserted.prenom, 'Alice')
  t.is(inserted.structure, 'DREAL Réunion')
  t.is(inserted.roles.length, 1)
  t.is(inserted.roles[0].territoire, 'DEP-974')
  t.is(inserted.roles[0].role, 'editor')
  t.truthy(inserted.createdAt)
  t.truthy(inserted.updatedAt)
})

test.serial('insertUser / normalise l\'email en minuscules', async t => {
  const user = {
    email: 'Bob.Martin@EXAMPLE.COM',
    nom: 'Martin',
    prenom: 'Bob',
    roles: []
  }

  const inserted = await insertUser(user)

  t.is(inserted.email, 'bob.martin@example.com')
})

test.serial('insertUser / rejette un email dupliqué', async t => {
  const user1 = {
    email: 'duplicate@example.com',
    nom: 'User',
    prenom: 'One',
    roles: []
  }

  await insertUser(user1)

  const user2 = {
    email: 'duplicate@example.com',
    nom: 'User',
    prenom: 'Two',
    roles: []
  }

  await t.throwsAsync(
    async () => insertUser(user2),
    {message: /déjà utilisé/}
  )
})

test.serial('getUserByEmail / récupère un utilisateur par email', async t => {
  const user = {
    email: 'claire@example.com',
    nom: 'Claire',
    prenom: 'Test',
    roles: [{territoire: 'DEP-971', role: 'reader'}]
  }

  await insertUser(user)
  const found = await getUserByEmail('claire@example.com')

  t.truthy(found)
  t.is(found.email, 'claire@example.com')
  t.is(found.nom, 'Claire')
})

test.serial('getUserByEmail / normalise l\'email pour la recherche', async t => {
  const user = {
    email: 'david@example.com',
    nom: 'David',
    prenom: 'Test',
    roles: []
  }

  await insertUser(user)
  const found = await getUserByEmail('DAVID@EXAMPLE.COM')

  t.truthy(found)
  t.is(found.email, 'david@example.com')
})

test.serial('getUserByEmail / retourne null si inexistant', async t => {
  const found = await getUserByEmail('inexistant@example.com')
  t.is(found, null)
})

test.serial('getUserById / récupère un utilisateur par ID', async t => {
  const user = {
    email: 'eve@example.com',
    nom: 'Eve',
    prenom: 'Test',
    roles: []
  }

  const inserted = await insertUser(user)
  const found = await getUserById(inserted._id)

  t.truthy(found)
  t.is(found.email, 'eve@example.com')
  t.deepEqual(found._id, inserted._id)
})

test.serial('getUsersByTerritoire / récupère les utilisateurs d\'un territoire', async t => {
  const user1 = {
    email: 'user1@example.com',
    nom: 'User1',
    prenom: 'Test',
    roles: [{territoire: 'DEP-972', role: 'editor'}]
  }

  const user2 = {
    email: 'user2@example.com',
    nom: 'User2',
    prenom: 'Test',
    roles: [{territoire: 'DEP-972', role: 'reader'}]
  }

  const user3 = {
    email: 'user3@example.com',
    nom: 'User3',
    prenom: 'Test',
    roles: [{territoire: 'DEP-973', role: 'editor'}]
  }

  await insertUser(user1)
  await insertUser(user2)
  await insertUser(user3)

  const users = await getUsersByTerritoire('DEP-972')

  t.is(users.length, 2)
  t.true(users.some(u => u.email === 'user1@example.com'))
  t.true(users.some(u => u.email === 'user2@example.com'))
  t.false(users.some(u => u.email === 'user3@example.com'))
})

test.serial('updateUserById / met à jour les champs autorisés', async t => {
  const user = {
    email: 'update@example.com',
    nom: 'OldName',
    prenom: 'OldFirstName',
    structure: 'Old Structure',
    roles: [{territoire: 'DEP-974', role: 'reader'}]
  }

  const inserted = await insertUser(user)

  const updated = await updateUserById(inserted._id, {
    nom: 'NewName',
    prenom: 'NewFirstName',
    structure: 'New Structure'
  })

  t.is(updated.nom, 'NewName')
  t.is(updated.prenom, 'NewFirstName')
  t.is(updated.structure, 'New Structure')
  t.is(updated.email, 'update@example.com') // Unchanged
  t.deepEqual(updated.roles, user.roles) // Unchanged
})

test.serial('updateUserById / ignore les champs protégés', async t => {
  const user = {
    email: 'protect@example.com',
    nom: 'Name',
    prenom: 'FirstName',
    roles: [{territoire: 'DEP-974', role: 'editor'}]
  }

  const inserted = await insertUser(user)
  const originalEmail = inserted.email
  const originalRoles = inserted.roles

  await updateUserById(inserted._id, {
    email: 'hacker@example.com',
    roles: [],
    nom: 'UpdatedName'
  })

  const found = await getUserById(inserted._id)

  t.is(found.email, originalEmail)
  t.deepEqual(found.roles, originalRoles)
  t.is(found.nom, 'UpdatedName')
})

test.serial('deleteUser / soft delete un utilisateur', async t => {
  const user = {
    email: 'delete@example.com',
    nom: 'Delete',
    prenom: 'Test',
    roles: []
  }

  const inserted = await insertUser(user)
  const deleted = await deleteUser(inserted._id)

  t.truthy(deleted.deletedAt)

  const found = await getUserByEmail('delete@example.com')
  t.is(found, null) // Ne doit pas être trouvé car soft deleted
})

test.serial('addRoleToUser / ajoute un rôle à un utilisateur', async t => {
  const user = {
    email: 'addrole@example.com',
    nom: 'AddRole',
    prenom: 'Test',
    roles: []
  }

  const inserted = await insertUser(user)
  const updated = await addRoleToUser(inserted._id, 'DEP-975', 'editor')

  t.is(updated.roles.length, 1)
  t.is(updated.roles[0].territoire, 'DEP-975')
  t.is(updated.roles[0].role, 'editor')
})

test.serial('addRoleToUser / remplace un rôle existant sur le même territoire', async t => {
  const user = {
    email: 'replacerole@example.com',
    nom: 'ReplaceRole',
    prenom: 'Test',
    roles: [{territoire: 'DEP-976', role: 'reader'}]
  }

  const inserted = await insertUser(user)
  const updated = await addRoleToUser(inserted._id, 'DEP-976', 'editor')

  t.is(updated.roles.length, 1)
  t.is(updated.roles[0].territoire, 'DEP-976')
  t.is(updated.roles[0].role, 'editor')
})

test.serial('addRoleToUser / rejette un rôle invalide', async t => {
  const user = {
    email: 'invalidrole@example.com',
    nom: 'InvalidRole',
    prenom: 'Test',
    roles: []
  }

  const inserted = await insertUser(user)

  await t.throwsAsync(
    async () => addRoleToUser(inserted._id, 'DEP-977', 'superadmin'),
    {message: /reader|editor/}
  )
})

test.serial('removeRoleFromUser / retire un rôle d\'un utilisateur', async t => {
  const user = {
    email: 'removerole@example.com',
    nom: 'RemoveRole',
    prenom: 'Test',
    roles: [
      {territoire: 'DEP-978', role: 'editor'},
      {territoire: 'DEP-979', role: 'reader'}
    ]
  }

  const inserted = await insertUser(user)
  const updated = await removeRoleFromUser(inserted._id, 'DEP-978')

  t.is(updated.roles.length, 1)
  t.is(updated.roles[0].territoire, 'DEP-979')
})
