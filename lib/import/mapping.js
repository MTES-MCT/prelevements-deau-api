import {typesMilieu, statutsExploitation, parametres, unites, contraintes, natures, frequences, precisionsGeom} from '../nomenclature.js'

import {parseGeometry, parseString, parseNomenclature, parseBoolean, parseNumber, parseDate} from './generic.js'

export const POINTS_PRELEVEMENT_DEFINITION = {
  schema: {
    id_point: {parse: parseString},
    nom: {parse: parseString},
    autres_noms: {parse: parseString},
    code_bnpe: {parse: parseString},
    id_bss: {parse: parseString},
    code_aiot: {parse: parseString},
    type_milieu: {parse: value => parseNomenclature(value, typesMilieu)},
    profondeur: {parse: parseNumber},
    zre: {parse: parseBoolean},
    reservoir_biologique: {parse: parseBoolean},
    insee_com: {parse: parseString},
    code_bdlisa: {parse: parseString},
    code_meso: {parse: parseString},
    code_bv_bdcarthage: {parse: parseString},
    code_me_continentales_bv: {parse: parseString},
    cours_eau: {parse: parseString},
    detail_localisation: {parse: parseString},
    geom: {parse: parseGeometry},
    precision_geom: {parse: value => parseNomenclature(value, precisionsGeom)},
    remarque: {parse: parseString}
  },
  requiredFields: ['id_point', 'nom', 'geom']
}

export const EXPLOITATIONS_DEFINITION = {
  schema: {
    id_exploitation: {parse: parseString},
    date_debut: {parse: parseDate},
    date_fin: {parse: parseDate},
    statut: {parse: value => parseNomenclature(value, statutsExploitation)},
    raison_abandon: {parse: parseString},
    remarque: {parse: parseString},
    id_point: {parse: parseString},
    id_beneficiaire: {parse: parseString}
  },
  requiredFields: ['id_exploitation', 'id_point']
}

export const PRELEVEURS_DEFINITION = {
  schema: {
    id_beneficiaire: {parse: parseString},
    raison_sociale: {parse: parseString},
    sigle: {parse: parseString},
    civilite: {parse: parseString},
    nom: {parse: parseString},
    prenom: {parse: parseString},
    email: {parse: parseString},
    adresse_1: {parse: parseString},
    adresse_2: {parse: parseString},
    bp: {parse: parseString},
    code_postal: {parse: parseString},
    commune: {parse: parseString},
    numero_telephone: {parse: parseString}
  },
  requiredFields: ['id_beneficiaire']
}

export const REGLES_DEFINITION = {
  schema: {
    id_regle: {parse: parseString},
    parametre: {parse: value => parseNomenclature(value, parametres)},
    unite: {parse: value => parseNomenclature(value, unites)},
    valeur: {parse: parseNumber},
    contrainte: {parse: value => parseNomenclature(value, contraintes)},
    debut_validite: {parse: parseDate},
    fin_validite: {parse: parseDate},
    debut_periode: {parse: parseDate},
    fin_periode: {parse: parseDate},
    remarque: {parse: parseString},
    id_document: {parse: parseString}
  },
  requiredFields: ['id_regle']
}

export const DOCUMENTS_DEFINITION = {
  schema: {
    id_document: {parse: parseString},
    nom_fichier: {parse: parseString},
    reference: {parse: parseString},
    nature: {parse: value => parseNomenclature(value, natures)},
    date_signature: {parse: parseDate},
    date_fin_validite: {parse: parseDate},
    date_ajout: {parse: parseDate},
    remarque: {parse: parseString}
  },
  requiredFields: ['id_document']
}

export const MODALITES_DEFINITION = {
  schema: {
    id_modalite: {parse: parseString},
    freq_volume_preleve: {parse: value => parseNomenclature(value, frequences)},
    freq_debit_preleve: {parse: value => parseNomenclature(value, frequences)},
    freq_debit_reserve: {parse: value => parseNomenclature(value, frequences)},
    freq_conductivite: {parse: value => parseNomenclature(value, frequences)},
    freq_temperature: {parse: value => parseNomenclature(value, frequences)},
    freq_niveau_eau: {parse: value => parseNomenclature(value, frequences)},
    freq_ph: {parse: value => parseNomenclature(value, frequences)},
    freq_chlorure: {parse: value => parseNomenclature(value, frequences)},
    freq_nitrates: {parse: value => parseNomenclature(value, frequences)},
    freq_sulfates: {parse: value => parseNomenclature(value, frequences)},
    remarque: {parse: parseString}
  },
  requiredFields: ['id_modalite']
}

export const BSS_DEFINITION = {
  schema: {
    id_bss: {parse: parseString},
    lien_infoterre: {parse: parseString}
  },
  requiredFields: ['id_bss']
}

export const BNPE_DEFINITION = {
  schema: {
    code_point_prelevement: {parse: parseString},
    uri_ouvrage: {parse: parseString}
  },
  requiredFields: ['code_point_prelevement']
}

export const ME_CONTINENTALES_BV_DEFINITION = {
  schema: {
    code_dce: {parse: parseString},
    nom: {parse: parseString}
  },
  requiredFields: ['code_dce']
}

export const BV_BDCARTHAGE_DEFINITION = {
  schema: {
    code_cours: {parse: parseString},
    toponyme_t: {parse: parseString}
  },
  requiredFields: ['code_cours']
}

export const MESO_DEFINITION = {
  schema: {
    code: {parse: parseString},
    nom_provis: {parse: parseString}
  },
  requiredFields: ['code']
}

export const LIBELLES_DEFINITION = {
  schema: {
    id: {parse: parseString},
    insee_com: {parse: parseString},
    nom: {parse: parseString}
  },
  requiredFields: ['id']
}
