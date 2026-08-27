# Migration des données de La Réunion

Cet orchestrateur transfère les déclarants, points de prélèvement, exploitations,
agents, documents et règles depuis le Mongo historique vers PE. Il ne lit ni
n'écrit les séries, volumes, index, déclarations ou dossiers DS.

Le script est sans écriture sur la base et le S3 cibles par défaut ; snapshot et
rapports restent des écritures locales. Une écriture cible exige simultanément
`--apply`, `--target local|testing` et une confirmation liée à la cible. La cible
locale est limitée aux services loopback de ce Compose. Testing est limitée à
la RDB Scaleway exacte, à son utilisateur existant
`testing-partageons-leau-api` et au bucket `testing-documents`. Toute autre
identité, dont production, est refusée avant écriture.

## Prérequis et fichiers sensibles

- Node.js 24 et `npm ci` ; la dépendance Mongo est directe et limitée à la
  lecture du snapshot.
- Docker/Compose et un accès en lecture au bucket de documents source. L'image
  MongoDB 4.4 figée dans Compose fournit aussi la version compatible de
  `mongorestore` : aucune installation hôte n'est nécessaire.
- Un espace temporaire local disponible au moins égal à la taille du plus gros
  document : chaque objet est spoulé seul en `0700/0600`, contrôlé, envoyé puis
  supprimé avant de passer au suivant.
- Conserver backup, BSON, manifeste, checksum, copies exactes des trois CSV,
  fichiers `.env` et rapports dans un répertoire hors dépôt, appartenant à
  l'opérateur et en mode `0700`.
- Ne jamais passer une URI contenant un secret dans un ticket ou un commit.
  Préférer une variable shell temporaire ou un fichier de secrets protégé.

Le manifeste JSONL contient des données personnelles. Le script le crée par
écriture atomique en mode `0600`, ainsi qu'un fichier compagnon `.sha256`. Les
rapports sont également en `0600` et ne contiennent que des compteurs et des
identifiants historiques techniques.

Créer d'abord le répertoire de travail hors dépôt et les fichiers
d'environnement avec des permissions restrictives :

```sh
migration_dir=/chemin/hors-depot/migration-reunion
nvm use 24
install -d -m 700 "$migration_dir"
install -m 600 /dev/null "$migration_dir/source-s3.env"
install -m 600 scripts/reunion/data/usage-map.csv "$migration_dir/usage-map.csv"
install -m 600 scripts/reunion/data/point-overrides.csv "$migration_dir/point-overrides.csv"
install -m 600 scripts/reunion/data/document-exclusions.csv \
  "$migration_dir/document-exclusions.csv"
umask 077
```

## 1. Restaurer un backup Scalingo localement

Choisir et figer un identifiant de backup ; ne pas utiliser implicitement « le
dernier » au moment d'une application. L'identifiant initial inspecté est
`6a8f7e0699c3cde8852db621` (27 août 2026, 00:00 UTC) : le revérifier dans la
liste avant téléchargement.

```sh
scalingo --app prelevement-deau-api \
  --addon ad-f1435a97-f119-43a6-af23-94250b032a3a backups
scalingo --app prelevement-deau-api \
  --addon ad-f1435a97-f119-43a6-af23-94250b032a3a \
  backups-download --backup 6a8f7e0699c3cde8852db621 \
  --output "$migration_dir/reunion-backup.tar.gz"
chmod 600 "$migration_dir/reunion-backup.tar.gz"
```

Le téléchargement est une opération source en lecture seule. Le backup réel
contient des chemins absolus et une entrée racine vide : accepter uniquement
les racines ``, `/`, `/prelevement-deau-api-4404` ou le préfixe exact
`/prelevement-deau-api-4404/`. Refuser tout composant `..`, lien ou type
spécial avant extraction :

