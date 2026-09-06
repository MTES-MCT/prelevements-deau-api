# Migration rejouable de La Réunion

`npm run migrate:reunion -- …` transfère les déclarants, points de prélèvement,
exploitations, agents, documents et règles du Mongo historique vers PE.
Les séries, volumes, index, déclarations et dossiers DS sont exclus.

Le script n'écrit pas sur les cibles par défaut. Une application exige
`--apply`, une cible autorisée `local|testing` et sa confirmation exacte.
La production est interdite. Les snapshots et rapports restent des écritures
locales, y compris lors d'une simulation.

## Prérequis et protection des fichiers

- Node.js 24, `npm ci` et Docker/Compose pour la répétition locale.
- Un backup Mongo figé et identifié, restauré sur une source accessible en
  lecture. Le Compose fournit la version Mongo compatible ; ne pas modifier
  la base source pour préparer la migration.
- Un accès en lecture aux documents S3 sources et suffisamment d'espace
  temporaire pour le plus gros document.
- Une version compatible de PE, ses migrations Prisma et les zones de référence
  importées avant le préflight.

Conserver backup, BSON, manifeste, checksum, copies des mappings, configurations
et rapports hors dépôt. Le manifeste contient des données personnelles :
répertoire en `0700`, fichiers en `0600`. Ne pas afficher d'URI avec credentials
ni passer de secret en argument de commande.

Avant d'extraire un backup, vérifier sa provenance et ses chemins. Refuser les
traversées de répertoire, liens et entrées hors du périmètre attendu ; restaurer
uniquement dans un répertoire dédié vide. Ne pas réutiliser une procédure
d'extraction liée à un autre format d'archive.

```sh
migration_dir=/chemin/prive/migration-reunion
install -d -m 700 "$migration_dir"
install -m 600 scripts/reunion/data/usage-map.csv "$migration_dir/usage-map.csv"
install -m 600 scripts/reunion/data/point-overrides.csv "$migration_dir/point-overrides.csv"
install -m 600 scripts/reunion/data/document-exclusions.csv "$migration_dir/document-exclusions.csv"
```

Les trois CSV définissent les correspondances d'usages, les corrections de points
et les exclusions documentaires. Le manifeste lie leur contenu exact et la
version du transformateur par checksum. Les commandes suivantes refusent un
mapping modifié ; une évolution sémantique exige une nouvelle version et une
nouvelle validation.

Préparer séparément un fichier privé `source-s3.env` contenant
`S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` et
`S3_BUCKET_PREFIX`. Utiliser des droits limités à la lecture de la source.
Les objets absents doivent être traités par une exclusion explicite validée,
sans masquer les erreurs de téléchargement.

## Préparer une répétition locale

```sh
docker compose -f scripts/reunion/compose.yaml up -d
install -m 600 scripts/reunion/target-local.env.example "$migration_dir/target-local.env"
```

Attendre les contrôles de santé et la création du bucket local avant de continuer.
Cette pile isole MongoDB, PostgreSQL et MinIO des services de développement
habituels. Elle ne lance pas l'API ou le front.

Restaurer le backup Mongo validé dans cette pile. Configurer ensuite les commandes
Prisma et d'import des zones pour la même base locale que `target-local.env`,
puis exécuter :

```sh
APP_ENV=reunion-local \
DATABASE_URL='postgresql://pe_reunion:pe_reunion_local_only@127.0.0.1:5433/pe_reunion' \
npm run migrate:prisma
APP_ENV=reunion-local \
DATABASE_URL='postgresql://pe_reunion:pe_reunion_local_only@127.0.0.1:5433/pe_reunion' \
node scripts/import-zones.js
```

Le fichier `--target-env` du migrateur ne configure pas ces deux commandes.
Vérifier leur cible avant exécution.

## Créer le manifeste immuable

```sh
REUNION_MONGO_URL=mongodb://127.0.0.1:27018/reunion_source \
  npm run migrate:reunion -- snapshot \
  --source-mongo-db reunion_source \
  --source-s3-env "$migration_dir/source-s3.env" \
  --backup-id '<identifiant-du-backup-validé>' \
  --usage-map "$migration_dir/usage-map.csv" \
  --point-overrides "$migration_dir/point-overrides.csv" \
  --document-exclusions "$migration_dir/document-exclusions.csv" \
  --manifest "$migration_dir/manifest.jsonl"
```

L'exemple utilise une URI locale sans secret. Pour une source authentifiée,
charger `REUNION_MONGO_URL` depuis une configuration privée sans l'afficher ;
`--source-mongo-uri` est réservé aux URI locales sans secret.

