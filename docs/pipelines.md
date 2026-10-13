# Comprendre les pipelines

Ce document décrit les workflows de qualité, sécurité et déploiement des trois dépôts :
`prelevements-deau-api`, `prelevements-deau-front` et `partageonsleau-orchestration`.
Il décrit leur fonctionnement, pas une exécution réussie sur GitHub ou Scaleway.

## 1. Quand se déclenchent-ils ?

| Action Git | Ce qui se passe |
| --- | --- |
| Ouvrir ou mettre à jour une PR vers `testing`, `demo` ou `prod` | Contrôles qualité et sécurité, sans déploiement. |
| Pousser sur `testing` | Contrôles, puis déploiement du dépôt concerné sur testing si tout passe. |
| Pousser sur `demo` | Même principe, uniquement sur demo. |
| Pousser sur `prod` | Même principe, uniquement sur prod. |
| Pousser une branche de travail sans PR | Pas de déclenchement de `quality.yml` par ce seul push. |

Le front et l'orchestrateur proposent aussi un lancement manuel des workflows testing
et demo. La branche sélectionnée doit correspondre à l'environnement demandé.
Les workflows historiques des autres branches ne sont pas modifiés par ces corrections.

## 2. Le contrôle commun : `quality.yml`

Ce workflow est réutilisé par le déploiement. Les audits de sécurité tournent en
parallèle des tests du projet. L'organisation des tests dépend du dépôt :

```text
             PR ou début du déploiement
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
      SÉCURITÉ / CI          QUALITÉ / TESTS
      Node et npm fixés      Node et npm fixés
      npm ci                 npm ci
      Audits npm             Lint
      Actionlint             Tests du projet
      ShellCheck             Build si applicable
              │                     │
              └──────────┬──────────┘
                         ▼
               Les deux ont réussi ?
                 │               │
                NON             OUI
                 ▼               ▼
                ARRÊT     PR : résultat seulement
                          Push : suite du déploiement
```

- **`npm ci`** installe les versions exactes du lockfile. Les scripts d'installation
  des dépendances sont autorisés explicitement dans `allowScripts`.
- **Audits npm** : un audit de toutes les dépendances, puis un audit de celles de
  production. Toute vulnérabilité connue signalée bloque, même de niveau faible.
- **Actionlint** vérifie les workflows GitHub ; **ShellCheck** analyse les scripts
  shell de `.github/scripts`. Bash sélectionne directement tous les fichiers, sans `rg`.
- **Lint** détecte des erreurs de code. Les erreurs bloquent ; les avertissements
  restent visibles mais ne bloquent pas à eux seuls.

L'API répartit les tests AVA en deux lots, chacun avec ses propres PostGIS et Redis,
des migrations sur base vide puis un second passage. Un contrôle final vérifie
que chaque fichier de test a été exécuté exactement une fois et fusionne la
couverture. Les données de couverture des dépendances déjà exclues par c8 sont
retirées avant transfert, sans modifier la couverture du code applicatif.

Le front construit une seule fois Next.js et Storybook pour les tests, puis
partage cette archive entre quatre lots Playwright (deux workers chacun). Le test
du classeur de 500 000 cellules vient ensuite. Un contrôle final vérifie
l'inventaire complet et fusionne les rapports navigateur. Cette archive utilise
une API fictive ; elle ne sert jamais à construire l'image déployée.

Pour relancer une CI front, utiliser **Re-run all jobs** : les archives sont liées
à la tentative. L'API accepte **Re-run failed jobs** tant que les artefacts des
lots réussis du même run sont encore disponibles ; sinon, tout relancer.

### Ce qui est testé dans chaque dépôt

| API | Front | Orchestrateur |
| --- | --- | --- |
| ESLint et contrat OpenAPI | ESLint | TypeScript, ESLint et formatage |
| Tests AVA et mesure de couverture | Tests AVA | Tests des imports et traitements |
| PostGIS et Redis jetables | Build Next.js et Storybook | Redis jetable et compatibilité BullMQ |
| Migrations sur base vide, puis deuxième passage | Tests navigateur Chromium, WebKit et mobile | Compilation TypeScript |
| Intégrations métier, droits, files et garde-fous de déploiement | Connexion, formulaires, exports, cartes, graphiques et garde-fous de déploiement | Formats CSV/XLS/XLSX, dates et garde-fous de déploiement |

Les tests n'utilisent pas les bases ni les connecteurs réels. Les tests navigateur
utilisent une API simulée. Le contrat front vérifié côté API est un commit public
figé : ce n'est pas une recette complète des deux applications ensemble.

## 3. Préparer l'image en parallèle des contrôles

```text
                     DÉBUT DU DÉPLOIEMENT
                              │
                ┌─────────────┴─────────────┐
                ▼                           ▼
       QUALITÉ ET SÉCURITÉ          Construction de l'image
       Audits et tests             Envoi au registre Scaleway
       Contrôles des rapports      Identification par digest
                │                  Scan Trivy et essais natifs
                │                           │
                └─────────────┬─────────────┘
                              ▼
                  Les deux ont réussi pour
                     le même commit ?
                       │           │
                      NON         OUI
                       ▼           ▼
                      ARRÊT   Déploiement du digest vérifié
```

