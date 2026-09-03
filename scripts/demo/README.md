# Jeu de démonstration Grivaise

La commande `npm run seed:demo -- …` initialise ou contrôle le jeu synthétique
`grivaise-v1` sur une base locale, sur l'environnement `demo` officiel ou sur
une cible non productive décrite par une policy explicite.

Le jeu contient notamment :

- un SAGE fictif couvrant l'Isère et la Drôme ;
- 300 préleveurs synthétiques (240 irrigants, 30 industriels et 30 AEP) ;
- 800 points de prélèvement, dont un partagé et un équipé de plusieurs compteurs ;
- des déclarations déterministes pour 2025 et 2026, avec des cohortes mensuelle,
  hebdomadaire et journalière ;
- six personas configurables : DDT, SAGE, OUGC, industriel, AEP et irrigant.

Le périmètre fictif reprend la géométrie du bassin Bièvre–Liers–Valloire. Les
points sont déplacés de façon déterministe autour de densités d'implantation
réalistes, restent dans leur département et dans le SAGE, et ne forment pas de
quadrillage. Aucune coordonnée historique n'est reprise à l'identique.

Les trois personas préleveurs disposent d’un historique de saisie en ligne. Les
imports GIDAF sont portés par des industriels fictifs distincts du persona
industriel ; la télérelève API comprend les 20 cohortes OUGC journalières et
des gestionnaires AEP de fond.

Les données métier sont identifiées par le préfixe stable
`fixture:grivaise:v1:`. Le jeu est déterministe et la commande est conçue pour
être rejouée sans multiplier les enregistrements qu'elle possède. Les codes de
déclaration utilisent le format distinctif `GR0001` à `GR0420`, compatible avec
la limite globale de six caractères.

## Périmètre volontairement limité à PostgreSQL

Le seed écrit directement l'état métier en base. Il ne :

- crée ni bucket ni objet S3 et n'attache aucun document téléchargeable ;
- crée aucun job Scaleway et n'appelle aucun worker ou file Redis ;
- émet aucun webhook et n'envoie aucun email.

Les adresses du fichier `--accounts` servent uniquement à associer les six
personas. Utiliser des comptes de test accessibles si l'on veut parcourir les
écrans avec ces rôles. Les comptes restent sans mot de passe et sont utilisables
via le parcours normal de lien magique ; le seed lui-même n'envoie aucun mail.
À chaque application, le seed supprime sur ces six UUID les alias de connexion,
les validations d'adresse encore actives, les credentials et les activations
de mot de passe. Si une adresse primaire, un rôle, l'état actif ou un alias doit
être corrigé, il révoque aussi les liens magiques et les sessions concernées — y
compris les sessions d'impersonation — et invalide leur version
d'authentification. Un replay sans changement d'identité conserve en revanche
les liens magiques et sessions créés depuis le seed. La vérification impose
l'absence des artefacts durables (alias et accès par mot de passe), sans exiger
qu'un persona légitimement connecté soit déconnecté. Ce nettoyage ne cible ni
les comptes de service ni les adresses de contact métier des déclarants.
Le compte historique `agent@demo.fr` n'est ni adopté ni modifié : les six
adresses configurées doivent donc être différentes de ce compte. Le préflight
refuse toute collision au lieu de réaffecter un utilisateur existant.

## Interface et garde-fous

```text
npm run seed:demo -- <preflight|apply|verify> \
  --dataset grivaise-v1 \
  --target <local|demo|custom> \
  --target-env <fichier.env> \
  --accounts <fichier.json> \
  [--target-policy <policy.json>] \
  [--report <rapport.json>] \
  [--apply --confirm-target <cible:empreinte>]
```

- `preflight` valide les entrées, l'identité de la cible et les prérequis sans
  écrire le jeu ;
- `apply` sans `--apply` est toujours une simulation ;
- `apply --apply` exige la confirmation exacte `<cible>:<empreinte>` affichée
  par le préflight ou la simulation ;
