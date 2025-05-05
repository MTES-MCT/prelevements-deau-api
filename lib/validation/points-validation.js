import Joi from 'joi'
import {validatePayload} from '../util/payload.js'

const pointSchemaCreation = Joi.object().keys({
  nom: Joi.string().required().messages({
    'string.base': 'Le nom doit être une chaine de caractères.',
    'string.empty': 'Le nom ne peut pas être vide.'
  }),
  autresNoms: Joi.string().allow(null).messages({
    'string.base': 'Le champ "autres_noms" doit être une chaine de caractères.',
    'string.empty': 'Le champ "autres_noms" ne peut pas être vide.'
  }),
  code_aiot: Joi.string().allow(null).messages({
    'string.base': 'Le code AIOT doit être une chaine de caractères.',
    'string.empty': 'Le code AIOT ne peut pas être vide.'
  }),
  type_milieu: Joi.string().required().messages({
    'string.base': 'Le type de milieu doit être une chaine de caractères.',
    'any.required': 'Le type de milieu est obligatoire.'
  }),
  profondeur: Joi.number().allow(null).messages({
    'number.base': 'La profondeur doit être un nombre.'
  }),
  zre: Joi.bool().allow(null),
  reservoir_biologique: Joi.bool().allow(null),
  code_bdlisa: Joi.string().allow(null).messages({
    'string.base': 'Le code BDLISA doit être une chaine de caractères.',
    'string.empty': 'Le code BDLISA ne peux pas être vide.'
  }),
  cours_eau: Joi.string().allow(null).messages({
    'string.base': 'Le champ "cours_eau" doit être une chaine de caractères.',
    'string.empty': 'Le champ "cours_eau" ne peux pas être vide.'
  }),
  detail_localisation: Joi.string().allow(null).messages({
    'string.base': 'Le champ "detail_localisation" doit être une chaine de caractères.',
    'string.empty': 'Le champ "detail_localisation" ne peux pas être vide.'
  }),
  geom: Joi.object().keys({
    type: Joi.string().allow(null).messages({
      'string.base': 'Le type doit être une chaine de caractères.',
      'string.empty': 'Le type ne peux pas être vide.'
    }),
    coordinates: Joi.array().items(
      Joi.number().messages({
        'number.base': 'Les coordonnées doivent être des nombres.'
      })
    ).allow(null).messages({
      'array.base': 'Les coordonnées doivent être dans un tableau.'
    })
  }),
  precision_geom: Joi.string().allow(null).messages({
    'string.base': 'Le champ "precision_geom" doit être une chaine de caractères.',
    'string.empty': 'Le champ "precision_geom" ne peut pas être vide.'
  }),
  remarque: Joi.string().allow(null).messages({
    'string.base': 'Le champ "remarque" doit être une chaine de caractères.',
    'string.empty': 'Le champ "remarque" ne peut pas être vide.'
  }),
  bss: Joi.object().keys({
    id_bss: Joi.string().allow(null).messages({
      'string.base': 'Le champ "bss.id_bss" doit être une chaine de caractères.',
      'string.empty': 'Le champ "bss.id_bss" ne peut pas être vide.'
    }),
    lien: Joi.string().uri().allow(null).messages({
      'string.base': 'Le champ "bss.lien" doit être une chaine de caractères.',
      'string.uri': 'Le lien BSS doit être une URL valide.'
    })
  }),
  bnpe: Joi.object().keys({
    point: Joi.string().allow(null).messages({
      'string.base': 'Le champ "bnpe.point" doit être une chaine de caractères.',
      'string.empty': 'Le champ "bnpe.point" ne peut pas être vide.'
    }),
    lien: Joi.string().uri().allow(null).messages({
      'string.base': 'Le champ "bnpe.lien" doit être une chaine de caractères.',
      'string.uri': 'Le lien BNPE doit être une URL valide.'
    })
  }),
  meso: Joi.object().keys({
    code: Joi.string().allow(null).messages({
      'string.base': 'Le champ "meso.code" doit être une chaine de caractères.',
      'string.empty': 'Le champ "meso.code" ne peut pas être vide.'
    }),
    nom: Joi.string().allow(null).messages({
      'string.base': 'Le champ "meso.nom" doit être une chaine de caractères.',
      'string.empty': 'Le champ "meso.nom" ne peut pas être vide.'
    })
  }),
  meContinentalesBv: Joi.object().allow(null).keys({
    code: Joi.string().allow(null).messages({
      'string.base': 'Le champ "meContinentalesBv.code" doit être une chaine de caractères.',
      'string.empty': 'Le champ "meContinentalesBv.code" ne peut pas être vide.'
    }),
    nom: Joi.string().uri().allow(null).messages({
      'string.base': 'Le champ "meContinentalesBv.nom" doit être une chaine de caractères.',
      'string.empty': 'Le champ "meContinentalesBv.nom" ne peut pas être vide.'
    })
  }),
  bvBdCarthage: Joi.object().keys({
    code: Joi.string().allow(null).messages({
      'string.base': 'Le champ "bvBdCarthage.code" doit être une chaine de caractères.',
      'string.empty': 'Le champ "bvBdCarthage.code" ne peut pas être vide.'
    }),
    nom: Joi.string().allow(null).messages({
      'string.base': 'Le champ "bvBdCarthage.nom" doit être une chaine de caractères.',
      'string.empty': 'Le champ "bvBdCarthage.nom" ne peut pas être vide.'
    })
  }),
  commune: Joi.object().keys({
    code: Joi.string().allow(null).messages({
      'string.base': 'Le champ "commune.code" doit être une chaine de caractères.',
      'string.empty': 'Le champ "commune.code" ne peut pas être vide.'
    }),
    nom: Joi.string().allow(null).messages({
      'string.base': 'Le champ "commune.nom" doit être une chaine de caractères.',
      'string.empty': 'Le champ "commune.nom" ne peut pas être vide.'
    })
  }).messages({
    'object.unknown': 'Une clé de l’objet est invalide'
  })
})

function validateCreation(point) {
  return validatePayload(point, pointSchemaCreation)
}

export {validateCreation}

