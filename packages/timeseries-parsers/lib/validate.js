// Fonction pour valider si une date est dans la période du formulaire
export function validateDateInPeriod(dateValue, {startDate, endDate}) {
  dateValue = dateValue.toISOString
    ? dateValue.toISOString().slice(0, 10)
    : dateValue.slice(0, 10)

  if (startDate && endDate && (dateValue < startDate || dateValue > endDate)) {
    const error = new Error('Date en dehors de la période indiquée')
    error.explanation = `La date ${dateValue} n'est pas comprise entre le ${startDate} et le ${endDate}.`
    throw error
  }

  return dateValue
}

// Fonction pour valider qu'une valeur est numérique et positive
export function validateNumericValue(value) {
  if (value !== undefined && value !== null && value !== '') {
    // Remplacer les virgules par des points pour gérer les séparateurs décimaux
    const sanitizedValue = value.toString().replace(',', '.')
    const numericValue = Number.parseFloat(sanitizedValue)

    if (Number.isNaN(numericValue) || numericValue < 0) {
      const error = new Error('Valeur numérique invalide')
      error.explanation = `La valeur '${value}' doit être un nombre positif ou nul.`
      throw error
    }

    return numericValue
  }
}
