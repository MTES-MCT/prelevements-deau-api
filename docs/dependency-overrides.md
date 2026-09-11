# Exceptions de dépendances

Vérification du 11 septembre 2026. Aucun paquet n'est modifié après installation.

## Prisma 7.10.0 et deepmerge-ts

Prisma 7.10.0 est la dernière version stable publiée ; la balise npm `latest`
désigne une préversion de Prisma 8, non retenue. `@prisma/config@7.10.0` impose
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
à chaque évolution ; l'audit continue de bloquer sur toute vulnérabilité.

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
