export async function getInfoHandler(req, res) {
  const {user, userRole: role} = req

  const response = {role}

  if (!user) {
    return res.send(response)
  }

  const baseUser = {
    id: user.id,
    email: user.email,
    lastName: user.lastName,
    firstName: user.firstName
  }

  if (role === 'DECLARANT' && user.declarant) {
    Object.assign(baseUser, {
      declarantType: user.declarant.declarantType,
      socialReason: user.declarant.socialReason,
      civility: user.declarant.civility,
      addressLine1: user.declarant.addressLine1,
      addressLine2: user.declarant.addressLine2,
      poBox: user.declarant.poBox,
      postalCode: user.declarant.postalCode,
      city: user.declarant.city,
      phoneNumber: user.declarant.phoneNumber
    })
  }

  response.user = baseUser

  res.send(response)
}
