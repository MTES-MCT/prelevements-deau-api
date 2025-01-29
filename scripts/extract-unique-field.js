import fs from 'node:fs'

// Load the dossier data
const dossiers = JSON.parse(fs.readFileSync('data/all_dossiers.json', 'utf8'))

// Extract unique field names
const uniqueDossierFields = new Set()
const uniqueFields = new Set()
for (const dossier of dossiers) {
  for (const key of Object.keys(dossier)) {
    uniqueDossierFields.add(key)
  }

  if (dossier.champs) {
    for (const champ of dossier.champs) {
      uniqueFields.add(champ.label)
    }
  }
}

fs.writeFileSync('data/unique_dossier_fields.json', JSON.stringify([...uniqueDossierFields], null, 2), 'utf8')
fs.writeFileSync('data/unique_fields.json', JSON.stringify([...uniqueFields], null, 2), 'utf8')