```sh
set -e
python3 - "$migration_dir/reunion-backup.tar.gz" <<'PY'
import pathlib
import sys
import tarfile

archive = pathlib.Path(sys.argv[1])
allowed_root = "/prelevement-deau-api-4404"
allowed_prefix = f"{allowed_root}/"

with tarfile.open(archive, "r:gz") as source:
    for member in source.getmembers():
        name = member.name
        if name not in {"", "/", allowed_root} and not name.startswith(allowed_prefix):
            raise SystemExit(f"Entrée hors préfixe autorisé: {name!r}")
        if ".." in pathlib.PurePosixPath(name).parts:
            raise SystemExit(f"Composant parent interdit: {name!r}")
        if not (member.isfile() or member.isdir()):
            raise SystemExit(f"Lien ou type spécial interdit: {name!r}")

print("Archive conforme")
PY

install -d -m 700 "$migration_dir/bson"
test -z "$(find "$migration_dir/bson" -mindepth 1 -maxdepth 1 -print -quit)"
tar --extract --gzip \
  --file="$migration_dir/reunion-backup.tar.gz" \
  --directory="$migration_dir/bson" \
  --strip-components=1 \
  --no-same-owner --no-same-permissions --no-overwrite-dir
find "$migration_dir/bson" -type d -exec chmod 700 {} +
find "$migration_dir/bson" -type f -exec chmod 600 {} +
```

Démarrer la pile isolée. Elle utilise les ports 27018, 5433, 9002 et 9003 et
des volumes nommés sous le projet `pe-reunion-migration`; elle ne partage aucun
volume avec les stacks de développement existantes.

```sh
docker compose -f scripts/reunion/compose.yaml up -d

deadline=$((SECONDS + 120))
for service in mongo postgres minio; do
  container_id="$(docker compose -f scripts/reunion/compose.yaml ps -q "$service")"
  while test "$(docker inspect --format '{{.State.Health.Status}}' "$container_id")" != healthy; do
    test "$SECONDS" -lt "$deadline"
    sleep 2
  done
done
bucket_container_id="$(docker compose -f scripts/reunion/compose.yaml \
  ps -aq create-documents-bucket)"
while test "$(docker inspect --format '{{.State.Status}}' "$bucket_container_id")" != exited; do
  test "$SECONDS" -lt "$deadline"
  sleep 2
done
test "$(docker inspect --format '{{.State.ExitCode}}' "$bucket_container_id")" = 0

docker run --rm --network host --user "$(id -u):$(id -g)" \
  --mount type=bind,src="$migration_dir/bson",dst=/backup,readonly \
  mongo:4.4@sha256:4be76f674fc4b27859816811b8baa3c51830eb1dbf4ca81a51e26b79edd662ef \
  mongorestore --uri mongodb://127.0.0.1:27018/reunion_source \
  --drop /backup
```

Après l'extraction avec `--strip-components=1`, les fichiers BSON sont
directement présents dans `$migration_dir/bson`. Une alternative est une URI
Mongo locale ou un tunnel Scalingo maintenu dans un autre terminal : le script
ne crée pas le tunnel et ne découvre jamais les secrets de l'application.

## 2. Initialiser PE local

```sh
cp scripts/reunion/target-local.env.example "$migration_dir/target-local.env"
chmod 600 "$migration_dir/target-local.env"
DATABASE_URL=postgresql://pe_reunion:pe_reunion_local_only@127.0.0.1:5433/pe_reunion \
  npm run migrate:prisma
DATABASE_URL=postgresql://pe_reunion:pe_reunion_local_only@127.0.0.1:5433/pe_reunion \
  node scripts/import-zones.js
```

Les migrations créent les usages SANDRE, mais pas les zones. L'import des
zones est donc requis pour que le préflight trouve notamment `reg-04`.

Le service Compose `create-documents-bucket` crée un bucket privé et versionné
`reunion-migration-documents`. Le fichier d'environnement source S3 doit
contenir uniquement `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`,
`S3_SECRET_KEY` et `S3_BUCKET_PREFIX` avec des droits de lecture.

Pour la répétition locale, récupérer les cinq variables existantes sans les
afficher ni les placer dans l'historique des arguments :

```sh
set +x
tmp_env="$(mktemp "$migration_dir/.source-s3.env.XXXXXX")"
trap 'rm -f "$tmp_env"' EXIT HUP INT TERM
for key in S3_ENDPOINT S3_REGION S3_ACCESS_KEY S3_SECRET_KEY S3_BUCKET_PREFIX; do
  value="$(scalingo --app prelevement-deau-api env-get "$key")"
  test -n "$value"
  printf '%s=%s\n' "$key" "$value" >>"$tmp_env"
  unset value
done
chmod 600 "$tmp_env"
mv "$tmp_env" "$migration_dir/source-s3.env"
trap - EXIT HUP INT TERM
```

