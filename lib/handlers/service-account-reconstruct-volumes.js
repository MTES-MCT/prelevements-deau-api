import createHttpError from 'http-errors'
import {reconstructVolumesFromIndexForServiceAccount} from '../services/reconstruct-volumes-from-index-for-service-account.js'

export async function reconstructVolumesFromIndexForServiceAccountHandler(req, res) {
  if (!req.serviceAccount?.id) {
    throw createHttpError(401, 'Compte de service non authentifié')
  }

  const result = await reconstructVolumesFromIndexForServiceAccount(req.serviceAccount.id)

  const verbose = req.query?.details === '1' || req.query?.details === 'true'
  if (!verbose) {
    res.status(200).json({
      success: true,
      data: {
        declarants: result.declarants,
        points: result.points,
        chunksConsidered: result.chunksConsidered,
        chunksUpdated: result.chunksUpdated,
        volumesCreated: result.volumesCreated
      }
    })
    return
  }

  res.status(200).json({success: true, data: result})
}
