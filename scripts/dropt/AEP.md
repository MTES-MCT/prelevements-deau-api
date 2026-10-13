# Import autonome AEP du Dropt

`import-aep.js` importe uniquement le référentiel AEP préparé depuis ses deux
classeurs. Il ne rattache aucun collecteur et n’importe ni campagne, ni compteur,
ni index, ni volume. Les préleveurs sont des personnes morales gestionnaires AEP,
leurs exploitations actives autorisent la saisie rapide et leurs points sont
manuels. Les emails sources deviennent des identifiants de connexion, sans envoi.

Pour inclure également les usages Loisirs présents dans le classeur epIdropt,
exécuter le [complément Loisirs](LOISIRS.md). Il conserve les identités historiques
et complète les exploitations sans rejouer les retraits AEP.

Les sources, arbitrages, sauvegardes et rapports doivent rester hors Git, dans un
dossier privé durable. `prepare` conserve les originaux dans `raw/`, contrôle
leurs empreintes et archive les manifestes par SHA-256 dans `mapping/manifests/`.
Un original portant le même nom et un contenu différent n’est jamais remplacé.

## Préparation et simulation

Utiliser Node de `.nvmrc`, depuis la racine de l’API :

```sh
node scripts/dropt/import-aep.js prepare --input /chemin/prive/aep \
  --aep-file /chemin/source/aep.xlsx --legacy-file /chemin/source/epidropt.xlsx \
  --decisions /chemin/prive/aep/mapping/decisions.json
node scripts/dropt/import-aep.js review --input /chemin/prive/aep \
  --target prod --target-env /chemin/prive/prod.env --tunnel-port PORT \
  --report /chemin/prive/aep/reports/simulation.json
```

`apply` sans `--apply` réalise la même lecture seule que `review`. Les connexions
distantes acceptent seulement `testing` ou `prod`, leur URL native attendue, le
certificat vérifié et un tunnel local explicite. Chaque environnement exige son
propre rapport. Aucune commande de ce lanceur ne cible demo.

Le JSON d’arbitrage contient `version: 1`, `coordinateSystem: "EPSG:2154"`,
`additionalOperators: [{pointKey, declarantSiret, reason}]`,
`pointOverrides: {pointKey: {codeBSS: null, reason}}`,
`heldExploitationPointNames`, `activePointKeys`, `retirementPointNames` et
`expectedCounts: {declarants, points, exploitations, retirements}`.
Les points sont identifiés par `aeag:IDENTIFIANT` ou `siseaux:IDENTIFIANT`, les
préleveurs par SIRET, les exploitations par point/préleveur/usage. Les numéros de
ligne, emails, coordonnées communes et codes OPR ne sont pas des identités.

Les coordonnées de la source sont Lambert-93 malgré leur en-tête WGS84. Les
arbitrages sont explicites : aucune correction d’identifiant ambigu ni création
d’un point sans fiche. Le SAGE suit les coordonnées et la priorité du milieu,
comme dans l’application. Les corrections manuelles en base bloquent le rejeu
concerné plutôt que d’être écrasées.

## Sauvegarde restaurée et application

L’application exige une sauvegarde restaurée correspondant exactement à l’état
de la simulation. Pour le premier import, `check-aep-backup.js` sauvegarde les
lignes concernées et les restaure dans une base isolée, après chargement d’un
export **du schéma seul** de la production (`pg_dump --schema-only --no-owner
--no-acl`, TLS vérifié et secrets fournis par environnement). Le dump SQL et
l’environnement de restauration restent privés.

La base de restauration doit être `aep_backup_restore`, utilisateur `postgres`,
sur `localhost:55445` ou `127.0.0.1:55445`, sans paramètres d’URL. Les tables
`Zone`, `PointPrelevement`, `PointPrelevementZone`, `ExternalReference` doivent
être vides. Ne jamais utiliser une base applicative. Ce contrôle s’arrête si la
simulation contient déjà des préleveurs ou exploitations : leur sauvegarde
nécessite alors un périmètre distinct, pas une purge de la base de restauration.