- `verify` relit la base et contrôle les invariants attendus ;
- `verify` prend un snapshot `REPEATABLE READ` coordonné avec le verrou de
  l'`apply`, afin de ne jamais contrôler un état intermédiaire du seed ;
- la vérification contrôle les six associations de comptes mais ne restitue
  aucune adresse dans l’état, le rapport ou les erreurs ;
- `--target-policy` est obligatoire pour `custom` et interdit pour `local` et
  `demo` ;
- un apply réel hors local exige `--report` ;
- chaque rapport est expurgé des credentials, créé atomiquement en mode `0600`
  et ne remplace jamais un fichier existant.

Le chemin du rapport est réservé avant toute connexion à PostgreSQL. Le champ
`databaseWriteStatus` distingue `DRY_RUN`, `NOT_CONFIRMED` et `COMMITTED`. Si une
lecture ou une vérification échoue après le commit transactionnel, le statut
vaut explicitement `COMMITTED_POSTCHECK_FAILED` ou
`COMMITTED_VERIFICATION_FAILED` : le code de sortie reste non nul, mais il ne
faut alors pas interpréter cet échec comme un rollback.
Ces deux statuts sont toujours affichés dans la console avant la finalisation
du rapport, y compris si l'écriture de ce dernier échoue.

L'empreinte lie la cible autorisée, sa policy, la version du jeu et le mapping
des six comptes, sans exposer leurs adresses ni leur hash dans l'attestation.
Une confirmation obtenue pour une autre base, une autre version ou d'autres
comptes n'est donc pas réutilisable. La production n'est pas une cible
disponible : `prod` est refusé, et une policy `custom` doit porter
`production: false` et ne correspondre à aucune identité de production connue.

`--target-env` et `--accounts` sont lus exclusivement depuis les chemins
fournis : ils ne sont pas fusionnés avec les `.env` du processus. Ces deux
fichiers doivent être ordinaires et n'accorder aucun droit au groupe ou aux
autres utilisateurs (`chmod 600`). Il est recommandé de les conserver dans un
emplacement maîtrisé par l'opérateur et de protéger de la même manière la policy
et le répertoire des rapports.

## Préparer les fichiers privés

Les exemples versionnés utilisent uniquement des valeurs locales ou les
domaines réservés `.example`. Ne jamais y inscrire un mot de passe ou une
adresse personnelle.

```bash
SEED_CONFIG_DIR="/chemin/prive/seed-demo"
install -d -m 700 "$SEED_CONFIG_DIR"
install -m 600 scripts/demo/accounts.example.json "$SEED_CONFIG_DIR/accounts.json"
install -d -m 700 "$SEED_CONFIG_DIR/reports"
```

Éditer ensuite `accounts.json` si les six personas doivent être associés à de
véritables comptes de test. Le fichier doit rester un objet JSON avec exactement
les clés `ddt`, `sage`, `ougc`, `industrial`, `aep` et `irrigant`. Les six
adresses sont normalisées et doivent être valides, non vides et distinctes.

Utiliser un nom de rapport différent à chaque commande : l'absence
d'écrasement est intentionnelle pour conserver une piste d'audit.

## Exécution locale

Sur une base neuve, démarrer PostgreSQL, appliquer les migrations puis importer
les zones de référence avec les commandes habituelles du projet :

```bash
docker compose up -d postgres

APP_ENV=local \
DATABASE_URL='postgresql://prelevements-deau:prelevements-deau@127.0.0.1:5432/prelevements-deau' \
npm run migrate:prisma

APP_ENV=local \
DATABASE_URL='postgresql://prelevements-deau:prelevements-deau@127.0.0.1:5432/prelevements-deau' \
node scripts/import-zones.js
```

Copier la cible locale publique dans le répertoire privé :

```bash
install -m 600 \
  scripts/demo/target-local.env.example \
  "$SEED_CONFIG_DIR/target-local.env"
```

Puis dérouler les quatre étapes. Les chemins de rapport sont volontairement
distincts :

