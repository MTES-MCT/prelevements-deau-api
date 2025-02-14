export function consolidateData(object) {
  const result = {...object}

  if (result.moisCalendairePrelevementsDeclares && result.anneePrelevement) {
    result.moisDeclaration = `${result.anneePrelevement}-${result.moisCalendairePrelevementsDeclares}`
    delete result.moisCalendairePrelevementsDeclares
    delete result.anneePrelevement
  }

  if (result.anneePrelevement) {
    result.moisDebutDeclaration = `${result.anneePrelevement}-01`
    result.moisFinDeclaration = `${result.anneePrelevement}-12`
    delete result.anneePrelevement
  }

  if (result.dateDebutSaisie) {
    result.moisDebutDeclaration = result.dateDebutSaisie.slice(0, 7)
    result.moisFinDeclaration = result.dateFinSaisie.slice(0, 7)
    delete result.dateDebutSaisie
    delete result.dateFinSaisie
  }

  return result
}