Trivy contrôle les vulnérabilités connues des paquets de l'image, y compris ceux du
système d'exploitation, et bloque aussi un OS en fin de support. Une erreur du
scanner bloque également. Les essais natifs vérifient Prisma/Sentry pour l'API,
Sharp pour le front, Sentry/SheetJS pour l'orchestrateur.

L'API contrôle aussi la taille de l'image et la présence des certificats nécessaires.
Les contrôles de branche, projet, namespace et conteneur sont effectués avant toute
modification des services ; certains sont réalisés dès le début du job.

L'envoi d'une image candidate au registre ne la met pas en service. Si la qualité
échoue, le déploiement reste bloqué même lorsque l'image est prête. Les caches
BuildKit sont séparés par environnement. Celui de l'API reste dans son registre
privé, car ses couches contiennent un sous-module privé. Le cache Next.js des
tests porte uniquement sur la compilation ; les réponses HTTP mises en cache
sont effacées avant le build synthétique.

Les jobs image et déploiement de l'API n'installent plus les dépendances de
l'application sur le runner. L'image conserve son installation verrouillée.
L'orchestrateur conserve ses dépendances dans le job de déploiement pour vérifier
TLS et Redis. Les déploiements d'un même environnement restent sérialisés ; une
nouvelle exécution n'annule pas celle déjà en cours.

## 4. Ce qui change selon le service

```text
API                      FRONT                    ORCHESTRATEUR
 │                        │                        │
 Vérifier les cibles      Vérifier la cible        Vérifier la cible
 │                        │                        │
 Service privé de        Mettre à jour            Mettre à jour
 migration PostgreSQL    le front                 l'orchestrateur
 │                        │                        │
 Migration réussie ?     Configuration préservée   Configuration préservée
 │ oui                    │                        │
 Mettre à jour l'API      Santé /healthz            Santé /health
 puis le worker           │                        │
 │                       Publier l'alias          Publier l'alias
 Configuration préservée  du front                 de l'orchestrateur
 │
 Santé API + worker
 │
 Publier l'alias API
```

Les trois colonnes sont **trois pipelines indépendants**, pas trois tâches
coordonnées par un workflow global. L'API et son worker partagent le même digest ;
le front et l'orchestrateur ont chacun leur image.

En production, l'orchestrateur vérifie également que les files sont au repos
immédiatement avant la modification du service.

Les scripts ne réécrivent pas les secrets existants. Ils vérifient les réglages
avant et après la mise à jour. Les exceptions explicites de l'API sont la variable
de suivi `MIGRATION_RELEASE_SHA` du service privé de migration et, sur testing,
les probes API et la commande worker déjà prévues par le déploiement.
Voir [le détail des migrations privées](ci-private-migrations.md).

## 5. Les limites importantes

- **Pas de promotion automatique** de testing vers demo ou prod. Chaque push sur
  une branche d'environnement relance ses contrôles et reconstruit son image.
  Le digest scanné est celui déployé dans cette exécution ; ce n'est pas forcément
  la même image entre environnements, notamment pour le front configuré au build.
- **Une erreur arrête la suite**, sans annuler les étapes déjà réalisées.
  Si une migration a réussi puis que le worker ne démarre pas, il faut intervenir :
  aucun rollback automatique de base ou de service n'est annoncé.
- **La première bascule BullMQ 6 reste une opération coordonnée** : sauvegarde,
  préflight Redis, traitement éventuel des anciennes planifications et bascule
  API/worker/orchestrateur. Le workflow ne fait pas cette maintenance à votre place.
  Voir la [checklist BullMQ](bullmq-6-migration.md).
- **Tests verts ne signifie pas recette complète** des services externes ni absence
  de faille inconnue. Une recette sur testing reste nécessaire avant les promotions.
- **Le pipeline bloque le déploiement** si la qualité échoue. Le blocage de fusion
  d'une PR dépend en plus des protections de branches configurées dans GitHub.

## Où lire les résultats ?

Dans l'onglet **Actions** du dépôt : ouvrir l'exécution, puis le job en échec.
Les audits npm et Trivy sont conservés 30 jours ; couverture API et rapports
navigateur sont conservés 14 jours. Des traces navigateur sont disponibles en cas
d'échec. Un résultat local ne remplace pas l'exécution GitHub du commit publié.

Les sources sont `.github/workflows/quality.yml` et les fichiers `deploy-testing.yml`,
`deploy-demo.yml`, `deploy-prod.yml` dans chaque dépôt. Pour la production de
l'orchestrateur, le fichier s'appelle `deploy.yml`.
Le [guide CI de l'API](../.github/CI.md) détaille le partitionnement, la couverture
et les règles du cache privé.
