# Outils manuels de préparation de demo

Ces outils ciblent uniquement l'environnement `demo` autorisé par leurs
garde-fous. Ils ne sont pas les points d'entrée des migrations privées de la CI.

## Bootstrap minimal

`npm run bootstrap:demo` importe les zones de référence, vérifie le référentiel
SANDRE créé par les migrations, initialise un instructeur et un compte de service,
puis accorde les droits au rôle applicatif.

Le bootstrap exige une base métier vide. Il refuse de continuer si un déclarant,
un point ou une déclaration existe déjà et contrôle ces compteurs en fin
d'exécution. Il ne doit pas être lancé sur un environnement contenant un jeu
métier à conserver.

Préparer séparément une configuration privée :

- `APP_ENV=demo` ;
- `DATABASE_URL` avec la base, le rôle administrateur, le point d'accès et le
  certificat autorisés par le garde-fou ;
- `DEMO_DATABASE_NAME` et `DEMO_DATABASE_APP_USER`, conformes aux identités attendues ;
- `DEMO_SERVICE_ACCOUNT_CLIENT_ID`, commençant par `sa_` ;
- `DEMO_SERVICE_ACCOUNT_CLIENT_SECRET`.

Après contrôle de la cible et autorisation explicite :

```bash
APP_ENV=demo npm run bootstrap:demo
```

Le bootstrap accorde les droits sur les tables, séquences et fonctions
existantes ainsi que les privilèges par défaut requis pour les objets suivants.

## Migrations manuelles

`npm run migrate:demo` vérifie l'identité PostgreSQL autorisée avant d'appeler
`prisma migrate deploy`. Il reste un utilitaire manuel distinct du migrateur
privé utilisé lors des déploiements.

Les garde-fous imposent l'environnement, la base, le rôle, l'adresse, le port,
`sslmode=verify-full` et le certificat attendu. Utiliser une révision compatible
avec la cible et son accès réseau : ces scripts ne créent ni réseau ni tunnel
et ne rendent pas implicitement admissible une adresse locale de transport.
Ne pas contourner un refus pour réutiliser une ancienne configuration.

## Reset manuel

Le reset efface les données métier, sans supprimer les zones ni les référentiels.
Il exige une sauvegarde adaptée, une autorisation explicite et les protections :

1. `APP_ENV=demo` ;
2. `--reset` ;
3. `--confirm-reset=RESET_DEMO` et `DEMO_ALLOW_RESET=RESET_DEMO` ;
4. `DEMO_DATABASE_URL_SHA256` correspondant à la cible expressément autorisée.

Ne jamais afficher ni versionner la configuration privée, l'URL, son empreinte
autorisée ou le secret du compte de service.
