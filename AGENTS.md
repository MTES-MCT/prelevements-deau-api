# Consignes de travail — API Partageons l’eau

## Rôle et repères

- Ce dépôt porte l’API métier et ses workers, pas l’interface ni les parseurs fournisseurs.
- `api.js` démarre Express ; `worker.js` démarre les workers BullMQ et leurs planifications.
- Les routes sont dans `lib/routes.js`, les handlers dans `lib/handlers/`, la validation dans `lib/validation/`, le métier dans `lib/services/` et l’accès aux données dans `lib/models/`.
- PostgreSQL/PostGIS est accessible via le client partagé `db/prisma.js` ; Redis porte BullMQ et certains caches ; les documents sont stockés sur S3 compatible.
- `prisma.config.ts` configure le schéma multifichier `prisma/schema/` et les migrations `prisma/migrations/`.
- Consulter les fichiers concernés et leurs tests avant de modifier un comportement ; ne pas prendre une ancienne documentation pour preuve de l’état actuel.

## Installation et commandes

Depuis la racine de ce dépôt : utiliser Node de `.nvmrc` et npm de `packageManager` dans `package.json`.
La configuration locale est décrite par `README.md` et `.env.example` ; ne pas afficher les fichiers d’environnement réels.

```sh
nvm use
npm ci
docker compose up -d
npx --no-install prisma validate
npx --no-install prisma generate
npm run migrate:prisma
npm run start-dev
```

- Le Compose démarre les services de développement PostgreSQL/PostGIS, Redis, MinIO et Mailpit ; ce n’est pas la pile jetable des tests.
- Préparer les buckets locaux comme indiqué dans le README. Vérifier la cible de `DATABASE_URL` avant toute migration.
- `npm start` démarre l’API sans surveillance ; `npm run start:worker` démarre séparément le worker et le scheduler.
- `npm run lint` vérifie JavaScript ; `npm run lint:openapi` valide `docs/openapi.yaml` avec Spectral.
- `npm test` lance AVA ; `npx --no-install ava chemin/du/test.js` cible un fichier existant.
- `npm run coverage` lance AVA avec c8 ; `npm run coverage:report` produit les rapports HTML et texte.
- Il n’existe pas de script npm `build` ou `typecheck` pour cette API JavaScript ESM. La génération/validation Prisma ne remplace pas les tests métier.

## Conventions et contrats

- JavaScript ESM, imports relatifs avec extension `.js`, deux espaces, guillemets simples, pas de points-virgules : suivre `eslint.config.js` et `.editorconfig`.
- Réutiliser les validations Joi et les erreurs `http-errors` ; conserver les noms de champs Prisma et les conventions des réponses existantes.
- Les textes destinés aux utilisateurs sont en français. Ne pas mélanger nettoyage global et modification fonctionnelle ciblée.
- Le front consomme les réponses HTTP, filtres, paginations et capacités d’accès : toute rupture demande une coordination explicite et des tests de contrat.
- Conserver la compatibilité des routes existantes, y compris l’alias `/api` encore monté dans `api.js`. Mettre à jour OpenAPI lorsqu’un contrat change.
- L’envoi d’une déclaration notifie l’orchestrateur par le webhook signé de `lib/services/orchestration-client.js` ; son parsing et la consommation de `process-declaration` restent côté orchestration.
- Les ingestions de comptes de service reçoivent des enveloppes normalisées. Les formats, fuseaux et codes qualité propres à un fournisseur restent dans l’orchestrateur, pas dans une route spécifique de l’API.
- Les noms/payloads des jobs sont des contrats partagés : vérifier producteurs et consommateurs avant de les modifier.

## Droits et invariants métier

- Réutiliser `lib/auth/`, `lib/services/zone-permissions.js` et `lib/services/resource-permissions.js`. Un filtre demandé ne remplace jamais un contrôle d’accès.
- Respecter la séparation sessions humaines/comptes de service, les permissions territoriales, les délégations des collecteurs et les restrictions d’impersonation.
- Les statistiques publiques n’exposent que des agrégats ; ne pas rendre une route privée anonyme pour simplifier un appel du front.
- Une référence externe identifie une ressource, sans lui accorder de droits. Le partage d’un PP ou d’un compteur ne donne pas accès aux parts `METER` des autres bénéficiaires ; préserver le contrat des séries ordinaires.
- Les index physiques globaux des compteurs et la modification de leurs répartitions restent réservés aux administrateurs selon les contrôles existants.
- Préserver les deux calculs distincts : `lib/services/volumes-from-index.js` traite `GENERIC` ; `lib/services/meter-publication.js` traite `METER`.
- Pour `METER`, calculer le volume entre deux observations physiques puis le répartir selon les affectations datées validées ; ne jamais répartir l’index lui-même ni recalculer ce volume une deuxième fois.
- Conserver l’idempotence des lots, les révisions, les conflits explicites et les parts hors périmètre. Ne pas déduire une répartition historique depuis la seule situation actuelle.
- Les lectures, agrégations et exports doivent exclure les publications rejetées et respecter le bénéficiaire. Voir `docs/meter-integration.md` et ses tests pour le contrat complet.

