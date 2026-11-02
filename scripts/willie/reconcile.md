# Rapprochement Willie sur décision explicite

`reconcile.js` est un outil de maintenance, sans migration de schéma ni appel à
Willie. Il utilise un manifeste relu et les volumes journaliers préparés par le
parseur du dépôt d’orchestration. Les sources brutes, identités, rapports et
sauvegardes restent dans un dossier privé hors Git. Aucun secret ne figure dans
le manifeste. Utiliser Node et npm aux versions indiquées par le dépôt.

## Entrées figées

Le manifeste contient `version: 1`, `operation: "willie-reconcile"`, `createdAt`,
`window: {start, end}` (dates ISO, fin exclusive),
`conflictPolicy: "ARCHIVE_WHOLE_ROW"`, `sourceHashes: {workbook}`, `payloadHash`,
`entries`, `retireConnectors`, `transfers` et `manifestHash`.

- Une entrée désigne `connectorId`, `sourcePointId` (station Willie),
  `exploitationId`, `pointId`, `preleveurId`, `rate`
- Un retrait reprend ces champs et ajoute `archiveValues: true|false`
- Un transfert désigne `exploitationId`, `pointId`, `fromPreleveurId`,
  `toPreleveurId`, `chunkIds` (liste exhaustive de l’historique à transférer)

Le fichier de données contient `version: 1`, `provider: "willie"`, `window`,
`stations: [{sourcePointId, rawSha256, values}]` et `payloadHash`. Chaque valeur
est `{periodStart, periodEnd, value}` : jour UTC de minuit à minuit, volume
numérique positif ou nul en m³. Une absence de donnée n’est pas un zéro : le
parseur omet les valeurs nulles. `values: []` conserve le raccordement sans
inventer de volume. Les empreintes utilisent `digest` exporté par
`lib/reconcile.js`, en excluant le champ d’empreinte du document lui-même.

Les identifiants proviennent d’un inventaire vérifié ; aucun rapprochement par
nom n’est fait par ce programme. La liste contient au plus une exploitation par
station. Plusieurs stations différentes peuvent alimenter la même exploitation,
leurs volumes s’additionnent. Le taux s’applique aux volumes bruts du fournisseur.

## Revue et application

```sh
node scripts/willie/reconcile.js review \
  --manifest /chemin/prive/manifest.json --payload /chemin/prive/payload.json \
  --target prod --target-env /chemin/prive/prod.env --tunnel-port PORT \
  --report /chemin/prive/review.json
```

`review`, `verify` et `apply` sans `--apply` sont en lecture seule. Seules les
cibles natives `prod` et `testing`, avec tunnel local explicite et certificat
vérifié, sont acceptées. Examiner `complete`, `blocked`, `changes`, `summary`
et les lignes `replacements` : le manifeste autorise l’archivage **intégral**
d’une ancienne ligne qui chevauche un jour Willie, même partiellement. Aucun
reliquat estimé n’est créé. Les valeurs et chunks d’origine sont conservés dans
`ChunkValueReplacement`, tandis que les pièces et déclarations restent intactes.

Avant l’application, suspendre la file `pull-updated-data` et attendre la fin
des tâches actives. Un ancien import peut avoir lu son raccordement avant de
prendre son verrou PP : les verrous seuls ne suffisent pas. Conserver la file
en pause jusqu’à la vérification finale et respecter son état initial lors de
la reprise. Le fichier `quiescence.json` contient une observation réelle et
récente (moins de 30 minutes) :

```json
{"target":"prod","queue":"pull-updated-data","paused":true,"active":0,"checkedAt":"DATE_ISO","manifestHash":"SHA256"}
```

La sauvegarde doit avoir été restaurée sur une base isolée et le snapshot
restauré doit correspondre exactement à `review.stateHash`. La preuve contient
`{target, stateHash, backupFile, backupSha256, restoreMatched: true, restoredAt}`.
Le chemin de sauvegarde est absolu ; son contenu est rehaché par le lanceur.
Cette restauration de contrôle est distincte des tests synthétiques.

```sh
node scripts/willie/reconcile.js apply --apply \
  --manifest /chemin/prive/manifest.json --payload /chemin/prive/payload.json \
  --target prod --target-env /chemin/prive/prod.env --tunnel-port PORT \
  --against-report /chemin/prive/review.json \
  --backup-proof /chemin/prive/backup-proof.json \
  --quiescence-proof /chemin/prive/quiescence.json \
  --report /chemin/prive/applied.json
```

La cible, le code, le manifeste, les valeurs, l’état avant et le plan doivent
correspondre à la revue. Les verrous de session PP `volumes-from-index` sont
pris avant `BEGIN`, puis les lignes sont verrouillées en transaction SERIALIZABLE.
Tout changement concurrent pertinent bloque l’opération. Les sources en cours,
les compteurs avec calcul dédié, allocations ou réponses de collecte concernées
par un transfert et les historiques non prévus bloquent aussi l’application.

Un transfert garde l’ID de l’exploitation. Ses chunks sont détachés puis
rattachés dans la même transaction, en respectant les contraintes d’identité.
L’identité du déposant et du collecteur OUGC reste inchangée. L’ancienne identité
de dépôt automatique Willie suit le bénéficiaire. Les chunks d’autres PP et
leurs valeurs ne changent pas ; sur une source partagée seuls les totaux et le
statut global dérivés sont recalculés. Les empreintes de séries modifiées sont
invalidées. Les résumés, dates de dernière donnée et dernières activités des
préleveurs concernés sont recalculés.

Le snapshot `.before.json` est synchronisé sur disque avant mutation. Le reçu
`.prepared.json` est synchronisé avant COMMIT ; seul le reçu final est marqué
`COMMITTED`. Une interruption entre les deux exige de contrôler l’état réel,
sans relancer aveuglément. Une erreur SQL annule les changements et l’audit.
Les sorties existantes ne sont jamais écrasées.

```sh
node scripts/willie/reconcile.js verify \
  --manifest /chemin/prive/manifest.json --payload /chemin/prive/payload.json \
  --target prod --target-env /chemin/prive/prod.env --tunnel-port PORT \
  --report /chemin/prive/verified.json
```

La vérification doit proposer zéro modification. Les valeurs déjà conformes
(périodes UTC, unité `m3`, volume et statut validé) ne sont pas réarchivées. Un
nouveau lancement en écriture exige sa propre revue et preuve de sauvegarde ;
un plan vide ne crée aucun audit supplémentaire.

## Retour arrière

```sh
node scripts/willie/reconcile.js rollback --apply \
  --manifest /chemin/prive/manifest.json --payload /chemin/prive/payload.json \
  --target prod --target-env /chemin/prive/prod.env --tunnel-port PORT \
  --against-receipt /chemin/prive/applied.json \
  --quiescence-proof /chemin/prive/quiescence-fresh.json \
  --report /chemin/prive/rolled-back.json
```

Le reçu COMMITTED, les mêmes entrées et le même code sont requis. Tout écart
avec l’état après bloque le retour arrière. Les données, raccordements,
identités, résumés et révisions des verrous sont restaurés exactement, y compris
la distinction SQL NULL / JSON null. Les audits originaux restent conservés et
un audit compensatoire est ajouté. Un rejeu du retour arrière n’écrit rien si
l’état initial exact et cet audit existent.

Tests : `scripts/willie/lib/__tests__/reconcile.integration.js` et tests CLI
associés. Les intégrations utilisent seulement une base synthétique autorisée,
jamais une copie de production.
