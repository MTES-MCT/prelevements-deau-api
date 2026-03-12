# Procédure d'import du territoire

Depuis la racine du projet :

```bash
# Import des zones
node scripts/import-zones.js

# Irrigants Aquasys
node scripts/blv/irrigants-aquasys/import-point-prelevements.js
node scripts/blv/irrigants-aquasys/import-declarants.js
node scripts/blv/irrigants-aquasys/import-exploitations.js
node scripts/blv/irrigants-aquasys/create-ougc-account.js

# Gestionnaires eau potable + industriels non ICEP (template file)
node scripts/blv/template-files/import-point-prelevements.js
node scripts/blv/template-files/import-declarants.js
node scripts/blv/template-files/import-exploitations.js
node scripts/blv/template-files/import-volumes.js

# Instructeurs
node scripts/blv/import-instructors.js
```
