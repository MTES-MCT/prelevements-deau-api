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
    // Prevent duplicates
    if (!this.errors[type].some(e => e.cell === cell)) {
      this.errors[type].push({cell, ...data})
    }
  }

  hasErrors() {
    return Object.keys(this.errors).length > 0 || this.singleErrors.length > 0
  }

  getErrors() {
    const groupedErrors = []

    for (const [type, errors] of Object.entries(this.errors)) {
      const rowNumbers = [...new Set(errors.map(e => Number.parseInt(e.cell.match(/\d+/)[0], 10)))].sort((a, b) => a - b)

      const ranges = []
      if (rowNumbers.length > 0) {
        let start = rowNumbers[0]
        let end = rowNumbers[0]
        for (let i = 1; i < rowNumbers.length; i++) {
          if (rowNumbers[i] === end + 1) {
            end = rowNumbers[i]
          } else {
            ranges.push({start, end})
            start = rowNumbers[i]
            end = rowNumbers[i]
          }
        }

        ranges.push({start, end})
      }

      const totalErrorRows = rowNumbers.length
      let intervals
      let preposition

      if (ranges.length > 5) {
        intervals = `${totalErrorRows} lignes`
        preposition = 'de'
      } else {
        intervals = ranges.map(range => {
          if (range.start === range.end) {
            return `la ligne ${range.start}`
          }

          return `des lignes ${range.start} à ${range.end}`
        }).join(', ')
        preposition = 'pour'
      }

      let message
      let severity = 'error'

      switch (type) {
        case 'invalidDates': {
          message = `Les dates ${preposition} ${intervals} de l'onglet '${this.sheetName}' ne sont pas valides.`
          break
        }

        case 'invalidTimes': {
          message = `Les heures ${preposition} ${intervals} de l'onglet '${this.sheetName}' ne sont pas valides.`
          break
        }

        case 'missingDate': {
          message = `Le champ 'date' est obligatoire ${preposition} ${intervals} de l'onglet '${this.sheetName}'.`
          break
        }

        case 'missingHeure': {
          message = `Le champ 'heure' est obligatoire ${preposition} ${intervals} de l'onglet '${this.sheetName}'.`
          break
        }

        case 'missingRemarque': {
          const {paramName} = errors[0]
          message = `Le champ 'Remarque' doit être renseigné si la valeur est manquante pour le paramètre '${paramName}' ${preposition} ${intervals} de l'onglet '${this.sheetName}'.`
          severity = 'warning'
          break
        }

        case 'invalidDateRange': {
          const {startDate, endDate} = errors[0]
          message = `Les dates ${preposition} ${intervals} de l'onglet '${this.sheetName}' doivent être comprises entre le ${startDate} et le ${endDate}.`
          break
        }

        case 'invalidInterval': {
          message = `Le pas de temps est incorrect ${preposition} ${intervals} de l'onglet '${this.sheetName}'.`
          break
        }

        default: {
          message = `Erreur inconnue de type '${type}' ${preposition} ${intervals} de l'onglet '${this.sheetName}'.`
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
