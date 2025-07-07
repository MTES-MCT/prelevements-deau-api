import {pick} from 'lodash-es'

export class ErrorCollector {
  constructor(sheetName) {
    this.sheetName = sheetName
    this.singleErrors = []
    this.errors = {}
  }

  addSingleError(error) {
    this.singleErrors.push(pick(error, 'message', 'explanation', 'severity'))
  }

  addError(type, cell, data = {}) {
    this.errors[type] ||= []
    this.errors[type].push({cell, ...data})
  }

  hasErrors() {
    return Object.keys(this.errors).length > 0 || this.singleErrors.length > 0
  }

  getErrors() {
    const groupedErrors = []
    // Pour chaque type d'erreur
    for (const [type, errors] of Object.entries(this.errors)) {
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
          message = `Les dates dans l'onglet '${this.sheetName}' ne sont pas valides pour les ${cellIntervals}.`
          break
        }

        case 'invalidTimes': {
          message = `Les heures dans l'onglet '${this.sheetName}' ne sont pas valides pour les ${cellIntervals}.`
          break
        }

        case 'missingDate': {
          message = `Le champ 'date' est obligatoire dans l'onglet '${this.sheetName}' pour les ${cellIntervals}.`
          break
        }

        case 'missingHeure': {
          message = `Le champ 'heure' est obligatoire dans l'onglet '${this.sheetName}' pour les ${cellIntervals}.`
          break
        }

        case 'invalidDateTime': {
          message = `Les dates et heures dans l'onglet '${this.sheetName}' ne sont pas valides pour les ${cellIntervals}.`
          break
        }

        case 'missingRemarque': {
          const {paramName} = errors[0]
          message = `Le champ 'Remarque' doit être renseigné si la valeur est manquante pour le paramètre '${paramName}' dans l'onglet '${this.sheetName}', ${cellIntervals}.`
          severity = 'warning'
          break
        }

        case 'invalidDateRange': {
          const {startDate, endDate} = errors[0]
          message = `Les dates dans l'onglet '${this.sheetName}' doivent être comprises entre le ${startDate} et le ${endDate} pour les ${cellIntervals}.`
          break
        }

        case 'invalidInterval': {
          message = `Le pas de temps entre les lignes ${cellIntervals} de l'onglet ${this.sheetName} est incorrect`
          break
        }

        default: {
          message = `Erreur inconnue de type '${type}' dans l'onglet '${this.sheetName}' pour les ${cellIntervals}.`
          break
        }
      }

      groupedErrors.push({
        message,
        severity
      })
    }

    return [
      ...this.singleErrors,
      ...groupedErrors
    ]
  }
}
