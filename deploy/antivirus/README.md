# Antivirus des nouveaux fichiers

Le scanner est un service dédié de l'API, construit indépendamment de ses
dépendances. Le workflow `antivirus.yml` fonctionne aussi sur la branche par
défaut : aucun checkout de sous-module, installation npm ou test applicatif.
Il rafraîchit les signatures quotidiennement à 04:23 UTC et peut être lancé
manuellement. Tous les environnements reçoivent le même digest, après tests
du moteur réel, contrôle des limites et analyse de vulnérabilités de l'image.

## Configuration et isolement

Chaque environnement possède un namespace `<env>-partageons-leau-antivirus`,
avec `APP_ENV=<env>` et son seul secret `CLAMAV_INVOKE_TOKEN`. Le secret est un jeton
aléatoire de 32 octets représenté par 64 caractères hexadécimaux. Il est
transmis à l'API uniquement par son magasin de secrets.

Les variables GitHub de dépôt `CLAMAV_TESTING_NAMESPACE_ID`,
`CLAMAV_DEMO_NAMESPACE_ID` et `CLAMAV_PROD_NAMESPACE_ID` désignent ces
namespaces. Le workflow utilise les secrets Scaleway déjà disponibles au
niveau du dépôt et vérifie explicitement projet, namespace, réseau et nom
avant chaque écriture. Aucun service applicatif existant n'est modifié.

Le conteneur utilise 2 048 Mo (2 048 000 000 octets), 0,5 vCPU, `max_scale=1`,
une concurrence de 2 et un délai de 180 secondes. En production, `min_scale=1`
garde une instance disponible pour éviter le démarrage à froid lors d'un upload.
En testing et demo, `min_scale=0` permet l'arrêt en l'absence de requêtes.
Il expose uniquement son endpoint privé,
avec HTTPS et la CA régionale Scaleway côté client. Sa politique plateforme
`privacy=public` signifie uniquement que l'authentification est assurée par
le scanner : **l'endpoint Internet reste désactivé**, et chaque analyse exige
`Authorization: Bearer <jeton>`. `/readyz` expose uniquement la disponibilité
pour les probes internes ; `/healthz` et `/scan` nécessitent le jeton.

Ne pas ajouter de cron HTTP ou de sonde externe périodique en testing/demo :
ils empêcheraient l'arrêt après inactivité. Le délai réel de retour à zéro doit
être contrôlé dans Cockpit : une valeur `min_scale=0` ne constitue pas à elle
seule une preuve d'arrêt. Lors du contrôle du 10 novembre 2026, les métriques
indiquaient encore une instance après plus de seize minutes sans upload ;
le retour à zéro n'a donc pas été confirmé. Les signatures sont intégrées
à l'image ; aucun téléchargement
ni accès S3/DB n'est nécessaire au démarrage.

## Livraison et vérification

Le workflow crée le conteneur manquant dans le namespace dédié ou modifie
uniquement son image s'il possède déjà le dimensionnement attendu. Il accepte
aussi une transition contrôlée depuis l'ancienne configuration exacte
4 096 000 000 octets / 2 000 mvCPU / `min_scale=0` : le PATCH contient alors
uniquement l'image, la mémoire, le CPU et le minimum d'instances. Les variables
et secrets ne sont jamais réécrits. Un dimensionnement intermédiaire ou tout
autre écart de configuration interrompt la livraison.
Les mutations ne sont pas répétées automatiquement en cas de réponse perdue.
Les artefacts conservent le digest et le dimensionnement précédents pour un
retour arrière ciblé.

Avant activation d'une API, depuis son réseau privé : vérifier un refus sans
jeton et avec un mauvais jeton, un fichier sain, EICAR, une archive infectée,
un fichier chiffré, les limites et un fichier de 50 Mo après arrêt à zéro.
Vérifier aussi l'inaccessibilité publique, la conservation des configurations
applicatives, l'instance disponible en production et le retour à zéro observé
dans Cockpit en testing/demo après inactivité. Scaleway documente quinze
minutes ; vérifier la mesure effective sans requête de surveillance qui
réinitialiserait cette période.

Un échec quotidien doit être traité via l'alerte du workflow GitHub ; les
signatures âgées de plus de 72 heures rendent le scanner indisponible et les
uploads sont refusés. Ne jamais contourner cette protection ou désactiver
l'analyse pour rétablir un upload.

## Retour arrière

Utiliser le digest précédent du rapport de déploiement, le repasser dans les
contrôles de vulnérabilités, de fraîcheur et le smoke test, puis appeler le
même script de déploiement avec ce digest. Si ses signatures ont expiré,
reconstruire l'ancien code avec des signatures récentes. Ne pas supprimer les
namespaces ou leurs secrets tant qu'une API les référence.

Les tests locaux sont autonomes :

```sh
node --test deploy/antivirus/*.checks.mjs deploy/antivirus/scanner/*.checks.mjs
node deploy/antivirus/scanner/smoke.mjs IMAGE_IDENTIFIEE_PAR_DIGEST
```
