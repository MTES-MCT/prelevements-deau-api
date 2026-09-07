# Jeu de démonstration Grivaise

`npm run seed:demo -- …` initialise ou contrôle le jeu synthétique
`grivaise-v1` en local, sur `demo` ou sur une cible non productive définie
par une policy explicite.

Le jeu comprend un SAGE fictif, 300 préleveurs, 800 points de prélèvement,
des déclarations déterministes pour 2025 et 2026 et six personas configurables :
DDT, SAGE, OUGC, industriel, AEP et irrigant. Les points suivent une répartition
géographique réaliste, sans quadrillage ni reprise à l'identique des coordonnées
historiques.

Les objets appartiennent au préfixe stable `fixture:grivaise:v1:`. Le seed est
rejouable sans multiplier les enregistrements qu'il possède ; les codes de
déclaration utilisent le format `GR0001` à `GR0420`.

## Périmètre et comptes

Le seed écrit uniquement dans PostgreSQL : il ne crée aucun objet S3 ni document
téléchargeable, aucun job distant ou Redis, et n'envoie aucun email ni webhook.

Les six comptes sont configurés par `--accounts`. Ils restent sans mot de
passe et utilisent le parcours normal de lien magique, sans envoi par le seed.
Une adresse doit être accessible à l'opérateur pour tester ce parcours.

À chaque application, le seed retire sur ces six comptes les alias de connexion,
validations d'adresse, credentials et activations de mot de passe. Une correction
d'identité, de rôle ou d'état révoque aussi les liens magiques et sessions
concernés, y compris celles d'impersonation. Un replay sans changement d'identité
conserve les connexions créées depuis le seed. Les comptes de service et les
contacts métier des déclarants ne sont pas concernés.

Le compte historique du bootstrap n'est ni adopté ni modifié. Les adresses
configurées ne doivent pas appartenir à ce compte ni entrer en collision avec
un autre utilisateur existant : le préflight refuse ces réaffectations.

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

- `preflight` contrôle les entrées, l'identité de la cible et les prérequis.
- `apply` sans `--apply` est une simulation.
- `apply --apply` exige la confirmation exacte affichée par le préflight.
- `verify` contrôle les invariants dans un snapshot `REPEATABLE READ`,
  coordonné avec le verrou de l'application du seed.
- Un apply réel hors local exige un rapport.
- `--target-policy` est obligatoire pour `custom`, interdit pour les autres cibles.
- La production est refusée. Une policy custom doit porter `production: false`
  et ne correspondre à aucune identité productive connue.

L'empreinte de confirmation lie la cible, sa policy, la version du jeu et les
six comptes, sans exposer leurs adresses dans le rapport. Une confirmation
obtenue pour une autre configuration ne peut pas être réutilisée.

Les rapports sont expurgés des credentials, créés atomiquement en mode `0600`
et ne remplacent jamais un fichier existant. Leur chemin est réservé avant la
connexion à PostgreSQL. Utiliser un chemin neuf pour chaque commande.

Le champ `databaseWriteStatus` distingue `DRY_RUN`, `NOT_CONFIRMED` et
`COMMITTED`. Les statuts `COMMITTED_POSTCHECK_FAILED` et
`COMMITTED_VERIFICATION_FAILED` signifient que l'écriture a été validée malgré
l'échec du contrôle ultérieur : un code de sortie non nul ne signifie alors
pas rollback. Ne pas effacer un rapport pour masquer un échec.

## Fichiers privés

`--target-env` et `--accounts` sont lus uniquement depuis les chemins fournis,
sans fusion avec les `.env` du processus. Ce doivent être des fichiers ordinaires
sans droits pour le groupe ou les autres utilisateurs (`chmod 600`).

Les exemples versionnés utilisent des valeurs locales ou des domaines réservés.
Ne jamais y inscrire de mot de passe distant ni d'adresse personnelle.

```bash
SEED_CONFIG_DIR="/chemin/prive/seed-demo"
install -d -m 700 "$SEED_CONFIG_DIR" "$SEED_CONFIG_DIR/reports"
install -m 600 scripts/demo/accounts.example.json "$SEED_CONFIG_DIR/accounts.json"
```

Le fichier des comptes doit contenir exactement les clés `ddt`, `sage`,
`ougc`, `industrial`, `aep` et `irrigant`, avec six adresses valides,
normalisées et distinctes. Conserver également les policies et rapports dans
un emplacement privé.

## Exécution locale

Sur une base neuve, démarrer PostgreSQL, appliquer les migrations et importer
les zones de référence avant le seed. Ces commandes doivent viser la même base
locale que le fichier de cible :

