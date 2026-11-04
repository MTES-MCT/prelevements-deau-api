import {stageAuditMutation} from '../audit/mutations.js'
import {
  createCollectorExploitation, getCollectorExploitationForm, updateCollectorExploitationForm,
  getCollectorPreleveurContactDetails, updateCollectorPreleveurContactDetails
} from '../services/collector-resource-management.js'

const stageMutations = req => mutations => {
  for (const mutation of mutations) stageAuditMutation(req, mutation)
}

export async function createCollectorExploitationHandler(req, res) {
  const result = await createCollectorExploitation(req.params.pointId, req.body, {user: req.user,
    onCreated({preleveur, exploitation, mutations}) {
      for (const [entityType, entity] of [['DECLARANT', preleveur], ['EXPLOITATION', exploitation]]) {
        if (entity) stageAuditMutation(req, {operation: 'CREATE', entityType, entityId: entity.userId ?? entity.id, after: entity})
      }
      stageMutations(req)(mutations)
    }})
  res.status(result.replayed ? 200 : 201).send(result)
}

export async function getCollectorExploitationFormHandler(req, res) {
  res.send(await getCollectorExploitationForm(req.params.exploitationId, {user: req.user}))
}

export async function updateCollectorExploitationFormHandler(req, res) {
  res.send(await updateCollectorExploitationForm(req.params.exploitationId, req.body, {user: req.user, onUpdated: stageMutations(req)}))
}

export async function getCollectorPreleveurContactDetailsHandler(req, res) {
  res.send(await getCollectorPreleveurContactDetails(req.params.preleveurId, {user: req.user}))
}

export async function updateCollectorPreleveurContactDetailsHandler(req, res) {
  res.send(await updateCollectorPreleveurContactDetails(req.params.preleveurId, req.body, {user: req.user, onUpdated: stageMutations(req)}))
}
