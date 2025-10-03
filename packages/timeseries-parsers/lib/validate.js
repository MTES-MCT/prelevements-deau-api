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