```bash
npm run seed:demo -- preflight \
  --dataset grivaise-v1 \
  --target local \
  --target-env "$SEED_CONFIG_DIR/target-local.env" \
  --accounts "$SEED_CONFIG_DIR/accounts.json" \
  --report "$SEED_CONFIG_DIR/reports/local-01-preflight.json"

npm run seed:demo -- apply \
  --dataset grivaise-v1 \
  --target local \
  --target-env "$SEED_CONFIG_DIR/target-local.env" \
  --accounts "$SEED_CONFIG_DIR/accounts.json" \
  --report "$SEED_CONFIG_DIR/reports/local-02-dry-run.json"

# Remplacer la valeur par la confirmation exacte du préflight/dry-run.
npm run seed:demo -- apply \
  --dataset grivaise-v1 \
  --target local \
  --target-env "$SEED_CONFIG_DIR/target-local.env" \
  --accounts "$SEED_CONFIG_DIR/accounts.json" \
  --report "$SEED_CONFIG_DIR/reports/local-03-apply.json" \
  --apply \
  --confirm-target 'local:<empreinte-affichée>'

npm run seed:demo -- verify \
  --dataset grivaise-v1 \
  --target local \
  --target-env "$SEED_CONFIG_DIR/target-local.env" \
  --accounts "$SEED_CONFIG_DIR/accounts.json" \
  --report "$SEED_CONFIG_DIR/reports/local-04-verify.json"
```

Le code de sortie est non nul si le garde de cible, l'application ou la
vérification échoue. Relancer une étape avec un nouveau chemin de rapport ; ne
pas supprimer un ancien rapport pour masquer un échec.

## Exécution sur l'environnement demo

Avant le premier seed, déployer la même révision de l'API et ses migrations,
exécuter le bootstrap minimal décrit plus bas sur une base vide, puis prendre
un snapshot de la base. Le seed utilise exclusivement le rôle applicatif
`prelevements_demo_app`, jamais le rôle administrateur du bootstrap.

Créer manuellement un fichier `target-demo.env` en mode `0600` :

```dotenv
APP_ENV=demo
DATABASE_URL=postgresql://prelevements_demo_app:<mot-de-passe-encodé>@rw-ea5a07db-05df-4869-9e57-fa5f5c6c81cc.rdb.fr-par.scw.cloud:17063/prelevements_demo?sslmode=verify-full&sslrootcert=/chemin/absolu/vers/postgres-ca.pem
```

Le chemin de CA doit être absolu. Sa somme SHA-256, l'hôte, le port, la base et
le rôle sont tous vérifiés contre la policy `demo` intégrée. Ne pas versionner
ce fichier et ne jamais afficher son URL.

Exécuter ensuite `preflight`, `apply` sans `--apply`, `apply --apply` avec la
confirmation `demo:<empreinte>`, puis `verify`, comme pour la cible locale en
remplaçant :

```text
--target local
--target-env …/target-local.env
```

par :

```text
--target demo
--target-env …/target-demo.env
```

Un rapport distinct est obligatoire lors de l'apply réel. La commande est
lancée depuis un poste opérateur ayant accès à PostgreSQL ; elle ne crée pas de
job distant.

## Exécution sur une cible custom non productive

Copier puis éditer la policy publique :

```bash
install -m 600 \
  scripts/demo/target-policy.example.json \
  "$SEED_CONFIG_DIR/target-policy.json"
```

La policy décrit uniquement l'identité attendue, jamais un credential. Adapter
le `name` de la policy, `appEnv`, puis `database.host`, `port`, `name`, `user` et
`tls`. Avec TLS, remplacer la somme de 64 zéros de l'exemple par la somme
SHA-256 réelle du CA et utiliser `sslmode=verify-full` avec un `sslrootcert`
absolu dans `DATABASE_URL`. Sans TLS, mettre `tls` à `false`, supprimer
`caSha256` et ne fournir aucun paramètre TLS dans l'URL.

