# Sécurité et maintenabilité : bilan du 11 septembre 2026

Ce bilan décrit la version nettoyée, sans correcteur des fichiers internes de npm.
Le dernier correctif Prisma est une exception npm déclarative, limitée à
`@prisma/config@7.10.0 > deepmerge-ts@8.0.2` et conforme au correctif validé
par les mainteneurs de Prisma. Aucun fichier de dépendance n'est réécrit.

## Nettoyage effectué

- Suppression du patch npm et de ses tests dans les trois dépôts.
  Installation ordinaire de npm 11.19.1 depuis la version du `packageManager`.
  Le npm local de Node 24.21.0 a également été restauré à sa distribution officielle.
- Suppression des parseurs d'audit maison : commandes natives npm et Trivy,
  échec sur toute alerte ou erreur d'outil. Le pipeline conserve le code d'erreur
  de npm malgré l'écriture du rapport avec `tee` (`pipefail` explicite).
- Un seul pipeline qualité par projet, appelé avant déploiement ; suppression
  des tests/lint/build front inutilement rejoués dans les étapes de déploiement.
- Configurations ESLint explicites et courtes, sans l'accumulation d'exceptions XO.
  L'orchestrateur utilise un seul TypeScript, version 6.
- Scripts API de migration/statut/déploiement mutualisés, en conservant les
  points d'entrée et garde-fous spécifiques aux environnements.
  Cibles front/orchestrateur définies une seule fois par dépôt.
- Testing ne désactive plus la vérification globale des réglages : seuls ses
  ajustements explicites de probes API et commande worker sont autorisés.
  La sonde de santé du worker est désormais obligatoire dans les trois environnements.
- Exports tabulaires du front revenus au navigateur : suppression du convertisseur
  HTTP, des quotas et du verrou partagé. Le modèle Excel enrichi conserve une route
  serveur authentifiée pour préserver sa mise en forme et ses listes déroulantes.

## Exceptions temporaires et points de vigilance

