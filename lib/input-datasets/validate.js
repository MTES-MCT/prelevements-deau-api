// Fonction pour valider si une date est dans la période du formulaire
export function validateDateInPeriod(dateValue, rowIndex, context) {
  const {startDate, endDate, errors} = context

  dateValue = dateValue.toISOString
    ? dateValue.toISOString().slice(0, 10)
    : dateValue.slice(0, 10)

  if (startDate && endDate && (dateValue < startDate || dateValue > endDate)) {
    errors.push({
      message: `Ligne ${rowIndex}: La date ${dateValue} n'est pas comprise entre le ${startDate} et le ${endDate} (période du formulaire).`
    })
  }
}

// Fonction pour valider qu'une valeur est numérique et positive
export function validateNumericValue(value, rowIndex, colIndex, context) {
  if (value !== undefined && value !== null && value !== '') {
    // Remplacer les virgules par des points pour gérer les séparateurs décimaux
    const sanitizedValue = value.toString().replace(',', '.')
    const numericValue = Number.parseFloat(sanitizedValue)
    if (Number.isNaN(numericValue) || numericValue < 0) {
      context.errors.push({
        message: `Ligne ${rowIndex}, Colonne ${colIndex + 1}: La valeur '${value}' doit être un nombre positif.`
      })
    }
  }
}
