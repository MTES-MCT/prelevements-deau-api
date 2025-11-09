import {
  updateDocument,
  deleteDocument,
  decorateDocument
} from '../services/document.js'

// Détail d'un document
export async function getDocumentDetail(req, res) {
  const decoratedDocument = await decorateDocument(req.document)

  res.send(decoratedDocument)
}

// Mise à jour d'un document
export async function updateDocumentHandler(req, res) {
  const document = await updateDocument(req.document._id, req.body)
  const decoratedDocument = await decorateDocument(document)

  res.send(decoratedDocument)
}

// Suppression d'un document
export async function deleteDocumentHandler(req, res) {
  const deletedDocument = await deleteDocument(req.document._id)

  res.send(deletedDocument)
}
