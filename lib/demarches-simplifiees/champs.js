function parsePointPrelevement(value) {
  if (/^\d+\s\|\s(.+)$/.test(value)) {
    return Number(value.split(' | ')[0].trim())
  }

  if (/^\d+\s-\s(.+)$/.test(value)) {
    return Number(value.split(' - ')[0].trim())
  }

  if (/^\d+\s(.+)$/.test(value)) {
    return Number(value.split(' ')[0].trim())
  }

  throw new Error(`Point de prélèvement invalide : ${value}`)
}

function parseAnneePrelevement(value) {
  const string = String(value).trim()

  if (!/^\d{4}$/.test(string)) {
    throw new Error(`Année de prélèvement invalide : ${string}`)
  }

  return string
}

function parseNumeroArreteAot(value) {
  if (!value) {
    return null
  }

  const regex = /20(\d{2})-(n°)?(\d{1,3})/i
  const match = value.match(regex)

  if (match) {
    // Retourne le numéro d'arrêté sous la forme YYYY-NNN
    return `20${match[1]}-${match[3].padStart(3, '0')}`
  }

  throw new Error(`Numéro d'arrêté AOT invalide : ${value}`)
}

function parseMois(value) {
  if (!value) {
    return null
  }

  const regex = /^(\d{2})(\/|-)(\d{4})$/
  const match = value.match(regex)

  if (match) {
    return `${match[3]}-${match[1]}`
  }

  throw new Error(`Mois invalide : ${value}`)
}

