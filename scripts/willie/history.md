# Rattachement de l’historique Willie aux exploitations

Ce lanceur dédié accepte uniquement `testing` et `prod`, leurs identités natives
et un tunnel local explicite avec TLS vérifié. Il ne modifie que
`Chunk.exploitationId`, de `NULL` vers l’exploitation confirmée. Il ne recalcule
aucun volume et ne change aucun index, valeur, compteur, usage ou date.
Le script générique `scripts/backfill-chunk-exploitations.js` reste inchangé.

Le fichier privé `scope.json` contient `version: 1`, `connector: "willie"`,
`entries: [{connectorId, exploitationId, preleveurId, pointId, sourcePointId,
rate}]` et `scopeHash`, SHA-256 du contenu canonique sans `scopeHash` (export
`digest` de `lib/history.js`). Les UUID proviennent de l’inventaire vérifié, pas
de rapprochements par nom. Le dossier, ses sources, rapports et sauvegardes
restent hors Git, avec fichiers privés.

Toutes les identités du scope sont contrôlées, y compris les connecteurs sans
données. Les sources doivent être API, Willie et terminées ; les métadonnées de
source et de chunk doivent identifier exactement connecteur, station, taux,
préleveur et point. Le chunk doit être GENERIC, sans compteur physique, appartenir
au préleveur attendu et avoir une seule exploitation compatible. Sa période doit
être entièrement contenue dans celle de l’exploitation. Un rattachement existant
différent, une ambiguïté ou une incohérence bloque tout le lot.

Depuis la racine API, utiliser les versions de `.nvmrc` et `packageManager` :

```sh
node scripts/willie/history.js review --scope /chemin/prive/scope.json \
  --target prod --target-env /chemin/prive/prod.env --tunnel-port PORT \
  --report /chemin/prive/review.json
```

`apply` sans `--apply` effectue aussi une revue en lecture seule. La revue inclut
les chunks complets et les empreintes des valeurs, remplacements et autres chunks
des points concernés. Elle ne contient aucun jeton d’authentification. Examiner
`complete`, `blocked`, `changes` et `summary` avant application.

L’application exige une preuve de sauvegarde restaurée du même périmètre :
`{target, stateHash, backupFile, backupSha256, restoreMatched: true, restoredAt}`,
avec chemin absolu du fichier sauvegardé et date ISO. `stateHash` doit correspondre
à la revue ; le fichier est rehaché par le lanceur. La restauration de contrôle
se fait sur une base isolée distincte de toute base applicative et de toute base
de tests synthétiques.

```sh
node scripts/willie/history.js apply --apply --scope /chemin/prive/scope.json \
  --target prod --target-env /chemin/prive/prod.env --tunnel-port PORT \
  --against-report /chemin/prive/review.json \
  --backup-proof /chemin/prive/backup-proof.json \
  --report /chemin/prive/applied.json
node scripts/willie/history.js verify --scope /chemin/prive/scope.json \
  --target prod --target-env /chemin/prive/prod.env --tunnel-port PORT \
  --report /chemin/prive/verified.json
node scripts/willie/history.js review --scope /chemin/prive/scope.json \
  --target prod --target-env /chemin/prive/prod.env --tunnel-port PORT \
  --report /chemin/prive/replay.json
```

Le rejeu de revue doit proposer zéro modification. Un rejeu en écriture utilise
une nouvelle revue et sa propre preuve restaurée ; il ne crée aucun audit à zéro
changement. Les fichiers de sortie existants ne sont jamais remplacés.

Avant `BEGIN`, les verrous de session des points utilisent le même espace
`volumes-from-index` que les ingestions/reconstructions. La transaction
SERIALIZABLE commence après leur acquisition, puis verrouille sources, chunks,
valeurs et identités. La revue, son code et son scope doivent rester identiques.
Le snapshot `.before.json` est synchronisé sur disque avant mutation ; un reçu
`.prepared.json` immuable est synchronisé avant COMMIT. Le reçu final porte
`COMMITTED`. Une interruption entre ces étapes exige une lecture de l’état réel
avant reprise. Toute erreur SQL annule les modifications et leurs audits.

Les empreintes après application doivent correspondre exactement au snapshot
initial où seuls les `exploitationId` des changements annoncés sont remplacés.
Les audits de maintenance utilisent un acteur explicite sans usurper un utilisateur
et des scopes PP, déclarant et exploitation.

Retour arrière ciblé, avec le même scope et la même version du code :

```sh
node scripts/willie/history.js rollback --apply --scope /chemin/prive/scope.json \
  --target prod --target-env /chemin/prive/prod.env --tunnel-port PORT \
  --against-receipt /chemin/prive/applied.json \
  --report /chemin/prive/rollback.json
```

Le reçu doit être COMMITTED et l’état exact de fin d’application doit subsister.
Tout nouvel historique ou changement d’identité/valeur bloque le retour arrière.
Seules les associations du reçu redeviennent NULL, les audits d’origine restent
conservés et un audit de retour arrière est ajouté. Son rejeu est sans effet si
l’état initial exact et cet audit sont retrouvés. Après retour arrière, une revue
proposera naturellement à nouveau les associations ; ne pas lancer une nouvelle
application sans décision explicite et nouvelle vérification du journal.

Tests : `scripts/willie/lib/__tests__/history-cli.js` et
`scripts/willie/lib/__tests__/history.integration.js`. Les intégrations exigent
`DROPT_INTEGRATION_TESTS=1`, `NODE_ENV=test` et une base synthétique autorisée sur
localhost:55439. Aucun test automatisé ne doit utiliser une copie de production.
