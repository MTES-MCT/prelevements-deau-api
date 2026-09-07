import {stageAuditMutation} from '../audit/mutations.js'
import {
  serializeUserProfile,
  updateCurrentUserProfile
} from '../services/user-profile.js'

export function createUpdateMyProfileHandler({updateProfile = updateCurrentUserProfile} = {}) {
  return async (req, res) => {
    const user = await updateProfile(req.user.id, req.body, {
      allowImpersonatedSession: true,
      sessionToken: req.authToken
    })

    stageAuditMutation(req, {
      operation: 'UPDATE',
      entityType: 'USER_PROFILE',
      entityId: user.id,
      before: req.user,
      after: user
    })

    res.status(200).send(serializeUserProfile(user, user.role))
  }
}

export const updateMyProfileHandler = createUpdateMyProfileHandler()
