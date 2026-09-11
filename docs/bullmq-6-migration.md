# Passage à BullMQ 6

La migration concerne **ensemble l’API, son worker et l’orchestrateur**, qui partagent Redis. Les noms des files, le préfixe `bull`, les identifiants de tâches, les politiques de reprise et le protocole RESP2 restent inchangés.

## Avant le premier déploiement, pour chaque environnement

- [ ] Sauvegarder Redis et relever les digests des trois anciennes images.
- [ ] Dans le contexte réseau de l’environnement ciblé, injecter les variables Redis déjà existantes, sans les remplacer dans la plateforme.
- [ ] Lancer `node scripts/queue-migration-preflight.js`. Ce contrôle utilise uniquement des lectures Redis ; il ne construit pas de Queue BullMQ.
- [ ] Vérifier `readyForBullmq6: true` et le code retour 0. Le contrôle couvre les files de l’API, `process-declaration` et `pull-updated-data`. Un code 2 indique une ancienne planification à traiter ; un code 1 indique un contrôle incomplet.

### Seulement si une ancienne planification est détectée

Le [guide officiel BullMQ](https://docs.bullmq.io/guide/migrations/migrate-from-v5-to-v6) impose de migrer les anciens `repeat` **avec BullMQ 5, avant le déploiement de BullMQ 6**. Les tâches ponctuelles, retardées et en échec ne doivent pas être purgées.

- [ ] Arrêter les producteurs (API/orchestrateur et planificateurs), mettre la file concernée en pause via BullMQ 5, attendre zéro tâche active puis arrêter les workers.
- [ ] Refaire le contrôle, garder la file en pause et relever la clé exacte et son empreinte.
- [ ] Depuis un outillage de maintenance disposant du module BullMQ 5 de l’ancienne image, lancer une migration **ciblée**, jamais globale :

```sh
node scripts/queue-migration-preflight.js --apply \
  --queue NOM_FILE \
  --legacy-key CLE_EXACTE \
  --expected-sha256 EMPREINTE_DU_CONTROLE \
  --scheduler-id IDENTIFIANT_APPLICATIF \
  --bullmq-v5-module /chemin/ancienne-image/node_modules/bullmq
```

L’identifiant doit être celui utilisé au démarrage : le nom de la file pour les crons API déclarés dans `lib/queues/config.js` (par exemple `campaign-delivery`), ou `pull-updated-data-daily` pour l’orchestrateur. Ce dernier contrat externe est centralisé dans `getCanonicalSchedulerId` ; aucune fréquence de l’orchestrateur n’est recopiée dans l’API.

Le script ne convertit automatiquement qu’une définition unique sur une file possédant une planification applicative connue. Plusieurs définitions, un identifiant non canonique ou une file sans cron applicatif imposent une revue manuelle ; ces cas sont refusés avant même la construction de la Queue BullMQ, qui écrit des métadonnées. Ne pas créer un nouvel identifiant arbitraire : le démarrage ajouterait sinon une seconde planification.

Le script refuse également une file non suspendue, une tâche active, une empreinte périmée, un module qui n’est pas BullMQ 5, des données manquantes ou une planification bornée/décalée. Il crée et vérifie le nouveau scheduler **avant** de retirer uniquement l’ancienne définition. Il ne purge jamais les files. En cas d’échec, garder la file en pause et inspecter les deux définitions avant de reprendre ; ne pas réessayer à l’aveugle.

L’option historique `repeat.utc: true` devient `tz: 'UTC'`, avec la même priorité sur un éventuel `tz` que BullMQ 5 ; `utc` est toujours retirée. La conversion conserve les options de la définition, mais le redémarrage réapplique la fréquence et le fuseau du catalogue applicatif. Vérifier leur concordance avant la reprise ; ce script n’est pas un convertisseur universel de planifications arbitraires.

Pour une planification avec limite/startDate/décalage, effectuer une migration manuelle contrôlée selon le guide officiel afin de conserver le nombre exact de passages. La bascule peut déplacer le prochain passage d’un intervalle : effectuer cette opération dans la fenêtre de maintenance convenue, vérifier la prochaine échéance et éviter les doublons métier avant reprise.

## Bascule coordonnée

- [ ] Prévoir une courte fenêtre de maintenance, plutôt qu’un déploiement progressif laissant tourner ensemble les anciens et nouveaux workers.
- [ ] Arrêter les producteurs et laisser terminer les tâches actives ; l’arrêt du worker ferme désormais les workers avant Redis et PostgreSQL.
- [ ] Contrôler à nouveau qu’il n’existe aucun ancien `repeat`.
- [ ] Déployer les trois images validées ; conserver les files et les variables existantes.
- [ ] Reprendre les files suspendues, redémarrer les consommateurs puis les producteurs.
- [ ] Vérifier la santé des services, une déclaration, un export, les imports et la prochaine échéance des schedulers, sans envoyer de données réelles depuis les tests.

## Retour arrière

Arrêter d’abord les producteurs et attendre/arrêter proprement les nouveaux workers. Revenir **ensemble** aux trois digests précédents, sans restaurer Redis à chaud ni perdre les tâches ajoutées depuis la bascule. Les tests de compatibilité couvrent les tâches et schedulers conservés entre v5 et v6, mais ne remplacent pas la sauvegarde ni le contrôle des anciennes planifications propres à chaque environnement. Une restauration Redis implique un arrêt complet et une décision explicite sur les tâches créées depuis la sauvegarde.
