# Scripts

## Scripts npm

| Script | Usage |
| --- | --- |
| `npm start` | Démarre l'API Express. |
| `npm run start-dev` | Démarre l'API avec Nodemon. |
| `npm run start:worker` | Démarre les workers BullMQ internes à l'API. |
| `npm run import-bvtech` | Importe les données BVTech depuis `data/bvtech` ou le chemin configuré dans le script. |
| `npm run migrate:prisma` | Applique les migrations Prisma en environnement cible. |
| `npm run user:create` | Crée un utilisateur depuis la ligne de commande. |
| `npm run lint` | Lance XO. |
| `npm run lint:openapi` | Valide `docs/openapi.yaml` avec Spectral. |
| `npm test` | Lance les tests AVA. |
| `npm run coverage` | Lance les tests avec c8. |
| `npm run coverage:report` | Génère les rapports de couverture texte et HTML. |

## Imports spécialisés

Les scripts spécialisés hors npm sont conservés dans `scripts/` et doivent être lancés explicitement avec Node.js quand ils sont nécessaires :

- `scripts/blv/**/import-volumes.js`
- `scripts/bvtech/*.js`
- `scripts/dropt/**`
- `scripts/demo/init-demo-declarations.js`

Avant de lancer un import, vérifier les variables `.env`, l'accès PostgreSQL, l'accès S3 et la présence des fichiers source dans `data/`.
