# Test Helpers

Utilitaires pour faciliter l'écriture des tests, notamment pour MongoDB.

## Helpers MongoDB

### `setupTestMongo(test)`

Configure une instance MongoDB isolée (MongoMemoryServer) pour un fichier de test.

**Usage :**

```javascript
import test from 'ava'
import {setupTestMongo} from '../../util/test-helpers/mongo.js'

setupTestMongo(test)

test.serial('mon test', async t => {
  // mongo.db est disponible et isolé pour ce fichier
})
```

**Important :** Les tests utilisant MongoDB doivent utiliser `test.serial()` pour s'exécuter séquentiellement **au sein du fichier**.

### `cleanupCollections(test, collections)`

Nettoie les collections spécifiées avant chaque test.

**Usage :**

```javascript
import test from 'ava'
import {setupTestMongo, cleanupCollections} from '../../util/test-helpers/mongo.js'

setupTestMongo(test)
cleanupCollections(test, ['exploitations', 'preleveurs', 'sequences'])

test.serial('mon test', async t => {
  // Les collections sont vidées avant chaque test
})
```

## Architecture

### Parallélisation des tests

Chaque fichier de test MongoDB :
- Crée sa propre instance MongoMemoryServer
- Se connecte via le singleton `mongo` avec une URI unique
- S'exécute en parallèle avec les autres fichiers
- Les tests au sein d'un fichier restent séquentiels (`test.serial`)

### Avantages

- ✅ **Performance** : fichiers de test en parallèle (~50-70% plus rapide)
- ✅ **Isolation** : chaque fichier a sa propre base de données
- ✅ **Simplicité** : pas de refactoring du code de production
- ✅ **Compatibilité** : utilise le singleton `mongo` existant

### Schéma d'exécution

```
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ Fichier A       │  │ Fichier B       │  │ Fichier C       │
│                 │  │                 │  │                 │
│ MongoMemory 1   │  │ MongoMemory 2   │  │ MongoMemory 3   │
│ ├─ test 1       │  │ ├─ test 1       │  │ ├─ test 1       │
│ ├─ test 2       │  │ ├─ test 2       │  │ ├─ test 2       │
│ └─ test 3       │  │ └─ test 3       │  │ └─ test 3       │
└─────────────────┘  └─────────────────┘  └─────────────────┘
     (serial)             (serial)             (serial)
         └────────────────────┴────────────────────┘
                    Exécution parallèle
```

## Conventions

- Utiliser `test.serial()` pour tous les tests MongoDB
- Appeler `setupTestMongo(test)` en début de fichier
- Utiliser `cleanupCollections()` si besoin de nettoyer avant chaque test
- Ne pas utiliser `mongo.connect()` ou `mongo.disconnect()` manuellement