```sh
node scripts/dropt/check-aep-backup.js \
  --against-report /chemin/prive/aep/reports/simulation.json \
  --backup /chemin/prive/aep/backups/avant.json \
  --schema-dump /chemin/prive/aep/backups/schema.sql \
  --restore-env /chemin/prive/aep/backups/restore.env \
  --report /chemin/prive/aep/backups/preuve.json
node scripts/dropt/import-aep.js apply --apply --input /chemin/prive/aep \
  --target prod --target-env /chemin/prive/prod.env --tunnel-port PORT \
  --against-report /chemin/prive/aep/reports/simulation.json \
  --backup-proof /chemin/prive/aep/backups/preuve.json \
  --report /chemin/prive/aep/reports/application.json
```

Le script revérifie sources, code, identités, dépendances et état sous verrou.
Le retrait logique des anciens points précède les créations, dans la même
transaction sérialisable. Les UUID, références et zonages retirés restent
conservés ; aucun compte existant n’est supprimé. Une nouvelle dépendance ou
toute erreur annule l’ensemble. Le reçu `PREPARED` est synchronisé sur disque
avant commit, puis passe à `COMMITTED`. En cas d’interruption entre ces étapes,
vérifier l’état réel avant de réexécuter quoi que ce soit.

## Vérification et rejeu

```sh
node scripts/dropt/import-aep.js verify --input /chemin/prive/aep \
  --target prod --target-env /chemin/prive/prod.env --tunnel-port PORT \
  --report /chemin/prive/aep/reports/verification.json
node scripts/dropt/import-aep.js review --input /chemin/prive/aep \
  --target prod --target-env /chemin/prive/prod.env --tunnel-port PORT \
  --report /chemin/prive/aep/reports/rejeu.json
```

Le rejeu attendu affiche zéro création et zéro retrait. Les droits de saisie
rapide, emails, rattachements, absence de collecteurs et identités sont contrôlés.
Un changement de classeur exige une nouvelle préparation et une nouvelle revue.
Les identités restent stables lors de l’ajout ultérieur d’un point confirmé.

L’import historique `import-epidropt.js` exclut désormais ses lignes AEP avant
construction des points. Un point partagé avec un autre usage reste conservé.
Un ancien manifeste visant un point retiré échoue avec `POINT_SUPPRIME` ; il
faut régénérer le manifeste historique, jamais réactiver les anciens points.

## Retour arrière ciblé

```sh
node scripts/dropt/import-aep.js rollback --apply --input /chemin/prive/aep \
  --target prod --target-env /chemin/prive/prod.env --tunnel-port PORT \
  --against-report /chemin/prive/aep/reports/application.json \
  --report /chemin/prive/aep/reports/retour-arriere.json
```

Ce retour arrière exige le même code, le manifeste original, le reçu
`COMMITTED` et un état strictement identique à celui vérifié après application.
Une saisie, connexion, modification manuelle ou nouvelle dépendance le bloque.
Il retire uniquement les créations du reçu et restaure les anciens points et
leurs références, en conservant les audits. Il ne restaure jamais globalement
une sauvegarde sur la production. Une seconde tentative après retour arrière
est refusée. Sans `--apply`, la commande de retour arrière est refusée.

## Tests

Tests unitaires : `aep-source.js`, `aep-cli.js`, `epidropt.js` et
`historical-aep-retirement.js` sous `scripts/dropt/lib/__tests__/`.
Les intégrations AEP exigent `DROPT_INTEGRATION_TESTS=1`, `NODE_ENV=test` et la
base synthétique jetable autorisée sur `localhost:55439` (`security_tests` ou
`integration_tests`), avec les migrations appliquées. Aucun test automatisé ne
doit utiliser la production ni une copie de données réelles.
