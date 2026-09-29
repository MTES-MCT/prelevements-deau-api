# Initialisation ciblée d’un point Eveler

Ce script crée ou réutilise un seul point physique, un préleveur personne morale,
son exploitation et son connecteur `eveler`. Il ne charge aucune télémesure et
ne contacte pas Eveler. Il ne crée ni autorisation administrative, ni compteur
physique, ni affectation de compteur, ni déclaration, ni compte de service,
ni identifiant secret, ni courrier. Il ne renseigne pas de date de début
d’exploitation lorsqu’elle n’est pas connue.

Le manifeste et les rapports contiennent des informations privées : ils doivent
être dans un répertoire existant de mode `0700`, hors de toute arborescence Git,
avec des fichiers de mode `0600`. Ne pas les ajouter à `data/`. Les rapports
doivent porter un nouveau nom à chaque exécution : ouverture exclusive, aucun
écrasement. Les fichiers d’entrée symboliques sont refusés.

## Manifeste privé, version 1

Les valeurs ci-dessous sont entièrement synthétiques. Les identifiants, le nom,
les coordonnées et les coordonnées de contact doivent provenir de sources
validées avant l’exécution. Les champs inconnus sont refusés, notamment les
secrets et les dates d’exploitation.

```json
{
  "schemaVersion": 1,
  "point": {
    "name": "Forage synthétique",
    "sourceId": "DDT99:SYNTHETIC",
    "identifiers": {"DDT": "SYNTHETIC"},
    "coordinatesLambert93": {"x": 700000, "y": 6600000},
    "waterBodyType": "SOUTERRAIN",
    "flowType": "PRELEVEMENT",
    "pointKind": "PHYSIQUE",
    "nature": "NAPPE",
    "withdrawalType": "SOUTERRAIN",
    "isZre": false
  },
  "preleveur": {
    "companyName": "Société synthétique",
    "email": "synthetic@example.test",
    "siret": "00000000000000",
    "firstName": "Camille",
    "lastName": "Exemple",
    "type": "PM"
  },
  "exploitation": {"usageCode": "7E", "status": "EN_ACTIVITE"},
  "connector": {
    "type": "eveler",
    "sourcePointId": "synthetic-meter",
    "sourceMeterId": "000000000000000000000001",
    "sourceStartDate": "2025-01-02T03:00:00Z",
    "rate": 100
  }
}
```

`point.communeCode` est facultatif : lorsqu’il est fourni, le nom officiel est
dérivé par `lib/util/cog.js`. Le script ne déduit pas une commune depuis les
coordonnées. La géométrie utilise `ST_Transform(..., 2154 → 4326)` ; les zones
sont déterminées par PostGIS et `selectPointZones`, le service existant qui
gère la compatibilité de ressource et les ambiguïtés SAGE. Aucune zone existante
n’est supprimée.

`sourcePointId` est l’identifiant utilisé dans le chemin de l’API Eveler.
`sourceMeterId` est l’identifiant interne du compteur, composé de 24 caractères
hexadécimaux minuscules : il sert à vérifier le `meter_id` des réponses et
doit être confirmé auprès du fournisseur. Ces deux identifiants sont distincts.

`sourceStartDate` est la borne de données du fournisseur, indépendante du début
de l’exploitation. Une date sans heure devient minuit UTC ; un horodatage doit
avoir `Z` ou un décalage explicite et est normalisé en UTC.

Le code source `7E` (« Canon à neige ») est un sous-usage SANDRE. Le modèle
actuel impose un usage racine pour les usages principaux **et** secondaires
d’exploitation. Le script vérifie la filiation du catalogue puis affecte
l’usage principal `7` (« Loisirs »), sans faux usage secondaire. À la création,
il conserve « Canon à neige » dans `point.usageName` et
« Usage SANDRE : 7E — Canon à neige. » dans le commentaire de l’exploitation.
Le rapport expose explicitement la correspondance `7E → 7`. Les valeurs
préexistantes différentes sont bloquantes, jamais écrasées.