La clé applicative historique peut avoir des droits plus larges ; pour Testing,
la remplacer par une clé source temporaire strictement en lecture.

## 3. Créer le manifeste immuable

```sh
export REUNION_MONGO_URL=mongodb://127.0.0.1:27018/reunion_source
npm run migrate:reunion -- snapshot \
  --source-mongo-db reunion_source \
  --source-s3-env "$migration_dir/source-s3.env" \
  --backup-id 6a8f7e0699c3cde8852db621 \
  --usage-map "$migration_dir/usage-map.csv" \
  --point-overrides "$migration_dir/point-overrides.csv" \
  --document-exclusions "$migration_dir/document-exclusions.csv" \
  --manifest "$migration_dir/reunion-20260827-v2.jsonl"
unset REUNION_MONGO_URL
```

L'URI est lue depuis l'environnement pour qu'un mot de passe éventuel ne soit
ni affiché par `npm run`, ni conservé dans l'historique des arguments du
processus. `--source-mongo-uri` est réservé aux URI locales sans secret.

Chaque objet documentaire est lu par plages de 8 Mio pour calculer son SHA-256,
avec ETag figé, délai maximal de 120 secondes et trois tentatives par requête.
Le document historique `698ebd5cdf08b37f8d166721` est explicitement exclu car
son objet source est absent ; ses règles sont conservées avec
`documentId=null`.

Le manifeste v2 contient aussi un contrat de transformation : version du
transformateur et SHA-256 des trois CSV exacts. `preflight`, `apply` et `verify`
refusent donc une table d'usages, une dérogation ou une exclusion modifiée,
même si le chemin du fichier est différent. Incrémenter la version du
transformateur pour toute évolution sémantique des mappings, partitions,
permissions ou relations.

`--skip-s3` sert uniquement à produire un snapshot de diagnostic : son
préflight échoue sur les checksums manquants et il est incompatible avec
`--apply`.

## 4. Préflight et dry-run local

```sh
npm run migrate:reunion -- preflight \
  --manifest "$migration_dir/reunion-20260827-v2.jsonl" \
  --usage-map "$migration_dir/usage-map.csv" \
  --point-overrides "$migration_dir/point-overrides.csv" \
  --document-exclusions "$migration_dir/document-exclusions.csv" \
  --target local \
  --target-env "$migration_dir/target-local.env"

npm run migrate:reunion -- apply \
  --manifest "$migration_dir/reunion-20260827-v2.jsonl" \
  --usage-map "$migration_dir/usage-map.csv" \
  --point-overrides "$migration_dir/point-overrides.csv" \
  --document-exclusions "$migration_dir/document-exclusions.csv" \
  --source-s3-env "$migration_dir/source-s3.env" \
  --target local \
  --target-env "$migration_dir/target-local.env"
```

La seconde commande reste un dry-run tant que `--apply` n'est pas présent.
Le préflight contrôle les références, la couverture de la table d'usages, les
types/coordonnées PP, la zone `reg-04`, les usages racines SANDRE, les
collisions de noms et d'agents, les checksums S3 et l'exclusion obligatoire.

Les fichiers versionnés sont :

- `data/usage-map.csv` : 1 132 lignes issues de l'ODS, plus les six dérogations
  AEP 1245 à 1250 ;
- `data/point-overrides.csv` : type souterrain du PP 513 et rattachement
  territorial explicite du PP 256 ;
- `data/document-exclusions.csv` : unique objet source manquant.

## 5. Appliquer et démontrer l'idempotence

```sh
npm run migrate:reunion -- apply \
  --manifest "$migration_dir/reunion-20260827-v2.jsonl" \
  --usage-map "$migration_dir/usage-map.csv" \
  --point-overrides "$migration_dir/point-overrides.csv" \
  --document-exclusions "$migration_dir/document-exclusions.csv" \
  --source-s3-env "$migration_dir/source-s3.env" \
  --target local \
  --target-env "$migration_dir/target-local.env" \
  --report "$migration_dir/apply-first.report.json" \
  --apply --confirm-target local

npm run migrate:reunion -- verify \
  --manifest "$migration_dir/reunion-20260827-v2.jsonl" \
  --usage-map "$migration_dir/usage-map.csv" \
  --point-overrides "$migration_dir/point-overrides.csv" \
  --document-exclusions "$migration_dir/document-exclusions.csv" \
  --target local \
  --target-env "$migration_dir/target-local.env" \
  --report "$migration_dir/verify-first.report.json"
```

