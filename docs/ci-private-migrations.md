# Déploiement API sur les services de migration privés

Les workflows testing, demo et prod utilisent des conteneurs de migration privés,
et non des Serverless Jobs. Les commandes existantes sont conservées :

| Environnement | Déploiement CI | Commande du service privé |
| --- | --- | --- |
| testing | `deploy/network/ci-testing-deploy.js` | `node scripts/network/testing-migration-service.js` |
| demo | `deploy/network/ci-demo-deploy.js` | `node scripts/network/migration-service.js` |
| prod | `deploy/network/ci-prod-deploy.js` | `node scripts/network/prod-migration-service.js` |

Les trois points d'entrée utilisent les mêmes implémentations :
`ci-environment-deploy.js`, `migration-service-core.js` et `migration-status-core.js`.
Chaque wrapper conserve ses identifiants, validateurs de cible, noms de secrets
et comportements historiques. En particulier, prod refuse de rejouer une
opération échouée et vérifie le registre avant Prisma ; testing conserve ses
probes de déploiement et sa commande worker. Les tests de migration et de
déploiement s’exécutent sans accès au cloud.

## Configuration GitHub existante à conserver

Les workflows utilisent notamment les clés suivantes ; ne pas générer de
nouveaux secrets en remplacement de ceux des services :

- Variables : `SCW_DEMO_MIGRATION_CONTAINER_ID`,
  `SCW_DEMO_MIGRATION_NAMESPACE_ID`, `SCW_PROD_MIGRATION_CONTAINER_ID`,
  `SCW_PROD_MIGRATION_NAMESPACE_ID`.
- Secrets : `DEMO_MIGRATION_INVOKE_SECRET`, `PROD_MIGRATION_INVOKE_SECRET`,
  ainsi que les identifiants API/worker et credentials Scaleway déjà utilisés.

Le déploiement échoue avant toute écriture si une cible ou un secret requis
manque. Ne pas utiliser un identifiant d'un autre environnement pour contourner
ce contrôle.

## Garanties du déroulement

1. Qualité, tests et audit npm passent ; le digest exact de l'image est scanné.
2. La CI vérifie branche, projet, namespace, réseau, commandes, confidentialité,
   variables et présence des noms de secrets.
3. Un appel anonyme doit être refusé ; les lectures authentifiées `/healthz`
   et `/status` doivent confirmer la release et un registre Prisma sans échec.
4. Le service privé reçoit le digest contrôlé. Seule sa variable de suivi
   `MIGRATION_RELEASE_SHA` évolue, avec conservation complète des autres clés ;
   les valeurs des secrets ne sont jamais réécrites.
5. Une seule demande `/migrate` est envoyée. En cas de réponse perdue, seule la
   lecture de l'opération identifiée peut confirmer sa réussite ; pas de retry
   automatique d'une écriture.
6. Après confirmation du registre, l'API puis le worker reçoivent uniquement
   `{image}` sur demo/prod. Testing conserve ses deux probes API historiques et
   sa commande worker `node worker.js`, explicitement listées dans son wrapper.
   Dans les trois environnements, tous les réglages sont vérifiés avant écriture
   puis comparés à l'état initial augmenté de ces seuls changements autorisés.
   Mémoire, CPU, confidentialité, autres probes, variables et secrets ne peuvent
   pas dériver sans interrompre le déploiement.
7. Les deux sondes doivent réussir avant publication de l'alias d'environnement.

Les tests utilisent exclusivement des réponses HTTP, commandes Prisma et accès
SQL simulés. Ils ne lancent aucune migration réelle. La première bascule BullMQ
6 nécessite également le préflight décrit dans `docs/bullmq-6-migration.md`.
