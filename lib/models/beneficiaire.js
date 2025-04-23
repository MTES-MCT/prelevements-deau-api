import mongo from '../util/mongo.js'

export async function getBeneficiaire(idBeneficiaire) {
  try {
    const beneficiaire = await mongo.db.collection('preleveurs')
      .findOne({id_beneficiaire: idBeneficiaire})

    const exploitations = await mongo.db.collection('exploitations')
      .find(
        {id_beneficiaire: idBeneficiaire},
        {projection: {_id: 0, id_exploitation: 1}}
      )
      .toArray()

    const usages = await mongo.db.collection('exploitations')
      .distinct('usages', {id_beneficiaire: idBeneficiaire})

    return {
      ...beneficiaire,
      exploitations: exploitations.map(e => e.id_exploitation),
      usages
    }
  } catch (error) {
    console.error('\u001B[31mErreur:', error, '\u001B[0m')
    throw error
  }
}

export async function getBeneficiaires() {
  try {
    return await mongo.db.collection('preleveurs').aggregate([
      {
        $lookup: {
          from: 'exploitations',
          localField: 'id_beneficiaire',
          foreignField: 'id_beneficiaire',
          as: 'exploitations'
        }
      },
      {
        $addFields: {
          usages: {
            $reduce: {
              input: '$exploitations.usages',
              initialValue: [],
              in: {
                $concatArrays: [
                  '$$value',
                  {
                    $ifNull: ['$$this', []]
                  }
                ]
              }
            }
          }
        }
      },
      {
        $addFields: {
          usages: {
            $reduce: {
              input: '$usages',
              initialValue: [],
              in: {
                $cond: [
                  {$in: ['$$this', '$$value']},
                  '$$value',
                  {$concatArrays: ['$$value', ['$$this']]}
                ]
              }
            }
          }
        }
      },
      {
        $project: {
          exploitations: 0
        }
      }
    ]).toArray()
  } catch (error) {
    console.error('\u001B[31mErreur:', error, '\u001B[0m')
    throw error
  }
}