Rejouer ensuite exactement la commande `apply` avec
`--report "$migration_dir/apply-replay.report.json"`, puis `verify` avec
`--report "$migration_dir/verify-replay.report.json"`. Tous les compteurs base
et S3 doivent être `unchanged`, sans nouvel audit de permissions. Les
`sourceId` sont stables et toutes les transactions sont bornées à un agrégat.
La migration ne supprime pas les entités racines absentes d'un snapshot plus
récent ; elle peut en revanche retirer les contacts et relations qu'elle gère
pour réconcilier exactement le manifeste. `verify` compare chaque champ
effectivement migré et chaque relation par `sourceId` ou code SANDRE : contacts
principaux, propriétaires, PP, zones, usages, permissions et liens
exploitations-documents-règles. Il relit intégralement le corps de chaque objet
cible et recalcule SHA-256 et taille ; `verify --skip-s3` est refusé.

Comme alternative au déroulé découpé, la commande `all` permet d'enchaîner
snapshot, préflight, application et vérification en une seule exécution sur le
backup Mongo local figé. Elle doit utiliser un chemin de manifeste neuf :

```sh
REUNION_MONGO_URL=mongodb://127.0.0.1:27018/reunion_source \
  npm run migrate:reunion -- all \
  --source-mongo-db reunion_source \
  --source-s3-env "$migration_dir/source-s3.env" \
  --backup-id 6a8f7e0699c3cde8852db621 \
  --usage-map "$migration_dir/usage-map.csv" \
  --point-overrides "$migration_dir/point-overrides.csv" \
  --document-exclusions "$migration_dir/document-exclusions.csv" \
  --manifest "$migration_dir/reunion-20260827-v2-all.jsonl" \
  --target local \
  --target-env "$migration_dir/target-local.env" \
  --apply --confirm-target local
```

Pour démontrer la rejouabilité, ne pas régénérer le manifeste : relancer
`apply` avec ce même fichier et son `.sha256`, puis `verify`. Le script refuse
désormais tout `snapshot` ou `all` si le manifeste ou son checksum existe déjà ;
choisir un nouveau chemin pour un nouveau backup.

## 6. Afficher la migration dans PE local

La pile Compose ne lance que MongoDB, PostgreSQL et MinIO. Pour voir les PP sur
la carte, lancer l'API et le front compatibles avec la migration. Si les ports
habituels `5000` et `3000` sont déjà utilisés, conserver l'application courante
et lancer les worktrees en parallèle.

Dans un premier terminal API :

```sh
cd /home/samy/Projets/PreservonsLEau/.worktrees/prelevements-deau-api-reunion-migration
set -a
. /home/samy/Projets/PreservonsLEau/prelevements-deau-api/.env
. "$migration_dir/target-local.env"
set +a
export PORT=5001 API_URL=http://localhost:5001 FRONT_URL=http://localhost:3001
PATH=/home/samy/.nvm/versions/node/v24.16.0/bin:$PATH npm run start-dev
```

Dans un second terminal front, après `npm ci` :

```sh
cd /home/samy/Projets/PreservonsLEau/.worktrees/prelevements-deau-front-reunion-migration
set -a
. /home/samy/Projets/PreservonsLEau/prelevements-deau-front/.env
set +a
export API_URL=http://localhost:5001 NEXT_PUBLIC_API_URL=http://localhost:5001
export NEXTAUTH_URL=http://localhost:3001 NEXT_PUBLIC_FRONTEND_URL=http://localhost:3001
export FRONT_URL=http://localhost:3001
PATH=/home/samy/.nvm/versions/node/v24.16.0/bin:$PATH npm run dev -- -p 3001
```

