# Maintenance sécurité et CI

## Installer et vérifier

La version de Node est dans `.nvmrc`, celle de npm dans `packageManager`.
Les fichiers internes de npm ne sont jamais modifiés. La version officielle 11.19.1
intègre les correctifs nécessaires ([notes officielles](https://github.com/npm/cli/releases/tag/v11.19.1)).

```sh
nvm use
npm install --global "$(node -p 'require("./package.json").packageManager')" --ignore-scripts --no-audit --no-fund
npm ci
npm audit --include=dev --audit-level=low
npm audit --omit=dev --audit-level=low
bash .github/scripts/check-workflows.sh
```

Utiliser `npm ci`, sans `--force` ni `--legacy-peer-deps`. Les scripts des dépendances
sont autorisés explicitement dans `allowScripts` ; réexaminer ces autorisations à chaque
mise à jour. ShellCheck doit être installé pour valider les workflows.

## Pipelines et déploiement

Voir les [schémas et explications des trois pipelines](pipelines.md).

- Les PR vers testing/demo/prod et les déploiements appellent `quality.yml`.
  Audit, lint et tests ne sont pas recopiés dans les étapes de déploiement.
- Les commandes natives npm et Trivy bloquent sur toute vulnérabilité signalée,
  même sans correctif. Trivy bloque également un OS en fin de support.
  Les erreurs des outils échouent aussi ; aucune liste d'exclusion.
- L'image est scannée par digest avant migration/déploiement. Le digest testé
  est celui déployé, l'alias d'environnement est publié après vérification.
- Les contrôles de cible et de conservation des réglages restent obligatoires :
  pas de remplacement des variables ou secrets par une liste partielle.
- Les audits sont conservés dans les artefacts CI, hors Git.
  Les tests utilisent uniquement des données synthétiques et services jetables.

## Avant la première promotion

- [ ] Corriger les alertes bloquantes et valider les trois projets sur les commits exacts.
- [ ] Préparer sauvegardes et bascule coordonnée API/worker/orchestrateur :
  voir `prelevements-deau-api/docs/bullmq-6-migration.md`. Ne pas purger Redis.
- [ ] Recetter testing : connexion, rôles, déclarations/campagnes, compteurs,
  cartes, fichiers Excel/S3, mails et reprise des tâches.
- [ ] Promouvoir demo puis prod uniquement après décision explicite.

Les contrôles locaux ne valent ni exécution des pipelines GitHub ni recette des
services externes réels. Les branches main, demo et prod ne sont pas modifiées par ce travail.

## Particularités API

`npm run lint`, `npm run lint:openapi`, puis
`npm run coverage -- --concurrency=1 --timeout=180s`.

En CI, PostGIS 17 et Redis 7 sont jetables. Les migrations sont appliquées à une
base vide puis rejouées. Les intégrations campagnes, statistiques, permissions
et files sont activées ; les actions du front sont vérifiées sur un commit public figé.
Ne jamais fournir de base réelle à ces tests.

Les migrations demo/prod passent par les services privés existants.
Voir [leur fonctionnement](ci-private-migrations.md).

### Dépendances à surveiller

- L'override `@prisma/config@7.10.0 > deepmerge-ts = 8.0.2` reproduit le
  [correctif validé par Prisma](https://github.com/prisma/orm/pull/30189)
  pour [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx).
  Il est limité à cette version de configuration Prisma, sans patch des fichiers,
  préversion ni exclusion d'audit. Le retirer dès publication d'une version stable
  intégrant la correction ; voir [la justification et les contrôles](dependency-overrides.md).
- L'override de `mysql2` est limité à Prisma et à la même majeure (3.24.4),
  pour [GHSA-3f6p-5ww8-9rcr](https://github.com/advisories/GHSA-3f6p-5ww8-9rcr)
  et [GHSA-rgwj-5xj2-c3m3](https://github.com/advisories/GHSA-rgwj-5xj2-c3m3).
  Le retirer dès que Prisma fournit une version corrigée.
- L'override `uuid@11.1.1` préexistait dans testing ; il reste à suivre lors
  des prochaines mises à jour de ses consommateurs.
- `bullmq-v5` est un alias de test uniquement, nécessaire pour vérifier
  la compatibilité des files 5/6 ; il est absent de l'image finale.

Voir le [bilan de validation](security-validation-2026-09-11.md).