Le blocage de l'API sur deepmerge-ts est corrigé par l'override ciblé décrit
ci-dessus. Il reproduit exactement la version choisie dans le
[correctif officiel Prisma](https://github.com/prisma/orm/pull/30189), dont les
ruptures ne concernent pas les fonctions utilisées par Prisma. Le retirer dès
qu'une version stable de Prisma intègre ce correctif ; aucune exclusion d'audit
ni préversion de Prisma n'est utilisée.

Un override **de même majeure**, limité à `prisma > mysql2`, reste nécessaire.
L'override uuid préexistait sur testing ; côté front il est désormais limité
à NextAuth. Voir [les dépendances à surveiller](dependency-overrides.md).

Autres limites signalées : le modèle Excel utilise encore l'ancienne bibliothèque
`xlsx-populate`, limitée au serveur et au modèle versionné ; Storybook dépend
transitivement de `tsconfck`, déclaré non maintenu. Pas d'alerte npm détectée
sur ces deux bibliothèques à cette date. Le nouveau lint React, compatible avec
ESLint 10 maintenu, ne détecte plus les attributs JSX dupliqués : cette limite
est documentée, sans règle maison ni forçage des dépendances pairs.

## Validation locale avant relecture

Cet instantané précède les corrections de la section suivante. Il reste la trace
des contrôles d'images déjà effectués, pas une attestation des nouvelles sources.

| Contrôle final | API | Front | Orchestrateur |
| --- | --- | --- | --- |
| Audit npm complet et production | 0 | 0 | 0 |
| Scan de l'image finale | 0 | 0 | 0 |
| Tests applicatifs | 1 696 réussis | 1 424 réussis | 58 réussis |
| Lint | 0 erreur, 53 avertissements | 0 erreur, 5 avertissements | 0 erreur |
| Build | Prisma et Docker | Next, Storybook et Docker | TypeScript et Docker |

- API : 111 migrations appliquées à une base PostGIS 17 vierge, deuxième passage
  idempotent ; intégrations campagnes/statistiques/droits/Redis activées. Couverture :
  62,04 % des lignes, 81,82 % des branches, 63,08 % des fonctions.
  OpenAPI : 0 erreur et 1 avertissement historique.
- Correctif Prisma : cinq tests supplémentaires chargent le vrai `prisma.config.ts`
  avec l'API publique de Prisma, dans des processus isolés sans environnement réel.
  Chemins, génération sans URL, TLS strict et refus des configurations invalides
  sont vérifiés. La CLI de l'image Alpine charge également cette configuration,
  vérifie les 111 migrations sans en rejouer et exécute une requête PostgreSQL.
- Déploiements : 147 tests API migration/déploiement inclus dans sa suite ;
  97 tests de déploiement rejoués indépendamment. Front et orchestrateur :
  10 tests supplémentaires de garde-fous CI chacun, sans appel Scaleway réel.
- Front : 37 scénarios Chromium/WebKit/mobile et export volumineux réussis contre
  l'image finale limitée à 512 Mio. Un export de 500 000 cellules est généré
  dans le navigateur puis relu, sans requête de conversion, en environ 4,9 s.
- Images : chargement natif Sentry/Prisma/Sharp ; aller-retour XLSX orchestrateur.
  API `/healthz`, worker `/health` et orchestrateur `/health` répondent 200.
  API/worker s'arrêtent proprement par SIGTERM, sans OOM.
- Actionlint, ShellCheck et `git diff --check` réussissent dans les trois dépôts.

Les audits API complets/production et le scan de l'image corrigée sortent avec
le code 0, sans exclusion d'alerte. Ces résultats correspondent aux versions
verrouillées et bases de vulnérabilités consultées à cette date ; les audits
seront rejoués en CI.

Images locales de cet instantané (antérieures aux correctifs de relecture,
pas des digests publiés au registre) :

```text
API           sha256:7d385804ebb4ad6cf57c6032607a22704eb37116687a66305aa9c82238724cdf
Front         sha256:b925274fabe7555b4f46e1814c2affe1f3c0968860d074df2e792d435aae615f
Orchestrateur sha256:1f4452af5e825aa204d45a51158a7ab8478be97a0eaf103ea88128108dfd2504
```

Les tests utilisent PostGIS/Redis jetables et des fixtures synthétiques, sans
charger de base réelle ni de fichiers d'environnement. Les installations du front
et de l'orchestrateur sont réalisées dans des copies isolées pour préserver
les serveurs de développement existants.
Refaire `npm ci` avant leur prochain redémarrage local. Les conteneurs et réseaux
jetables de validation ont été supprimés ; seules leurs données synthétiques
ont été retirées. Les images et rapports de validation restent disponibles localement.

## Corrections issues de la relecture

- MUI : utilisation des `slotProps` actuels dans le formulaire personne morale,
  avec tests navigateur du vrai formulaire (recherche, clavier, préremplissage,
  effacement et erreur de recherche sans bloquer la saisie manuelle).
- CI : ShellCheck reçoit directement les fichiers sélectionnés par Bash, sans
  dépendre de `rg` ni masquer l'échec d'un sous-processus. Vérifié dans les trois
  dépôts avec `rg` rendu indisponible ; un échec ShellCheck simulé ressort bien
  avec son code 42, au lieu d'un succès.
- BullMQ : identifiants de planification applicatifs imposés, conversion UTC
  explicite, refus des migrations ambiguës avant construction de Queue. Les tests
  couvrent le redémarrage du vrai scheduler et les migrations sur Redis jetable.
- BV-Tech : les tests supplémentaires ont révélé un défaut de date préexistant.
  L'[option officielle SheetJS `UTC`](https://docs.sheetjs.com/docs/csf/features/dates/#utc-option)
  conserve le jour Excel pour le calcul des volumes à J-1. Douze scénarios couvrent
  XLS/XLSX, UTC/Paris, calendriers 1900/1904, hiver/été, heures et formats historiques.

| Validation après correction | Résultat |
| --- | --- |
| API, suite complète avec intégrations PostgreSQL/Redis | 1 703 tests réussis |
| Front, suite AVA | 1 424 tests réussis |
| Front, Chromium/WebKit/mobile et export volumineux | 43 tests réussis |
| Orchestrateur, suite complète avec Redis | 70 tests réussis, aucun ignoré |
| Garde-fous de déploiement front/orchestrateur | 10 tests réussis par dépôt, Scaleway simulé |
| Migrations PostgreSQL sur base jetable | 111 appliquées, deuxième passage sans migration à appliquer |
| Builds | Next.js, Storybook et TypeScript réussis |
| Lint et workflows | Aucune erreur ; avertissements existants inchangés |

Le formulaire corrigé est exercé avec son vrai bundle Storybook reconstruit.
Next.js a également été reconstruit avec un environnement CI synthétique, sans
fichier `.env`. Les tests Redis utilisent un service dédié au port 56391, distinct
des services locaux existants ; PostgreSQL est jetable au port 55439.

Les dépendances et lockfiles ne changent pas pour ces corrections. Les audits npm
complets et production ont été rejoués : zéro vulnérabilité dans les trois dépôts.
Les images ci-dessus n'ont pas été reconstruites pour ce correctif ; les pipelines
devront construire, scanner et vérifier les nouveaux digests avant déploiement.

Voir les [schémas et explications des pipelines](pipelines.md).

## Publication

Au moment de cette validation locale, aucun commit, push ni déploiement n'avait
été réalisé. Les branches main/demo/prod, les données, certificats, secrets et
fichiers d'environnement n'ont pas été modifiés par ces contrôles.

Les workflows sont vérifiés localement, pas exécutés sur GitHub. Les tests locaux
ne garantissent pas l'absence absolue de régression ni le fonctionnement des
services externes propres à chaque environnement.

- [x] Résoudre l'alerte Prisma par le correctif amont ciblé, sans masquer l'audit.
- [ ] Valider les trois pipelines sur leurs commits exacts.
- [ ] Préparer la bascule coordonnée API/worker/orchestrateur et les sauvegardes :
  [guide BullMQ 6](bullmq-6-migration.md).
- [ ] Recetter testing : authentification/rôles, campagnes, déclarations, compteurs,
  graphiques/cartes, imports/exports, mails et S3.
- [ ] Autoriser explicitement demo puis prod après recette.

Les guides `docs/security-modernisation.md` de chaque dépôt contiennent
les commandes de reproduction. Les rapports npm/Trivy sont dans
`.artifacts/security/`, hors Git.
