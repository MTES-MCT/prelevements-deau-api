export class ErrorCollector {
  constructor() {
    this.errors = {}
  }

  addError(type, sheet, cell, data = {}) {
    this.errors[type] ||= {}
    this.errors[type][sheet] ||= []

    this.errors[type][sheet].push({cell, ...data})
  }

  getGroupedErrors() {
    const groupedErrors = []
    // Pour chaque type d'erreur
    for (const [type, sheets] of Object.entries(this.errors)) {
      for (const [sheet, errors] of Object.entries(sheets)) {
        const cells = errors.map(e => e.cell)
        let message
        let severity = 'error'
        const cellRanges = []
        for (const cell of cells) {
          const lastRange = cellRanges.at(-1)
          const cellNumber = Number.parseInt(cell.match(/\d+/)[0], 10)

          if (lastRange && cellNumber === lastRange.end + 1) {
            lastRange.end = cellNumber
          } else {
            cellRanges.push({start: cellNumber, end: cellNumber})
          }
        }

        const cellIntervals = cellRanges.map(range => range.start === range.end ? `cellule ${range.start}` : `cellules ${range.start}-${range.end}`).join(', ')

        switch (type) {
          case 'invalidDates': {
            message = `Les dates dans l'onglet '${sheet}' ne sont pas valides pour les ${cellIntervals}.`
            break
          }

          case 'invalidTimes': {
            message = `Les heures dans l'onglet '${sheet}' ne sont pas valides pour les ${cellIntervals}.`
            break
          }

          case 'missingDate': {
            message = `Le champ 'date' est obligatoire dans l'onglet '${sheet}' pour les ${cellIntervals}.`
            break
          }

          case 'missingHeure': {
            const {frequence} = errors[0]
            message = `Le champ 'heure' est obligatoire dans l'onglet '${sheet}' à la fréquence '${frequence}' pour les ${cellIntervals}.`
            break
          }

          case 'invalidDateTime': {
            message = `Les dates et heures dans l'onglet '${sheet}' ne sont pas valides pour les ${cellIntervals}.`
            break
          }

          case 'missingRemarque': {
            const {paramName} = errors[0]
            message = `Le champ 'Remarque' doit être renseigné si la valeur est manquante pour le paramètre '${paramName}' dans l'onglet '${sheet}', ${cellIntervals}.`
            severity = 'warning'
            break
          }

          default: {
            message = `Erreur inconnue de type '${type}' dans l'onglet '${sheet}' pour les ${cellIntervals}.`
            break
          }
        }

        groupedErrors.push({
          message,
          severity
        })
      }
    }

    return groupedErrors
  }
}
