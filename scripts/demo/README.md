# Bootstrap minimal de l'environnement demo

Le nouvel environnement `demo` doit rester vide de données métier. Le bootstrap
importe les zones de référence, vérifie le référentiel SANDRE créé par les
migrations, configure `agent@demo.fr` comme instructeur administrateur de la
zone `sage-SAGE04025`, puis injecte le compte de service fourni par variables
d'environnement. Le secret du compte de service n'est jamais affiché.

Variables obligatoires :

- `APP_ENV=demo` ;
- `DATABASE_URL` ;
- `DEMO_DATABASE_NAME=prelevements_demo`, nom exact figé de la base demo ;
- `DEMO_DATABASE_APP_USER=prelevements_demo_app`, rôle non administrateur figé utilisé par l'API et le worker ;
- `DEMO_SERVICE_ACCOUNT_CLIENT_ID` avec un identifiant commençant par `sa_` ;
- `DEMO_SERVICE_ACCOUNT_CLIENT_SECRET`, transmis comme secret d'exécution.

Pour éviter toute migration ou initialisation sur une autre instance, le garde
exige que `DATABASE_URL` cible l'endpoint public de l'instance PostgreSQL demo,
le port `17063`, la base `prelevements_demo`, l'utilisateur `demo_admin` et
`sslmode=verify-full`. Il exige aussi le CA embarqué via
`sslrootcert=/usr/local/share/ca-certificates/scw-postgres-ca.crt`.

Exécution idempotente :

```bash
APP_ENV=demo npm run bootstrap:demo
```

Le bootstrap refuse de continuer si un déclarant, un point ou une déclaration
existe déjà. Il termine en vérifiant que ces trois compteurs restent à zéro.
Il accorde aussi au rôle applicatif les droits sur les tables, séquences et
fonctions existantes, ainsi que les privilèges par défaut nécessaires aux
objets créés par les migrations suivantes.

Les migrations du job Scaleway appellent directement
`node scripts/demo/migrate-demo.js` ; la commande locale équivalente est
`npm run migrate:demo`. Le garde refuse toute URL qui ne cible pas exactement
la base `prelevements_demo` avec l'utilisateur `demo_admin`, avant d'appeler
Prisma.

## Reset manuel

Le reset efface les données métier, sans supprimer les zones ni les
référentiels. Il est protégé par quatre contrôles indépendants :

1. `APP_ENV` vaut exactement `demo` ;
2. l'option `--reset` est présente ;
3. l'option `--confirm-reset=RESET_DEMO` et la variable
   `DEMO_ALLOW_RESET=RESET_DEMO` concordent ;
4. `DEMO_DATABASE_URL_SHA256` correspond à l'empreinte SHA-256 exacte de la
   `DATABASE_URL` autorisée.

```bash
APP_ENV=demo \
DEMO_ALLOW_RESET=RESET_DEMO \
DEMO_DATABASE_URL_SHA256='<empreinte autorisée>' \
npm run bootstrap:demo -- --reset --confirm-reset=RESET_DEMO
```

Ne jamais afficher ni versionner `DATABASE_URL`, l'empreinte autorisée ou le
secret du compte de service.

## Ancien jeu de démonstration riche

Les commandes historiques ci-dessous créent volontairement des déclarants,
des points et des déclarations. Elles ne font pas partie du bootstrap minimal
du nouvel environnement `demo` et ne doivent pas y être lancées.

Depuis la racine du projet :

```bash
# Import des zones
node scripts/import-zones.js

# Irrigants Aquasys
node scripts/demo/init-demo-fixtures.js
node scripts/demo/init-demo-declarations.js
```
