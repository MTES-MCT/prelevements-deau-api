# @fabnum/prelevements-deau-timeseries-parsers

Ce package fournit des fonctions pour valider et parser les fichiers de séries temporelles relatifs aux prélèvements d'eau.

Il prend en charge deux types de fichiers :
* les fichiers de données standardisées multi-paramètres
* les fichiers de tableau de suivi de prélèvement (camion citerne)

## Installation

```bash
npm install @fabnum/prelevements-deau-timeseries-parsers
```

## Utilisation

```javascript
import {validateMultiParamFile} from '@fabnum/prelevements-deau-timeseries-parsers'

// Exemple avec un fichier multi-paramètres
const fileBuffer = // ... votre buffer de fichier

async function main() {
  const {data, errors} = await validateMultiParamFile(fileBuffer)

  if (data) {
    console.log('Le fichier est valide.')
    console.log('Données consolidées:', data)
    if (errors.length > 0) {
      console.warn('Avertissements de validation:', errors)
    }
  } else {
    console.error('Erreurs de validation:', errors)
  }
}

main()
```