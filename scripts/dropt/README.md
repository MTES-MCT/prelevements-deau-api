# Import Epidropt et Rives et Eaux

Les originaux et les rapports restent privés dans `data/dropt/epidropt-2026/`, exclus de l’image Docker et du dépôt public. Vérifier aussi leur exclusion locale dans le sous-dépôt privé `data` avant toute copie. Le mail et ses pièces jointes contiennent notamment une clé d’API.

Disposition attendue :

```text
raw/Prelevement_Epidropt_20_08_2026.xlsx
raw/ExportTableEpiDropt.xlsx
mapping/manifest.json
reports/
```

Depuis la racine de l’API, avec Node de `.nvmrc` :

```sh
npm run import:dropt -- prepare
npm run import:dropt -- apply --target local --target-env .env.local
npm run import:dropt -- apply --target local --target-env .env.local --apply
npm run import:dropt -- verify --target local --target-env .env.local
```

`apply` est une simulation transactionnelle par défaut : sans `--apply`, aucune donnée n’est conservée. `prepare` conserve chaque manifeste par son empreinte dans `mapping/manifests/`. Les rapports sont horodatés. `--manifest`, `--input`, `--overrides` et `--report` permettent de choisir les fichiers ; `verify --against-report chemin.json` vérifie également les identités d’une précédente application.

Pour testing, utiliser `--target testing --target-env .env.testing --tunnel-port PORT_LOCAL` à travers un tunnel déjà ouvert vers PostgreSQL privé. Le script contrôle la cible et vérifie le certificat TLS ; il ne prend pas en charge la production. Les secrets ne passent pas en arguments de commande.

L’import utilise une transaction unique, limitée à 15 minutes par défaut pour couvrir les allers-retours du tunnel. `--transaction-timeout-seconds 900` permet de modifier cette limite (entier de 1 à 1800 secondes). Un dépassement annule toute la transaction, sans import partiel ; le rollback de simulation reste inchangé.

## Règles

- Identités stables par référence métier, jamais par numéro de ligne ou adresse email. Les doublons ambigus et coordonnées incohérentes sont isolés dans les rapports.
- Les emails importés sont des contacts, pas des identifiants de connexion. Aucune invitation ni notification n’est envoyée.
- Le rejeu conserve les changements manuels. Les corrections ambiguës exigent un mapping explicite, sans fusion automatique.
- Un compteur physique peut desservir plusieurs exploitations. Sa répartition inclut aussi les parts hors périmètre, sans les redistribuer aux exploitations importées.
- Les compteurs sans correspondance complète ne publient pas de volumes. L’import initial n’active aucun flux et ne charge pas l’exemple JSON dans les mesures courantes.
- `--activate-at DATE_ISO --service-account-id UUID` active seulement les rapprochements validés à partir de cette date. Une correction de répartition active exige `--effective-at DATE_ISO` et conserve les anciennes versions. Ne pas antidater une répartition actuelle sans justificatif historique.
- Le connecteur Rives récupère des index bruts. Le calcul et la répartition des volumes sont faits une seule fois par l’API. Une collision avec une consommation non identifiée reste à résoudre ; les autres connecteurs restent inchangés.

Les anciens imports `PAR_2026-2027` ont été remplacés ; leur historique reste disponible dans Git.
