import {typesMilieu, statutsExploitation, parametres, unites, contraintes, natures, precisionsGeom} from './nomenclature.js'

import {
  parseGeometry,
  parseString,
  parseNomenclature,
  parseBoolean,
  parseNumber,
  parseDate,
  parsePositiveInteger
} from './generic.js'

export const POINTS_PRELEVEMENT_DEFINITION = {
  schema: {
    id_point: {parse: parsePositiveInteger},
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
    id_exploitation: {parse: parsePositiveInteger},
    date_debut: {parse: parseDate},
    date_fin: {parse: parseDate},
    statut: {parse: value => parseNomenclature(value, statutsExploitation)},
    raison_abandon: {parse: parseString},
    remarque: {parse: parseString},
    id_point: {parse: parsePositiveInteger},
    id_beneficiaire: {parse: parsePositiveInteger}
  },
  requiredFields: ['id_exploitation', 'id_point']
}

export const EXPLOITATIONS_USAGES_DEFINITION = {
  schema: {
    id_exploitation: {parse: parsePositiveInteger},
    id_usage: {parse: parsePositiveInteger}
  },
  requiredFields: ['id_exploitation', 'id_usage']
}

export const EXPLOITATIONS_REGLES_DEFINITION = {
  schema: {
    id_exploitation: {parse: parsePositiveInteger},
    id_regle: {parse: parsePositiveInteger}
  },
  requiredFields: ['id_exploitation', 'id_regle']
}

export const EXPLOITATIONS_DOCUMENTS_DEFINITION = {
  schema: {
    id_exploitation: {parse: parsePositiveInteger},
    id_document: {parse: parsePositiveInteger}
  },
  requiredFields: ['id_exploitation', 'id_document']
}

export const EXPLOITATIONS_SERIES_DEFINITION = {
  schema: {
    id_exploitation: {parse: parsePositiveInteger},
    id_serie: {parse: parsePositiveInteger}
  },
  requiredFields: ['id_exploitation', 'id_serie']
}

export const PRELEVEURS_DEFINITION = {
  schema: {
    id_beneficiaire: {parse: parsePositiveInteger},
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
    numero_telephone: {parse: parseString},
    code_siren: {parse: parseString}
  },
  requiredFields: ['id_beneficiaire']
}

export const REGLES_DEFINITION = {
  schema: {
    id_regle: {parse: parsePositiveInteger},
    parametre: {parse: value => parseNomenclature(value, parametres)},
    unite: {parse: value => parseNomenclature(value, unites)},
    valeur: {parse: parseNumber},
    contrainte: {parse: value => parseNomenclature(value, contraintes)},
    debut_validite: {parse: parseDate},
    fin_validite: {parse: parseDate},
    debut_periode: {parse: parseDate},
    fin_periode: {parse: parseDate},
    remarque: {parse: parseString},
    id_document: {parse: parsePositiveInteger}
  },
  requiredFields: ['id_regle']
}

export const DOCUMENTS_DEFINITION = {
  schema: {
    id_document: {parse: parsePositiveInteger},
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

export const OUVRAGE_BNPE_DEFINITION = {
  schema: {
    code_ouvrage: {parse: parseString},
    nom_ouvrage: {parse: parseString},
    code_point_referent: {parse: parseString}
  }
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

export const SERIES_DEFINITION = {
  schema: {
    id_serie: {parse: parsePositiveInteger},
    id_point: {parse: parsePositiveInteger},
    detail_point_suivi: {parse: parseString},
    profondeur: {parse: parseNumber},
    parametre: {parse: value => parseNomenclature(value, parametres)},
    unite: {parse: value => parseNomenclature(value, unites)},
    frequence_acquisition: {parse: parseString},
    traitement: {parse: parseString},
    frequence_traitement: {parse: parseString},
    etat_prelevement: {parse: parseString},
    debut_periode: {parse: parseDate},
    fin_periode: {parse: parseDate},
    frequency: {parse: parseString},
    remarque: {parse: parseString},
    id_declaration: {parse: parsePositiveInteger},
    id_fichier: {parse: parsePositiveInteger}
  },
  requiredFields: ['id_serie', 'id_point', 'parametre', 'unite', 'frequency']
}

export const RESULTATS_SUIVI_DEFINITION = {
  schema: {
    id_resultat: {parse: parsePositiveInteger},
    id_origine: {parse: parsePositiveInteger},
    id_point: {parse: parsePositiveInteger},
    date_heure_mesure: {parse: parseDate},
    valeur: {parse: parseNumber},
    frequency: {parse: parseString},
    remarque: {parse: parseString},
    id_serie: {parse: parsePositiveInteger}
  },
  requiredFields: ['id_resultat', 'id_point', 'date_heure_mesure', 'id_serie']
}