Le champ facultatif `serviceAccount: {"existingId": "UUID"}` vérifie uniquement
l’existence d’un compte actif. Aucun droit ou rattachement n’est modifié.
Les règles actuelles d’accès aux contextes et de découverte des déclarants
sont globales pour les comptes de service ; le script ne prétend pas les
restreindre au seul point. L’exécution de télémesure doit sélectionner
explicitement le couple point/exploitation et son connecteur.

## Simulation, application, vérification

Utiliser Node indiqué par `.nvmrc`, avec `APP_ENV=testing` ou `APP_ENV=prod` et
`DATABASE_URL` déjà injectés par le canal privé habituel. Aucun fichier `.env`
n’est chargé automatiquement. Les secrets restent hors du manifeste, des
rapports et de la ligne de commande. Exécuter dans l’environnement réseau qui
peut joindre la base administrative correspondante avec son certificat TLS.
Les gardes existants `scripts/network/*-database-target.js` vérifient URL,
identité SQL et TLS ; ce script exige aussi l’adresse et le port réels du serveur.
Il n’existe aucune option permettant de désactiver ces gardes pour le CLI.
Pour un tunnel local validé, un opérateur peut importer `run(options, environment,
{createDatabaseClient})` : cette fabrique reçoit l’URL canonique validée et doit
fournir un client `pg` conservant la vérification TLS du nom/IP canonique et la
CA de la cible, en remplaçant uniquement le transport par le tunnel local.
Les contrôles SQL d’identité et d’adresse effective restent obligatoires.

```sh
node scripts/eveler/initialize.js --target testing \
  --manifest /private/eveler/manifest.json \
  --report /private/eveler/preflight-01.json
```

La simulation est la valeur par défaut et sa transaction SQL est en lecture
seule. Le JSON écrit sur la sortie standard contient uniquement statut,
opération, noms d’actions et empreinte SHA-256 du rapport privé. Examiner le
rapport, puis transmettre cette empreinte exacte à l’application autorisée :

```sh
node scripts/eveler/initialize.js --target testing \
  --manifest /private/eveler/manifest.json \
  --report /private/eveler/apply-01.json --apply \
  --preflight /private/eveler/preflight-01.json \
  --expect-sha256 EMPREINTE_SHA256_EXACTE_DU_RAPPORT

node scripts/eveler/initialize.js --target testing \
  --manifest /private/eveler/manifest.json \
  --report /private/eveler/verify-01.json --verify
```

Production utilise la même procédure avec `--target prod` et une simulation
distincte sur cette base. Une simulation testing ne peut pas autoriser prod.

L’application compare le manifeste, l’inventaire et l’identité de base au
rapport approuvé dans une transaction sérialisable. Les noms/identifiants
ambigus, adresses réservées, différences de SIRET, géométrie, profil,
exploitation ou paramètres de connecteur sont bloquants. Les données
préexistantes ne sont jamais écrasées. La convention `UserEmailIdentity` est
assurée par les triggers habituels lors de l’insertion du `User`.
Un nouveau profil reçoit le type de préleveur `AUTRE`, valeur par défaut du
modèle métier existant lorsqu’aucune catégorie spécifique n’est renseignée.
Le type d’un profil déjà présent est conservé.

Le rejeu consiste à refaire une simulation : un état déjà initialisé produit
zéro action, puis `--verify` confirme cet état en lecture seule. Un ancien
rapport précédant l’initialisation est périmé et ne peut pas être réappliqué.
Les brouillons, autres liens, propriétés, curseurs de télémesure et dates
connues préexistantes restent intacts.

Le rapport `transaction-verified-not-committed` indique une interruption avant
la confirmation de commit : refaire une simulation ou vérification avant de
conclure. Les erreurs SQL susceptibles de contenir des données personnelles
ne sont pas affichées ; corriger la cause puis produire un nouveau rapport.

## Tests

```sh
npx --no-install eslint scripts/eveler
npx --no-install ava scripts/eveler/__tests__/initialize.js
```

Le test PostGIS exige les migrations appliquées sur une base **jetable**,
`NODE_ENV=test`, `EVELER_INTEGRATION_TESTS=1` et `DATABASE_URL` conforme à
`requireDisposableDatabase` (localement `localhost:55439/integration_tests`).
Il travaille uniquement sur des données synthétiques et annule sa transaction.

```sh
npx --no-install ava scripts/eveler/__tests__/database.integration.js
```