Le snapshot calcule les checksums des documents sources. `--skip-s3` est réservé
au diagnostic : un manifeste ainsi produit ne peut pas être appliqué.
Le manifeste et son compagnon `.sha256` ne doivent pas déjà exister.
Utiliser de nouveaux chemins pour un nouveau backup.

## Préflight, simulation, application et vérification

```sh
npm run migrate:reunion -- preflight \
  --manifest "$migration_dir/manifest.jsonl" \
  --usage-map "$migration_dir/usage-map.csv" \
  --point-overrides "$migration_dir/point-overrides.csv" \
  --document-exclusions "$migration_dir/document-exclusions.csv" \
  --target local --target-env "$migration_dir/target-local.env" \
  --report "$migration_dir/local-preflight.json"

npm run migrate:reunion -- apply \
  --manifest "$migration_dir/manifest.jsonl" \
  --usage-map "$migration_dir/usage-map.csv" \
  --point-overrides "$migration_dir/point-overrides.csv" \
  --document-exclusions "$migration_dir/document-exclusions.csv" \
  --source-s3-env "$migration_dir/source-s3.env" \
  --target local --target-env "$migration_dir/target-local.env" \
  --report "$migration_dir/local-dry-run.json"
```

La seconde commande reste une simulation. Après contrôle et accord explicite,
la reprendre avec un rapport neuf et `--apply --confirm-target local`.

```sh
npm run migrate:reunion -- verify \
  --manifest "$migration_dir/manifest.jsonl" \
  --usage-map "$migration_dir/usage-map.csv" \
  --point-overrides "$migration_dir/point-overrides.csv" \
  --document-exclusions "$migration_dir/document-exclusions.csv" \
  --target local --target-env "$migration_dir/target-local.env" \
  --report "$migration_dir/local-verify.json"
```

Rejouer `apply`, puis `verify`, avec le même manifeste, son checksum et les
mêmes mappings, mais des rapports distincts. Les compteurs de base et S3 doivent
être `unchanged`, sans nouvel audit de permissions.

Les `sourceId` sont stables et les transactions bornées à un agrégat.
La migration ne supprime pas les entités racines absentes d'un snapshot plus
récent. Elle peut retirer les contacts et relations qu'elle gère pour réconcilier
le manifeste. `verify` compare les champs et relations migrés et relit chaque
objet S3 cible pour recalculer sa taille et son SHA-256. `verify --skip-s3`
est refusé.

La commande `all` enchaîne snapshot, préflight, application et vérification.
Elle reprend les options source de `snapshot` et les options cible de
`apply`, avec un chemin de manifeste neuf. Sans `--apply`, elle ne réalise
pas d'écriture cible. Pour démontrer la rejouabilité, conserver ensuite ce
manifeste et relancer `apply` puis `verify`, pas `all`.

## Passage vers testing

Réutiliser le manifeste et son checksum validés localement. Avant toute écriture :

1. vérifier la compatibilité des migrations, de l'API et du front ;
2. préparer un fichier cible privé à partir de `target-testing.env.example`,
   avec la base, le rôle, le point d'accès et le certificat autorisés par la
   révision utilisée ; ne pas copier une ancienne configuration sans contrôle ;
3. vérifier le bucket cible attendu, privé et versionné, et les droits S3 ;
4. disposer d'une sauvegarde PostgreSQL restaurable ;
5. exécuter `preflight` avec `--target testing` et le fichier cible privé ;
6. relire son rapport et obtenir l'accord avant l'application.

Les garde-fous vérifient l'identité PostgreSQL et TLS après connexion, puis la
région et le versioning S3. Les scripts ne créent ni réseau ni tunnel. Une
adresse de transport n'est pas implicitement autorisée : utiliser une révision
compatible avec l'accès réseau disponible, sans contourner les contrôles.

Les commandes sont celles de la répétition locale, en remplaçant la cible et le
fichier d'environnement par ceux de testing. L'application exige
`--apply --confirm-target 'testing:<empreinte-du-préflight>'`.
Cette empreinte lie le manifeste, la base et le bucket attestés.

Après application, lancer `verify`, puis rejouer `apply` et `verify` avec
des rapports neufs. Le code de sortie et les rapports doivent être contrôlés
avant de considérer le transfert comme terminé.

## Fin de session et rétention

Pour arrêter la pile locale en conservant ses données :

```sh
docker compose -f scripts/reunion/compose.yaml down
```

La suppression des volumes est une décision distincte et irréversible ;
elle n'est pas nécessaire pour arrêter la pile. Décider séparément de la
rétention des backups, manifestes, checksums et rapports.

Révoquer les accès temporaires créés pour la migration après validation.
Ne pas révoquer un credential partagé avec l'application. Les configurations
contenant des secrets doivent être conservées ou détruites séparément des preuves.
