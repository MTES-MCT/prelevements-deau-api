# Exceptions de dépendances

Vérification du 11 septembre 2026. Aucun paquet n'est modifié après installation.

## Acceptation temporaire du risque de développement (4 octobre 2026)

Exception autorisée pour [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm),
uniquement pour `braces@3.0.3` dans les dépendances de développement. Aucune version
corrigée n'est publiée au moment de la décision. AVA, Spectral et Nodemon utilisent
cette dépendance pour leurs motifs de fichiers ; elle n'est pas conservée dans
l'image d'exécution, qui supprime les dépendances de développement.

L'exception expire le **11 octobre 2026 à 00 h, heure de Paris**
(`2026-10-10T22:00:00Z`). Elle n'est pas une correction du paquet. Le contrôle
`node scripts/security/audit-dependencies.js` conserve le rapport npm brut et
signale explicitement le risque accepté. Il vérifie les chemins du lockfile et
les causes transitives : une autre alerte, un chemin de production, une erreur
d'audit ou l'expiration restent bloquants. Des tests protègent ces limites.

L'audit de production, le scan de l'image, les tests et les migrations restent
inchangés et bloquants. Dès qu'une version officielle corrigée est disponible,
mettre à jour le lockfile, retirer l'exception, puis rejouer les audits et les tests.

## Acceptation temporaire de sprintf-js (7 octobre 2026)

Exception explicitement autorisée pour
[GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c),
limitée à `sprintf-js@1.0.3`, version verrouillée en développement via
`ava > supertap > js-yaml > argparse`. Aucun correctif officiel ni mise à jour
des parents supprimant cette dépendance n'est disponible au 7 octobre 2026.
L'exception expire à la fin du **14 octobre 2026, heure de Paris**
(`2026-10-14T22:00:00Z`). Elle ne prolonge pas l'exception `braces`.

Le rapport brut reste conservé avec ses alertes. Chaque cause transitive doit
être couverte par une exception valide ; toute autre alerte, version différente,
dépendance de production ou expiration bloque le contrôle. Aucun paquet installé
n'est modifié. Retirer cette exception dès qu'un correctif officiel est disponible,
puis rejouer les audits et les tests.

## Acceptation temporaire de minimatch (2 novembre 2026)

Le 2 novembre 2026, l’utilisateur a explicitement autorisé cette dérogation
temporaire et le déploiement. Elle couvre uniquement le risque modéré de déni
de service décrit par
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249),
pour les versions verrouillées `minimatch@3.1.5` et `minimatch@5.1.9`.
Elle expire le **9 novembre 2026 à 00 h, heure de Paris**
(`2026-11-08T23:00:00Z`), sans prolonger les exceptions expirées `braces`
et `sprintf-js`.

Les chemins d’exécution passent par ExcelJS, Archiver, archiver-utils,
readdir-glob et glob ; rimraf conserve aussi un chemin vers glob, via
unzipper et fstream. Les chemins de développement passent par Spectral et
son bundler Rollup. Le manifeste
[`scripts/security/minimatch-exception.js`](../scripts/security/minimatch-exception.js)
fixe chaque nœud, sa version, son statut développement/exécution et les liens
transitifs autorisés. Une autre version, un autre chemin, une autre cause ou
une sévérité différente restent bloquants.

Joi a été corrigé en `18.3.1`. Les branches modernes de glob et minimatch ont
été corrigées par des overrides bornés ; aucun remplacement incompatible de
l’API des anciennes branches n’a été imposé. L’acceptation du risque résiduel
ne corrige pas minimatch et ne constitue pas une garantie d’absence d’exposition.

Les rapports du 2 novembre conservent **17 paquets signalés dans l’audit complet
et 8 en production**, tous modérés et reliés au seul avis autorisé : ces audits
ne sont pas présentés comme exempts de vulnérabilités. Le workflow exécute et
archive les deux commandes npm au travers du même contrôle :

```sh
node scripts/security/audit-dependencies.js
node scripts/security/audit-dependencies.js --production
```

Les rapports JSON bruts sont conservés dans `.artifacts/security/`. Une erreur
réseau, un rapport incomplet ou mal formé, une autre alerte et l’expiration
restent bloquants. Le scan de l’image, les tests, les contrôles de workflow et
les migrations restent obligatoires. Retirer cette exception dès qu’une mise
à jour compatible supprime ces chemins, puis vérifier les deux audits et les
tests ; à l’expiration, les mêmes alertes bloquent automatiquement les livraisons.

## Prisma 7.10.0 et deepmerge-ts

Au 11 septembre 2026, Prisma 7.10.0 était la dernière version stable publiée ;
la balise npm `latest` désignait une préversion de Prisma 8, non retenue.
`@prisma/config@7.10.0` impose
`deepmerge-ts@7.1.5`. Toutes les versions 7 restent touchées par
[GHSA-ggr8-5vv4-36mx](https://github.com/RebeccaStevens/deepmerge-ts/security/advisories/GHSA-ggr8-5vv4-36mx).
Le correctif est intégré dans la
[branche amont Prisma v7](https://github.com/prisma/orm/pull/30189), mais pas encore
dans une version stable publiée.

L'override npm `@prisma/config@7.10.0 > deepmerge-ts = 8.0.2` applique exactement
la version retenue par ce correctif officiel, sans modifier le code des paquets
ni adopter une préversion de Prisma. Il ne s'applique à aucun autre consommateur
de deepmerge-ts ni à une future version de `@prisma/config`.

Le changement de majeure est justifié ici : les ruptures de deepmerge-ts 8
concernent la fusion des `Map` et la mutation via `deepmergeInto`, alors que Prisma
utilise `deepmerge` sur des objets de configuration ordinaires. Le correctif amont
ne modifie pas le code de Prisma et ses 142 tests de configuration passent.
La génération du client, les migrations et les tests locaux restent à rejouer
à chaque évolution ; l'audit continue de bloquer hors exception temporaire
explicitement documentée ci-dessus.

À la publication du correctif : retirer cet override, aligner les trois paquets
Prisma sur la même version stable, régénérer le client, rejouer les migrations
sur une base jetable, les tests d'intégration, les deux audits npm et le scan image.

## mysql2 dans la CLI Prisma

L'override `prisma > mysql2 = 3.24.4` conserve la majeure 3 avec une
[version officielle](https://github.com/sidorares/node-mysql2/releases/tag/v3.24.4).
Il remplace la version 3.15.3 imposée par Prisma, affectée par
[une fuite des identifiants d'authentification](https://github.com/sidorares/node-mysql2/security/advisories/GHSA-3f6p-5ww8-9rcr)
et [une décompression sans borne](https://github.com/sidorares/node-mysql2/security/advisories/GHSA-rgwj-5xj2-c3m3).
L'application utilise PostgreSQL ; la CLI, sa génération et ses migrations
PostgreSQL restent couvertes par les tests.

Retirer cet override dès qu'une version stable de Prisma impose une version
corrigée de mysql2, puis vérifier le lockfile, la génération, les migrations
et l'audit. Il ne s'agit pas d'une prise en charge MySQL de l'application.

L'override `uuid = 11.1.1`, antérieur à cette modernisation, est conservé.

L’alias `bullmq-v5` est réservé aux tests de compatibilité des files 5/6 et
n’est pas embarqué dans l’image finale.
