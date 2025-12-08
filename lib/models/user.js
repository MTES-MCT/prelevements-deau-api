import {ObjectId} from 'mongodb'
import createHttpError from 'http-errors'
import mongo from '../util/mongo.js'
import {normalizeEmail} from '../util/email.js'

export async function getUserByEmail(email) {
  const normalized = normalizeEmail(email)
  return mongo.db.collection('users').findOne({
    email: normalized,
    deletedAt: {$exists: false}
  })
}

export async function getUserById(userId) {
  return mongo.db.collection('users').findOne({
    _id: userId,
    deletedAt: {$exists: false}
  })
}

export async function getUsersByTerritoire(codeTerritoire) {
  return mongo.db.collection('users').find({
    'roles.territoire': codeTerritoire,
    deletedAt: {$exists: false}
  }).toArray()
}

export async function insertUser(user) {
  user._id = new ObjectId()
  user.email = normalizeEmail(user.email)
  user.createdAt = new Date()
  user.updatedAt = new Date()
  user.roles ||= []

  try {
    await mongo.db.collection('users').insertOne(user)
    return user
  } catch (error) {
    if (error.code === 11_000) {
      throw createHttpError(400, 'Cet email est déjà utilisé')
    }

    throw error
  }
}

export async function updateUserById(userId, changes) {
  if (!changes || typeof changes !== 'object') {
    throw createHttpError(400, 'Les modifications doivent être un objet.')
  }

  // Ne pas permettre de modifier l'email ou les rôles via cette fonction
  const {email, roles, _id, createdAt, ...allowedChanges} = changes

  const update = {
    ...allowedChanges,
    updatedAt: new Date()
  }

  const user = await mongo.db.collection('users').findOneAndUpdate(
    {_id: userId, deletedAt: {$exists: false}},
    {$set: update},
    {returnDocument: 'after'}
  )

  if (!user) {
    throw createHttpError(404, 'Utilisateur introuvable.')
  }

  return user
}

export async function deleteUser(userId) {
  const user = await mongo.db.collection('users').findOneAndUpdate(
    {_id: userId, deletedAt: {$exists: false}},
    {$set: {
      deletedAt: new Date(),
      updatedAt: new Date()
    }},
    {returnDocument: 'after'}
  )

  if (!user) {
    throw createHttpError(404, 'Utilisateur introuvable')
  }

  return user
}

export async function addRoleToUser(userId, territoire, role) {
  if (!['reader', 'editor'].includes(role)) {
    throw createHttpError(400, 'Le rôle doit être "reader" ou "editor"')
  }

  // D'abord retirer le territoire s'il existe déjà (pour éviter les doublons)
  await mongo.db.collection('users').updateOne(
    {_id: userId, deletedAt: {$exists: false}},
    {$pull: {roles: {territoire}}}
  )

  // Puis ajouter le nouveau rôle
  const updatedUser = await mongo.db.collection('users').findOneAndUpdate(
    {_id: userId, deletedAt: {$exists: false}},
    {
      $push: {roles: {territoire, role}},
      $set: {updatedAt: new Date()}
    },
    {returnDocument: 'after'}
  )

  if (!updatedUser) {
    throw createHttpError(404, 'Utilisateur introuvable')
  }

  return updatedUser
}

export async function removeRoleFromUser(userId, territoire) {
  const updatedUser = await mongo.db.collection('users').findOneAndUpdate(
    {_id: userId, deletedAt: {$exists: false}},
    {
      $pull: {roles: {territoire}},
      $set: {updatedAt: new Date()}
    },
    {returnDocument: 'after'}
  )

  if (!updatedUser) {
    throw createHttpError(404, 'Utilisateur introuvable')
  }

  return updatedUser
}