```bash
openssl dgst -sha256 /chemin/absolu/vers/ca.pem
```

Créer séparément un `target-custom.env` privé :

```dotenv
APP_ENV=recette
DATABASE_URL=postgresql://prelevements_recette_app:<mot-de-passe-encodé>@postgresql.recette.example:5432/prelevements_recette?sslmode=verify-full&sslrootcert=/chemin/absolu/vers/ca.pem
```

`APP_ENV` et toute l'identité PostgreSQL doivent correspondre exactement à la
policy. La séquence de commandes est la même, avec les options supplémentaires :

```text
--target custom
--target-env …/target-custom.env
--target-policy …/target-policy.json
```

L'apply réel exige `--confirm-target 'custom:<empreinte>'` et un rapport neuf.

## Bootstrap minimal de l'environnement demo

`npm run bootstrap:demo` reste une opération d'infrastructure distincte. Elle
importe les zones de référence, contrôle le référentiel SANDRE, configure
`agent@demo.fr` comme instructeur administrateur de `sage-SAGE04025`, crée le
compte de service fourni par variables d'environnement et accorde les droits au
rôle applicatif.

Le bootstrap exige une base métier vide et utilise le rôle `demo_admin` sur la
cible `demo` exacte. Il doit donc être exécuté avant `seed:demo`, jamais après.
Les migrations du job Scaleway utilisent `node scripts/demo/migrate-demo.js` ;
la commande locale équivalente est `npm run migrate:demo`.

Variables propres au bootstrap :

- `APP_ENV=demo` ;
- `DATABASE_URL` avec `demo_admin`, TLS `verify-full` et le CA attendu ;
- `DEMO_DATABASE_NAME=prelevements_demo` ;
- `DEMO_DATABASE_APP_USER=prelevements_demo_app` ;
- `DEMO_SERVICE_ACCOUNT_CLIENT_ID`, commençant par `sa_` ;
- `DEMO_SERVICE_ACCOUNT_CLIENT_SECRET`.

```bash
APP_ENV=demo npm run bootstrap:demo
```

Le reset du bootstrap efface les données métier sans supprimer les référentiels.
Il reste réservé à une intervention manuelle explicitement autorisée et protégée
par `--reset`, `--confirm-reset=RESET_DEMO`, `DEMO_ALLOW_RESET=RESET_DEMO` et
`DEMO_DATABASE_URL_SHA256`. Ne jamais afficher ni versionner l'URL, son empreinte
autorisée ou le secret du compte de service.

## Scripts historiques : legacy uniquement

Les fichiers suivants appartiennent à l'ancien jeu Aquasys :

- `scripts/demo/import-demo-data.sh` ;
- `scripts/demo/init-demo-fixtures.js` ;
- `scripts/demo/init-demo-declarations.js` ;
- `scripts/demo/template_declaration.xlsx`.

Ils ne constituent pas une alternative à `seed:demo` et ne doivent pas être
utilisés pour initialiser Grivaise. Ils emploient des données aléatoires et,
pour les déclarations, manipulent aussi le stockage S3 et les connexions Redis.
Ils sont conservés uniquement pour documenter et rejouer l'ancien environnement
si une maintenance dédiée l'exige.

Le lanceur est en dry-run par défaut et refuse `testing`, `staging` et la
production. L'ancien import est neutralisé sur `demo` et sur toute cible distante.
Une écriture exige un `APP_ENV` explicite `development` ou `local`, ainsi que des
URL loopback sans paramètre pour PostgreSQL, S3, Redis et l'orchestrateur. Elle
demande enfin une confirmation liée à l'environnement, affichée par le dry-run :

```bash
APP_ENV=local scripts/demo/import-demo-data.sh
APP_ENV=local scripts/demo/import-demo-data.sh \
  --apply --confirm-legacy=APPLY_LEGACY_AQUASYS:local
```

Les deux scripts Node sous-jacents appliquent le même garde lorsqu'ils sont lancés
directement.