Ouvrir ensuite <http://localhost:3001> dans une fenêtre privée, demander un
magic link avec l'adresse d'un agent Réunion et récupérer le message dans
Mailpit sur <http://localhost:8025>. La carte est disponible sur
<http://localhost:3001/points-prelevement>. Une session privée évite de
réutiliser le cookie `localhost` de la base locale habituelle.

## 7. Passage vers testing

Réutiliser strictement le manifeste et son `.sha256` validés localement. Avant
toute écriture :

1. déployer les migrations Prisma, l'API et le front compatibles ;
2. reprendre le mot de passe de l'utilisateur RDB existant
   `testing-partageons-leau-api` sans l'afficher, puis construire l'URL avec le
   FQDN, la CA et `sslmode=verify-full` exigés par le garde-fou ; le fichier
   `.env.testing` peut fournir ce mot de passe, mais pas être utilisé tel quel ;
3. créer un bucket privé et versionné `testing-documents`, puis une clé
   temporaire limitée à ce seul bucket ;
4. créer et attendre un backup manuel PostgreSQL testing ;
5. partir de `target-testing.env.example`, avec la CA Testing exacte ;
6. exécuter `preflight`, relire l'identité sans secret et la confirmation
   `testing:<empreinte>` inscrites dans son rapport ;
7. obtenir l'accord explicite de l'opérateur avant `--apply`.

Exécuter d'abord :

```sh
npm run migrate:reunion -- preflight \
  --manifest "$migration_dir/reunion-20260827-v2.jsonl" \
  --usage-map "$migration_dir/usage-map.csv" \
  --point-overrides "$migration_dir/point-overrides.csv" \
  --document-exclusions "$migration_dir/document-exclusions.csv" \
  --target testing \
  --target-env "$migration_dir/target-testing.env" \
  --report "$migration_dir/testing-preflight.report.json"
```

Après accord explicite, reprendre la confirmation exacte du rapport :

```sh
npm run migrate:reunion -- apply \
  --manifest "$migration_dir/reunion-20260827-v2.jsonl" \
  --usage-map "$migration_dir/usage-map.csv" \
  --point-overrides "$migration_dir/point-overrides.csv" \
  --document-exclusions "$migration_dir/document-exclusions.csv" \
  --source-s3-env "$migration_dir/source-s3.env" \
  --target testing \
  --target-env "$migration_dir/target-testing.env" \
  --report "$migration_dir/testing-apply-first.report.json" \
  --apply --confirm-target testing:<empreinte>

npm run migrate:reunion -- verify \
  --manifest "$migration_dir/reunion-20260827-v2.jsonl" \
  --usage-map "$migration_dir/usage-map.csv" \
  --point-overrides "$migration_dir/point-overrides.csv" \
  --document-exclusions "$migration_dir/document-exclusions.csv" \
  --target testing \
  --target-env "$migration_dir/target-testing.env" \
  --report "$migration_dir/testing-verify-first.report.json"
```

Puis lancer `verify` et rejouer `apply` avec des rapports distincts, comme en
local. L'empreinte lie le manifeste, la RDB et le bucket attestés. Le script
vérifie aussi la base, le rôle, le port et TLS après connexion, puis la région
et le versioning S3 avant toute mutation. Le fichier `.env.testing` historique
ne doit pas être repris tel quel s'il combine PostgreSQL distant et MinIO
local. Aucune commande de ce dossier n'autorise la production.

## 8. Arrêt et effacement local

Un arrêt simple conserve les trois volumes contenant la copie des données
réelles :

```sh
docker compose -f scripts/reunion/compose.yaml down
```

Après décision explicite de fin de rétention, la commande suivante efface de
façon irréversible uniquement les volumes nommés du projet
`pe-reunion-migration` (Mongo, PostgreSQL et MinIO) :

```sh
docker compose -f scripts/reunion/compose.yaml down --volumes
```

Ne pas supprimer le répertoire opérateur avant d'avoir décidé séparément de la
rétention du backup, du manifeste, de son checksum et des rapports.

Après la migration Testing, révoquer d'abord les clés S3 temporaires. Le mot de
passe PostgreSQL partagé avec l'application n'est pas révoqué par cette
procédure. Les fichiers `source-s3.env` et `target-testing.env` peuvent ensuite
être détruits séparément ; ils ne font pas partie des preuves à conserver.