## Tests et vérifications proportionnées

- Pour du code : lint et tests ciblés d’abord ; élargir aux intégrations si SQL, droits, ingestions, files ou contrats sont touchés.
- Pour une modification documentaire seule : vérifier les commandes, liens, chemins et le diff ; aucun build local ni test exhaustif imposé.
- Les intégrations peuvent tronquer des tables : uniquement des données synthétiques sur PostgreSQL/PostGIS et Redis jetables, jamais une base applicative, même locale.
- `lib/util/test-helpers/disposable-database.js` exige `NODE_ENV=test`, une base `security_tests` ou `integration_tests` et, localement, `localhost:55439` sans options d’URL. Ne pas désactiver cette protection.
- Les tests Redis de migration de queues exigent localement `localhost:56391`, base `0`, `NODE_ENV=test` ; ne pas employer le Redis du développement.
- Préparer `DATABASE_URL` pour la base jetable, générer Prisma et appliquer les migrations avant les intégrations. `PUBLIC_STATS_TEST_DATABASE_URL` doit viser cette même base.
- Activer selon le périmètre `METER_INTEGRATION_TESTS=1`, `DROPT_INTEGRATION_TESTS=1` et `QUEUE_INTEGRATION_TESTS=1`. Sans ces prérequis, certains tests sont ignorés : le signaler.
- `.github/workflows/quality.yml` fournit la configuration CI de référence : services jetables, messagerie neutralisée et collecte Sentry désactivée. Adapter les ports aux gardes locaux, ne pas copier ses accès sur une base réelle.
- La suite complète d’intégration s’exécute séquentiellement : `npm run coverage -- --concurrency=1 --timeout=180s`.
- Pour le schéma : vérifier les migrations sur une base vide puis rejouer `npm run migrate:prisma`. Ne pas réécrire une migration déjà appliquée ni utiliser `db push` comme livraison.
- Pour les dépendances : préserver le lockfile, utiliser `npm ci`, vérifier `allowScripts`, lancer `npm audit --include=dev --audit-level=low` et `npm audit --omit=dev --audit-level=low` ; aucun contournement avec `--force` ou `--legacy-peer-deps`.
- Pour les workflows : `bash .github/scripts/check-workflows.sh` télécharge Actionlint avec empreinte vérifiée et requiert ShellCheck. Rapporter les vérifications réellement exécutées et leurs limites.

## Imports, files et livraison

- Le catalogue est dans `lib/queues/config.js` ; `WORKER_JOBS` limite les traitements consommés ici. Préserver retries, idempotence et arrêt propre ; ne pas purger des queues pour résoudre une erreur.
- Les imports/migrations métier ont leurs propres préconditions dans `scripts/dropt/README.md`, `scripts/reunion/README.md` et `scripts/demo/README.md`. Lire celui du script utilisé, commencer par sa simulation et vérifier le rejeu.
- Un import, un seed, un backfill, un envoi de notifications ou une modification de répartitions exige un périmètre explicitement autorisé. Ne pas lancer un script ponctuel pour « réparer » des données sans diagnostic.
- Les originaux et rapports d’import restent dans le stockage privé prévu ; `data/` est un sous-module. Vérifier ses exclusions avant copie ; ne pas ajouter ses données ou changer son pointeur par accident.
- Aucun secret, jeton, URI authentifiée, adresse privée ou donnée personnelle dans Git, les fixtures, les logs ou les captures. Pour une configuration distante autorisée, préserver toutes les valeurs et clés existantes ; ne pas remplacer une map de secrets avec des valeurs masquées.
- Les pushes sur `testing`, `demo` et `prod` déclenchent leurs workflows de déploiement. Un push est donc une action de livraison : ne l’effectuer que pour les environnements demandés.
- Livrer par la CI existante : contrôles qualité/sécurité, image immuable, migrations privées, puis même image pour API et worker. Ne pas contourner ces étapes par un déploiement manuel.
- Pour une tâche API, ne pas modifier/pousser le front ou l’orchestrateur sans nécessité et autorisation ; préserver les changements préexistants du workspace.