```bash
docker compose up -d postgres
APP_ENV=local \
DATABASE_URL='postgresql://prelevements-deau:prelevements-deau@127.0.0.1:5432/prelevements-deau' \
npm run migrate:prisma
APP_ENV=local \
DATABASE_URL='postgresql://prelevements-deau:prelevements-deau@127.0.0.1:5432/prelevements-deau' \
node scripts/import-zones.js
install -m 600 scripts/demo/target-local.env.example "$SEED_CONFIG_DIR/target-local.env"
```

Exécuter ensuite le préflight, la simulation, l'application autorisée et la
vérification, avec un rapport neuf à chaque étape :

```bash
npm run seed:demo -- preflight \
  --dataset grivaise-v1 --target local \
  --target-env "$SEED_CONFIG_DIR/target-local.env" \
  --accounts "$SEED_CONFIG_DIR/accounts.json" \
  --report "$SEED_CONFIG_DIR/reports/local-preflight.json"

npm run seed:demo -- apply \
  --dataset grivaise-v1 --target local \
  --target-env "$SEED_CONFIG_DIR/target-local.env" \
  --accounts "$SEED_CONFIG_DIR/accounts.json" \
  --report "$SEED_CONFIG_DIR/reports/local-dry-run.json"

npm run seed:demo -- apply \
  --dataset grivaise-v1 --target local \
  --target-env "$SEED_CONFIG_DIR/target-local.env" \
  --accounts "$SEED_CONFIG_DIR/accounts.json" \
  --report "$SEED_CONFIG_DIR/reports/local-apply.json" \
  --apply --confirm-target 'local:<empreinte-affichée>'

npm run seed:demo -- verify \
  --dataset grivaise-v1 --target local \
  --target-env "$SEED_CONFIG_DIR/target-local.env" \
  --accounts "$SEED_CONFIG_DIR/accounts.json" \
  --report "$SEED_CONFIG_DIR/reports/local-verify.json"
```

Ne pas utiliser ces commandes de préparation sans vérifier leur environnement ;
le fichier `--target-env` du seed ne configure pas les autres commandes.

## Demo et cible custom

Sur `demo`, utiliser `--target demo` et un fichier privé contenant
`APP_ENV=demo` et une `DATABASE_URL` correspondant au rôle applicatif,
à la base, au certificat et à l'adresse autorisés par la policy intégrée.
Le seed n'utilise pas le rôle administrateur du bootstrap. Le préflight vérifie
notamment `sslmode=verify-full` et un `sslrootcert` absolu.

Les policies et certificats sont versionnés : utiliser une révision compatible
avec la cible et son accès réseau. Les scripts ne créent ni réseau ni tunnel ;
l'adresse locale d'un tunnel n'est pas implicitement autorisée. Ne jamais
contourner un refus de cible ou de certificat pour réutiliser une ancienne URL.

Pour une autre cible non productive, copier `target-policy.example.json` et
utiliser `--target custom --target-policy <fichier.json>`. Adapter le nom,
`appEnv`, les champs `database` et TLS à l'identité attendue. Avec TLS,
remplacer la somme de 64 zéros par le SHA-256 réel du CA ; sans TLS, retirer
`caSha256` et les options TLS de l'URL.

La séquence reste `preflight`, simulation, apply autorisé, puis `verify`.
Les confirmations sont respectivement `demo:<empreinte>` et
`custom:<empreinte>`, avec des rapports distincts. Faire un snapshot de la base
avant la première application distante.

## Bootstrap et migrations manuelles

`npm run bootstrap:demo` est distinct du seed : il importe les zones de
référence, contrôle SANDRE, initialise un instructeur historique et un compte
de service, puis accorde les droits au rôle applicatif. Il exige une base métier
vide et le rôle administrateur attendu. L'exécuter avant `seed:demo`, jamais
sur un jeu existant.

Variables à fournir séparément, dans une configuration privée :

- `APP_ENV=demo` et `DATABASE_URL` administrateur avec TLS vérifié ;
- `DEMO_DATABASE_NAME` et `DEMO_DATABASE_APP_USER`, conformes aux garde-fous ;
- `DEMO_SERVICE_ACCOUNT_CLIENT_ID`, commençant par `sa_` ;
- `DEMO_SERVICE_ACCOUNT_CLIENT_SECRET`.

`npm run migrate:demo` reste un utilitaire manuel vérifiant la cible avant
`prisma migrate deploy`. Ce n'est pas le point d'entrée du migrateur privé
utilisé par la CI.

Le reset du bootstrap efface les données métier sans supprimer les référentiels.
Il exige une autorisation explicite et les protections `--reset`,
`--confirm-reset=RESET_DEMO`, `DEMO_ALLOW_RESET=RESET_DEMO` et
`DEMO_DATABASE_URL_SHA256`. Ne jamais afficher ni versionner l'URL, son
empreinte autorisée ou le secret du compte de service.