export const DESCRIPTORS_MAPPING = {
  // Structure du formulaire
  'Q2hhbXAtMjM3ODg1Mw==': {type: 'ignore'},
  'Q2hhbXAtMzg4ODQ4OQ==': {type: 'ignore'},
  'Q2hhbXAtMzk4ODU2Ng==': {type: 'ignore'},
  'Q2hhbXAtMzg4ODUxMw==': {type: 'ignore'},
  'Q2hhbXAtMzk4ODU2NA==': {type: 'ignore'},
  'Q2hhbXAtMjM3OTA4NA==': {type: 'ignore'},
  'Q2hhbXAtMzg4ODUxNQ==': {type: 'ignore'},
  'Q2hhbXAtMzk4ODU2Mg==': {type: 'ignore'},
  'Q2hhbXAtMzY2MDQ5MQ==': {type: 'ignore'},
  'Q2hhbXAtMzg4ODUyOA==': {type: 'ignore'},
  'Q2hhbXAtMzg4ODUyOQ==': {type: 'ignore'},
  'Q2hhbXAtMzY0Mzg5Nw==': {type: 'ignore'},
  'Q2hhbXAtNDI3MjY3OA==': {type: 'ignore'},
  'Q2hhbXAtNDI3MjY4MA==': {type: 'ignore'},
  'Q2hhbXAtNDI3MjY4MQ==': {type: 'ignore'},
  'Q2hhbXAtNDI3MjcyMA==': {type: 'ignore'},
  'Q2hhbXAtMzkxNDgxMQ==': {type: 'ignore'},
  'Q2hhbXAtMzY0Mjc4MQ==': {type: 'ignore'},
  'Q2hhbXAtMzg4ODYxMQ==': {type: 'ignore'},
  'Q2hhbXAtNDQ2NzAyMA==': {type: 'ignore'},
  'Q2hhbXAtMzk4ODQ2OQ==': {type: 'ignore'}, // Champ utilisé pour une condition du formulaire

  // Champs abandonnées
  'Q2hhbXAtNDI3MjY4OA==': {type: 'ignore'},
  'Q2hhbXAtNDI3MjcwMg==': {type: 'ignore'},

  // Déclarant
  'Q2hhbXAtMzY0Mjc3MA==': {type: 'string', target: 'declarant.coordonnes'},
  'Q2hhbXAtMzY0Mjc3NA==': {type: 'string', target: 'declarant.email'},
  'Q2hhbXAtMzY0Mjc3NQ==': {type: 'string', target: 'declarant.telephone'},
  'Q2hhbXAtMzY0Mjc3Nw==': {
    type: 'enum',
    valuesMapping: {
      Particulier: 'particulier',
      'Représentant d\'une structure': 'representant-structure'
    },
    target: 'declarant.type'
  },
  'Q2hhbXAtMzY0Mjc3OA==': {type: 'string', target: 'declarant.raisonSociale'},
  'Q2hhbXAtNDI3MjcwNQ==': {type: 'string', target: 'natureDeclarant'},
  'Q2hhbXAtNDI3MjcwOQ==': {type: 'string', target: 'motifTierceDelegation'},

  // Informations annexes liées à la démarche
  'Q2hhbXAtNDE1Mjg1NQ==': {type: 'boolean', target: 'prelevementSurPeriodeDeclaration'}, // Si false alors pas de prélèvement sur période
  'Q2hhbXAtNDE1MzAwNA==': {type: 'boolean', target: 'prelevementSurPeriodeDeclaration'}, // Alias
  'Q2hhbXAtNDMyNDk1MA==': {type: 'boolean', target: 'prelevementSurPeriodeDeclaration'}, // Alias
  'Q2hhbXAtMjM3OTA4Ng==': {type: 'boolean', target: 'declarationExactitude'},
  'Q2hhbXAtMzY0NTA5NA==': {type: 'string', target: 'commentaires'},

  // Période de déclaration
  'Q2hhbXAtNDQ2MDY2Mg==': {type: 'ignore'}, // UX
  'Q2hhbXAtNDQ2MDY2NA==': {type: 'string', target: 'moisDeclaration', parse: parseMois},
  'Q2hhbXAtNDQ2MDY2OQ==': {type: 'string', target: 'moisDebutDeclaration', parse: parseMois},
  'Q2hhbXAtNDQ2MDY3OA==': {type: 'string', target: 'moisFinDeclaration', parse: parseMois},
  'Q2hhbXAtMzk4ODQ0MQ==': {type: 'date', target: 'dateDebutSaisie'}, // Forme abandonnée
  'Q2hhbXAtMzk4ODQ0Mg==': {type: 'date', target: 'dateFinSaisie'}, // Forme abandonnée
  'Q2hhbXAtMzkwMjIwOQ==': {
    type: 'string',
    parse: parseAnneePrelevement,
    target: 'anneePrelevement'
  }, // Forme abandonnée
  'Q2hhbXAtNDI3Nzg5MA==': {
    type: 'enum',
    target: 'moisCalendairePrelevementsDeclares',
    valuesMapping: {
      Janvier: '01',
      Février: '02',
      Mars: '03',
      Avril: '04',
      Mai: '05',
      Juin: '06',
      Juillet: '07',
      Août: '08',
      Septembre: '09',
      Octobre: '10',
      Novembre: '11',
      Décembre: '12'
    }
  }, // Forme abandonnée

  // Contexte de prélèvement
  'Q2hhbXAtMzg4ODQ3Mg==': {
    type: 'enum',
    valuesMapping: {
      'Prélèvement par camion citerne': 'camion-citerne',
      'Prélèvement AEP ou en ZRE': 'aep-zre',
      'Prélèvement ICPE hors ZRE': 'icpe-hors-zre',
      'Autre prélèvement (agricole, domestique...)': 'autre'
    },
    target: 'typePrelevement'
  },
  'Q2hhbXAtMzkxNTE0Ng==': {type: 'string', parse: parseNumeroArreteAot, target: 'numeroArreteAot'}, // Non renseigné dans certains cas

  // Prélèvements de type "Autre"
  'Q2hhbXAtMjM3ODc3MQ==': {
    type: 'string',
    parse: parsePointPrelevement,
    target: 'pointPrelevement'
  },
  'Q2hhbXAtMzY0Mjc3OQ==': {type: 'string', target: 'miseEnServicePointPrelevement'}, // Information collectée
  'Q2hhbXAtMzg4ODU0OQ==': {
    type: 'object',
    array: true,
    target: 'relevesIndex',
    itemDefinition: {
      'Q2hhbXAtMzg4ODU5OA==': {type: 'date', target: 'date'},
      'Q2hhbXAtMzg4ODU5OQ==': {type: 'float', target: 'valeur'}
    }
  },

  // Informations compteur (uniquement pour les prélèvements de type Autre)
  'Q2hhbXAtMzY2MDY2Nw==': {type: 'boolean', target: 'compteur.compteurVolumetrique'},
  'Q2hhbXAtMzY0MzkxMA==': {type: 'string', target: 'compteur.numeroSerie'},
  'Q2hhbXAtMjM3ODc5OA==': {type: 'boolean', target: 'compteur.lectureDirecte'},
  'Q2hhbXAtMjM3ODk4Nw==': {type: 'boolean', target: 'compteur.signalementPanneOuChangement'},
  'Q2hhbXAtMjM3OTAyOQ==': {type: 'float', target: 'compteur.indexAvantPanneOuChangement'},
  'Q2hhbXAtMjM3OTAzMA==': {type: 'float', target: 'compteur.indexApresReparationOuChangement'},
  'Q2hhbXAtNTE1MTgxMQ==': {type: 'date', target: 'compteur.dateChangement'},
  'Q2hhbXAtNDMxNzI0OA==': {type: 'boolean', target: 'compteur.informationsCompteurDejaRenseignees'},
  // Coefficient multiplicateur du compteur => champ à retrouver dans DS

  // Prélèvements par camion citerne
  'Q2hhbXAtMzg4ODQ5NQ==': {type: 'boolean', target: 'connaissancePrecisePrelevements'},
  // Si connaissance non précise, on récupère les volumes pompés
  'Q2hhbXAtMzg4ODQ5MA==': {
    type: 'object',
    array: true,
    target: 'volumesPompes',
    itemDefinition: {
      'Q2hhbXAtMzg4ODQ5Nw==': {
        type: 'string',
        parse: parsePointPrelevement,
        target: 'pointPrelevement'
      },
      'Q2hhbXAtMzg4ODQ5Ng==': {
        type: 'string',
        target: 'datePrelevement'
      },
      'Q2hhbXAtMzg4ODUyMA==': {
        type: 'string',
        parse: parseAnneePrelevement,
        target: 'anneePrelevement'
      },
      'Q2hhbXAtMzg4ODUxMg==': {
        type: 'integer',
        target: 'volumePompeM3'
      }
    }
  },
  'Q2hhbXAtMzk4ODQ3NQ==': {type: 'file', target: 'registrePrelevementsTableur'},
  'Q2hhbXAtNDQ2NzAyMQ==': {type: 'file', target: 'tableauSuiviPrelevements'},

  // Prélèvements AEP / ZRE
  'Q2hhbXAtMzY0Mjc4Mw==': {
    type: 'object',
    array: true,
    target: 'donneesPrelevements',
    itemDefinition: {
      'Q2hhbXAtNDAxNzE5MQ==': {
        type: 'string',
        array: true,
        parse: parsePointPrelevement,
        target: 'pointsPrelevements'
      },
      'Q2hhbXAtNDQ2NTgwNw==': {type: 'boolean', target: 'prelevementSurPeriode'},
      'Q2hhbXAtMzY0MjgxNw==': {type: 'file', target: 'fichier'},
      'Q2hhbXAtNDAxNzUzMQ==': {type: 'file', target: 'documentAnnexe'}
    }
  },

  // Registres papier (obsolète)
  'Q2hhbXAtMzkxNTEwMA==': {
    type: 'object',
    array: true,
    target: 'extraitsRegistrePapier',
    itemDefinition: {
      'Q2hhbXAtMzkxNTEwMg==': {type: 'file', target: 'fichier'}
    }
  },

  // Retour usager
  'Q2hhbXAtNDI3MjY4Mw==': {type: 'integer', target: 'retourUsager.noteFacilitePriseEnMain'},
  'Q2hhbXAtNDI3MjY4NA==': {type: 'string', target: 'retourUsager.commentaireFacilitePriseEnMain'},
  'Q2hhbXAtNDI3MjY4Ng==': {type: 'string', target: 'retourUsager.tempsRemplissage'},
  'Q2hhbXAtNDI3MjY4Nw==': {type: 'string', target: 'retourUsager.suggestionReductionTempsRemplissage'},
  'Q2hhbXAtNDI3MjY4OQ==': {type: 'string', target: 'retourUsager.tempsPreparationDonnees'},
  'Q2hhbXAtNDI3MjY5Mg==': {type: 'string', target: 'retourUsager.suggestionReductionTempsPreparationDonnees'},
  'Q2hhbXAtNDI3MjcxMQ==': {type: 'boolean', target: 'retourUsager.souhaitCourrielRappelMensuel'},
  'Q2hhbXAtNDI3MjcxMw==': {type: 'string', target: 'retourUsager.noteSouhaitDocumentationDemarche'},
  'Q2hhbXAtNDI3MjcxNA==': {type: 'string', array: true, target: 'retourUsager.formeSouhaiteeDocumentationDemarche'},
  'Q2hhbXAtNDI3MjcyMw==': {type: 'string', target: 'retourUsager.besoinOutilVisualisation'},
  'Q2hhbXAtNDI3MjcyNA==': {type: 'boolean', target: 'retourUsager.acceptationContactBesoinOutilVisualisation'}
}
