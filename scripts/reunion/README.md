# Migration rejouable de La Réunion

`npm run migrate:reunion -- …` transfère les déclarants, points de prélèvement,
exploitations, agents, documents et règles du Mongo historique vers PE.
Les séries, volumes, index, déclarations et dossiers DS sont exclus.

Le script n'écrit pas sur les cibles par défaut. Une application exige
`--apply`, une cible autorisée `local|testing` et sa confirmation exacte.
La production est interdite. Les snapshots et rapports restent des écritures
locales, y compris lors d'une simulation.

Cette restriction concerne la migration du référentiel Mongo/S3. L’étape
`access-*` ci-dessous accepte également une cible `prod` strictement attestée.

## Noms et identifiants des points Réunion

Les PP conservent le numéro métier `id_point` de l’ancienne application : le nom
est `123 - Captage de ...` et `identifiers.REUNION` vaut la chaîne `123`.
Le `sourceId` `reunion:DEP-974:point:123` et l’UUID PE restent stables. Les autres
identifiants sont conservés ; un identifiant Réunion contradictoire ou un nom
cible appartenant à un autre PP bloque la reprise. Le champ propre à l’Agence
de l’eau n’est pas utilisé pour cet identifiant.

Après une première migration, `sync-point-identities.js` reprend uniquement
`name` et cette clé d’identifiant sur les 453 PP existants du manifeste intact.
Il ne relance ni contacts/droits ODS, ni S3, ni historique ou calcul de volumes.
Les autres champs et associations sont contrôlés avant/après ; le rejeu produit
zéro modification. La version de cette règle est incluse dans l’empreinte du
plan ciblé, indépendamment du contrat du manifeste source conservé.

```sh
node scripts/reunion/sync-point-identities.js \
  --manifest <archive>/reference/manifest.jsonl \
  --target testing --target-env <configuration-privée> --tunnel-port <port> \
  --report <rapport-simulation-neuf.json>
```

Pour appliquer sur testing, ajouter `--apply`, `--confirm-target` issu de cette
simulation, `--against-report` et `--backup-evidence`. Cette preuve doit porter
sur une sauvegarde **actuelle et ciblée** des lignes `before` du rapport, avec
restauration vérifiée en base locale jetable, et non sur le dump précédant
l’import historique. Elle comporte `target`, `operation`, `sourceHash`,
`planHash`, `rowsSha256`, `backupFile`, `backup.sha256`,
`restore.success=true` et `restore.matchesPreflight=true`. Le fichier JSON
sauvegardé contient `operation`, `sourceHash` et `rows`. Les empreintes, la
simulation, l’état courant et la cible attestée doivent tous correspondre.
Les fichiers restent privés hors Git. Refaire ensuite une simulation puis
une application de rejeu ; aucune ligne ne doit changer.

## Répétition locale complète : historique DN et fichiers natifs

Le rapprochement natif identifie le PP par son `sourceId` exact, indépendamment
des dates d’exploitation. Une exploitation n’est associée que si elle est unique
pour ce préleveur et couvre toute la série. Sinon le PP reste identifié et un
avertissement indique l’exploitation absente, ambiguë ou la période non couverte ;
aucune exploitation ni autorisation n’est créée ou prolongée. Le statut interne
`PENDING` est conservé dans ce cas : comme les autres données PE non rejetées,
les mesures reconnues sont consultables sur le PP. Il ne constitue pas un nouveau
circuit d’instruction. Les conflits de période d’un même PP/préleveur/dimension
restent exclus, y compris avec une série `PENDING` déjà rattachée.
Un dossier importé par lots reste masqué tant que sa dernière partie n'est pas
reçue. Les dates d'activité, totaux et caches sont rafraîchis au premier lot
(retrait d'une publication précédente) puis au dernier (publication complète),
sans rescanner l'historique à chaque fichier intermédiaire.
La politique native existante `SKIP_NEW_CHUNK` écarte la série entière, même si
le chevauchement est partiel ; toutes ses valeurs restent conservées. Cette
reprise ne découpe pas une série et ne tranche pas entre valeurs contradictoires.

### Récupérer les valeurs sans conflit

`recover-native-overlaps.js` reprend une liste explicite de séries Réunion DN
acceptées, rejetées pour `OVERLAPPING_SERIES`. Un snapshot privé est produit avec
`captureNativeOverlapSnapshot`, puis comparé à l'état courant en simulation.
Chaque valeur est comparée aux publications existantes et à toute la cohorte :
seuls les intervalles entièrement disjoints sont publiés. Les doublons strictement
identiques sont conservés une fois ; les contradictions et périodes partiellement
communes restent dans les originaux rejetés. Aucun intervalle n'est découpé.

Les publications dérivées portent `nativeOverlapRecovery` avec le parent, son
empreinte et la sélection ; chaque copie conserve l'UUID original dans sa
provenance. Aucun original n'est effacé ou modifié. Les compteurs physiques
incluent donc les copies : distinguer les valeurs conservées des valeurs visibles.

L'application testing exige une simulation identique, la cible attestée et la
preuve de restauration du snapshot actuel. Le rejeu est idempotent. Un réimport
natif identique conserve les dérivés ; le changement ou retrait du parent les
retire. Corriger d'abord les fichiers et rattachements justifiés, puis refaire le
snapshot avant cette reprise. Aucun mode générique d'acceptation partielle n'est
activé pour les autres imports.
La simulation utilise un instantané cohérent ; l'application relit l'état et les
valeurs concurrentes après acquisition des verrous, pour détecter aussi un import
terminé pendant l'attente de ces verrous.

```sh
node scripts/reunion/recover-native-overlaps.js \
  --snapshot <snapshot-privé.json> --target testing \
  --target-env <configuration-privée> --tunnel-port <port> \
  --report <rapport-simulation-neuf.json>
```

### Restaurer un document réglementaire retrouvé

`restore-document.js` complète un document explicitement manquant/exclu du
manifeste source intact. Le PDF retrouvé doit avoir la taille exacte et
l'empreinte attendue dans la clé de stockage historique. Le propriétaire, les
exploitations et les règles proviennent uniquement de ce manifeste. L'objet S3
est créé sans écrasement, puis relu et vérifié avant de créer le document et ses
liens. Les valeurs des règles et les droits restent inchangés.

```sh
node scripts/reunion/restore-document.js \
  --manifest <archive>/reference/manifest.jsonl \
  --legacy-document-id <identifiant-source> --file <pdf-retrouvé> \
  --source-url <url-publique-https> --target testing \
  --target-env <configuration-privée> --tunnel-port <port> \
  --report <rapport-simulation-neuf.json>
```

L'application exige les mêmes options de confirmation, simulation et sauvegarde
restaurée que la reprise des identités, avec l'opération
`reunion-recovered-document`. Conserver le PDF, sa provenance et les rapports hors
Git. **Rejouer cette étape après toute nouvelle migration du référentiel** : son
manifeste historique conserve volontairement l'exclusion initiale et peut remettre
les liens de règles à vide. Cette étape les rétablit sans recréer le document.

Le rejeu d’une révision identique, ou d’un lot déjà reçu, peut réparer uniquement
une association automatique encore absente. Il conserve les valeurs, UUID,
empreintes et décisions manuelles. La reprise ciblée `repair-point-associations.js`
utilise une liste explicite de séries sauvegardées, les mêmes attestations testing,
une simulation et une preuve de restauration. Elle ne relance pas l’historique.

Le parcours historique est séparé du migrateur de référentiel. La cible locale
reste celle utilisée par défaut ; une reprise sur testing exige les attestations
décrites plus bas. Pour la répétition locale, les destinations SQL/S3/Mongo sont
celles fixes de la pile isolée. Le clone PE production doit être restauré
localement et les migrations Prisma appliquées avant les imports.

1. `prepare-local.js --output <archive>/runtime` produit des configurations
   privées pour API 5500, front 3300 et orchestrateur 5501. Les emails vont à
   Mailpit 1026/8026, Sentry et les fournisseurs distants restent désactivés.
   L'orchestrateur doit utiliser `SCHEDULER_ENABLED=false` et
   `WORKER_JOBS=process-declaration`. Ne pas lancer le worker API général.
2. `capture-legacy.js --output <archive> --mongo-tunnel-port <port>` lit
   l'application Scalingo `prelevement-deau-api` : collections métier sans
   authentification, pièces démarche 80149 et documents Réunion référencés.
   Sur l'ancien serveur Mongo, passer `--mongo-driver` vers le module
   `mongodb/lib/index.js` de l'installation historique (driver 6), le driver
   applicatif 7 étant incompatible avec ce serveur. Aucun contournement TLS.
3. `capture-dn.js --archive <archive>` interroge uniquement la démarche 80149
   via le nouvel endpoint DN. Il archive les dossiers et récupère les pièces
   absentes du S3 historique, avec contrôle du checksum. Les URL signées et
   jetons ne sont pas conservés. Aucun webhook ni synchronisation récurrente.
4. `restore-archive.js --archive <archive> --mongo-driver <module>` vérifie les
   empreintes en simulation ; ajouter `--apply` pour restaurer dans
   `reunion_source_20261025` sur Mongo local et les buckets `reunion-source-*`.
   Les anciennes bases locales restent préservées.
5. Exécuter le snapshot et le référentiel ci-dessous avec le Mongo/S3 locaux,
   les mappings privés actualisés et **`--skip-agents`** pour chaque
   préflight/application/vérification. Les droits doivent ensuite venir du
   registre ODS et de son mapping validé incluant les retraits d'octobre.
6. `prepare-history.js --archive <archive> --parser-module <orchestration>/dist/src/connectors/reunion.js --output <archive>/prepared-01`
   relit chaque original et produit un dossier par numéro DN, les séries
   natives, anomalies, provenance et un bilan fichier par fichier. Les valeurs
   restent dans des partitions JSON privées par fichier (`parsedFiles`), jamais
   dans un unique JSONB de plusieurs centaines de Mo. Chaque partition conserve
   toutes ses erreurs ; le dossier ne porte qu’un résumé. Le dossier
   de sortie doit être neuf. Les index manuels et volumes saisis dans DN sont
   aussi repris ; les dates ambiguës restent des anomalies avec leur valeur
   brute. Un volume annuel reste annuel, sans répartition quotidienne fictive.
   Après interruption, `--resume-from <préparation précédente>` réutilise les
   dossiers terminés après contrôle des sources et empreintes des partitions,
   dans un nouveau dossier de sortie. Conserver la même version des parseurs
   pour cette reprise ; l'archive précédente reste intacte.
   Après correction ciblée d'un parseur, ajouter `--reparse-dossier <numéro>`
   relit uniquement ce dossier ; les autres partitions et identités revues
   restent conservées. Vérifier les empreintes avant/après pour confirmer le
   périmètre de la nouvelle préparation.
   Une revue d'identités approuvée peut ensuite être appliquée avec
   `reconcile-history.js --archive <archive> --prepared <préparation> --identity-review <revue.json> --output <nouvelle-préparation>`.
   La revue doit désigner la préparation et chaque dossier par SHA-256, un
   préleveur source existant et des preuves précises. Seules ses lignes
   `IDENTITY_PROVEN` changent le déclarant ; les lignes HOLD restent sans
   association. Les PP, exploitations, dates d'accès et droits restent ceux
   du référentiel. Les originaux et les valeurs préparées sont inchangés.
7. `import-history.js --archive <archive> --prepared <archive>/prepared-01 --target-env <archive>/runtime/target-local.env --report <archive>/history-simulation.json`
   simule les associations. Les dossiers supprimés dans DN à la demande de
   l’usager restent dans l’archive et sont exclus des écrans et des données PE.
   Les dossiers acceptés expirés conservent leur décision historique, avec le
   motif d’archivage. Les suppressions sans contenu récupérable sont inventoriées.
   La sélection `--source-policy accepted` est appliquée par défaut et est la
   seule autorisée : les autres statuts DN restent archivés, sans enregistrement
   applicatif ni déclaration PE.
   Reprendre avec `--apply` et un nouveau rapport
   pour importer. Les dossiers sans déclarant restent dans
   `ExternalDeclarationRecord` ; aucun compte fictif n'est créé. Cette sélection
   de l'historique ne limite pas les futurs dépôts : les deux formats Réunion
   sont ouverts aux 244 préleveurs par l'étape `enable-local-formats.js`
   décrite ci-dessous, indépendamment du statut de leurs anciens dossiers.
8. `verify-history.js --archive <archive> --prepared <archive>/prepared-01 --target-env <archive>/runtime/target-local.env --report <archive>/history-verification.json`
   relit les objets S3 et contrôle les empreintes, associations, complétude,
   nombres de valeurs, bornes temporelles, sommes décimales exactes et cinq
   échantillons répartis par série (valeur, dates, unité, remarque, provenance).
   Rejouer l'import avec les mêmes sources et un rapport neuf. Les identités
   restent stables et la provenance historique DN est conservée. Les lignes
   valides et rapprochées d'un fichier partiellement incorrect sont reprises
   selon le fonctionnement existant de PE. Les données non rapprochées et les
   anomalies restent identifiées dans les rapports et le registre local.
   Aucun parcours d'instruction supplémentaire n'est ajouté.
9. Après import du référentiel, `prepare-local.js --output <archive>/runtime --credentials`
   crée le compte de service local et ses périmètres sans afficher son secret.
   Lancer les processus avec `node --env-file=<fichier-privé> ...`. Pour le front
   HTTP local, utiliser `next dev --webpack --hostname 127.0.0.1 --port 3300`
   (cookies de développement), pas le serveur standalone de production.
   NextAuth utilise `/auth/nextauth` ; Crisp, Matomo et Sentry sont désactivés.

Les archives et rapports contiennent des données personnelles : dossiers 0700,
fichiers 0600, hors Git. Les scripts de capture exigent un dossier sous
`~/.local/share/preservonsleau/imports/`. Les imports historiques ne constituent
ni une validation de décommissionnement ni une autorisation de déploiement.

Les déclarations `reunion:DN:*` se rejouent avec `import-history.js` et la dernière
préparation revue. Le rejeu générique de l'interface est refusé pour ces dossiers :
il relirait les fichiers originaux et perdrait les corrections de rattachement,
de période ou de cellules documentées dans la préparation. Les nouveaux dépôts
PE conservent leur rejeu habituel.

### Démarrer la recette locale

Après installation des dépendances, préparation des configurations privées,
restauration locale et création du compte de service de l'étape 9, lancer les
trois processus dans des terminaux séparés. Définir dans chacun
`reunion_runtime="$HOME/.local/share/preservonsleau/imports/reunion-local-20261025/runtime"`
et se placer à la racine du dépôt indiqué.

API :

```sh
API_BIND_HOST=127.0.0.1 node --env-file="$reunion_runtime/api-local.env" api.js
```

Orchestrateur :

```sh
npm run build
BIND_HOST=127.0.0.1 SCHEDULER_ENABLED=false WORKER_JOBS=process-declaration \
  node --env-file="$reunion_runtime/orchestration-local.env" dist/index.js
```

Front :

```sh
npm run prepare-maplibre
npx --no-install react-dsfr update-icons
node --env-file="$reunion_runtime/front-local.env" node_modules/next/dist/bin/next \
  dev --webpack --hostname 127.0.0.1 --port 3300
```

Le front est accessible sur `http://127.0.0.1:3300`, l'API sur le port 5500
et l'orchestrateur sur le port 5501. Les liens de connexion arrivent uniquement
dans Mailpit, consultable sur `http://127.0.0.1:8026`. Ne pas démarrer le worker
API général pour cette recette. Le parcours de déclaration existant est
conservé ; aucun écran d'instruction ou d'affectation supplémentaire n'est requis.
La vérification locale, le déploiement et le décommissionnement restent trois
étapes distinctes.

### Formats des futurs dépôts

La décision de reprise est de proposer les **deux formats Réunion aux 244
préleveurs** du référentiel validé, même si leurs dossiers historiques ne sont
pas acceptés. L'archivage d'un dossier ne supprime pas l'accès aux futurs dépôts.

Après les imports historiques, lancer depuis la racine de l'API :

```sh
reunion_archive="$HOME/.local/share/preservonsleau/imports/reunion-local-20261025"
node scripts/reunion/enable-local-formats.js --archive "$reunion_archive" \
  --target-env "$reunion_archive/runtime/target-local.env" --effective-date 2026-10-25 \
  --report "$reunion_archive/formats-simulation.json"
```

Le script vérifie les
244 identités exactes du manifeste. Reprendre avec `--apply` et un rapport neuf,
puis rejouer : 488 liens actifs sont attendus, sans doublon ni modification
des autres formats ou droits, et le rejeu doit annoncer zéro changement.
La cible locale reste celle utilisée par défaut. Une reprise sur testing utilise
les gardes décrits ci-dessous ; production reste refusée.

### Reprise sur testing après recette locale

Déployer les migrations API avant l'import historique. Conserver les décisions
de la préparation validée : dossiers acceptés uniquement, dossiers supprimés à
la demande des usagers et autres statuts en archive, identités non résolues sans
attribution. Les scripts n'envoient aucun courriel et ne démarrent aucun worker.

L'environnement cible doit conserver l'URL PostgreSQL native de testing avec
`sslmode=verify-full` et son chemin de CA runtime. `--tunnel-port` change seulement
le transport local : l'identité native, la CA et l'identité SQL connectée restent
contrôlées. Le référentiel atteste `testing-documents` ; les historiques attestent
séparément `testing-declarations`, dans la région fr-par avec versioning activé.

1. Sauvegarder testing et vérifier une restauration isolée avant les migrations
   et l'import. Contrôler la capacité disque pour les valeurs, index et WAL.
2. Exécuter le référentiel avec `--target testing --tunnel-port <port>` et
   `--skip-agents`, puis synchroniser les droits avec le registre ODS validé.
3. Simuler chaque préparation historique immuable avec `import-history.js`,
   `--target testing --tunnel-port <port>` et un rapport privé neuf hors Git.
4. Appliquer avec les mêmes arguments, plus `--apply`,
   `--against-report <simulation.json>`, `--confirm-target <confirmation>`
   (valeur `attestation.confirmation` de la simulation) et
   `--backup-evidence <preuve.json>`. La preuve suit le contrat des commandes
   `access-apply` : sauvegarde de la même cible, empreinte vérifiée et restauration
   réconciliée. L'état courant et les sources doivent encore correspondre à la
   simulation ; sinon, refaire une simulation avant toute écriture.
5. Vérifier chaque préparation avec `verify-history.js` et les mêmes options de
   cible. Refaire une simulation puis une application de rejeu : aucun nouveau
   dossier ni aucune mise à jour ne sont attendus.
6. Exécuter `enable-local-formats.js` avec `--target testing`, les mêmes options
   de transport, la date d'effet validée et une simulation neuve. L'application
   exige également simulation, confirmation et preuve de sauvegarde. Rejouer
   pour vérifier les 488 liens et zéro ajout, sans modification des autres droits.

Les rapports incluent une empreinte liant cible, source et plan. Ne pas réutiliser
les rapports de recette locale comme autorisation d'application sur testing.

### Limites de lecture des données natives

La lecture brute `GET /series/:seriesId/values` accepte au plus 50 000 valeurs
natives par demande. Au-delà, elle refuse la lecture et invite à réduire la
période ou à utiliser les valeurs paginées du détail de déclaration.
Les exports vérifient en SQL, avec leurs filtres et droits habituels, qu'ils
ne dépassent pas 100 000 valeurs natives avant de charger les lignes et de
construire le classeur. Un dépassement demande de réduire la période ou le
périmètre. Ces limites ne changent pas les lectures et exports purement legacy.

## Appliquer le registre des accès ODS

L’étape d’accès s’exécute **après** l’import du référentiel. Elle possède sa
propre simulation transactionnelle, son application et sa vérification. Elle
est rejouable directement sur une cible où les déclarants et la zone Réunion
existent déjà. Elle ne migre aucun point, exploitation, document ou volume.

Conserver l’ODS original et son SHA-256 dans un dossier privé durable hors Git,
avec le mapping, les sauvegardes et les rapports (`0700`/`0600`). Python 3
(bibliothèque standard) lit l’ODS ; aucun fichier Excel converti n’est requis.
Les rapports doivent avoir des chemins neufs : les sources et anciennes preuves
ne sont jamais écrasées. Ne pas utiliser `/tmp` comme stockage de référence.

```sh
access_dir=/chemin/prive/acces-reunion
npm run migrate:reunion -- access-prepare \
  --access-file "$access_dir/gestion_acces_prelevements_deau.ods" \
  --effective-date 2026-10-05 --report "$access_dir/source.json"
```

La préparation lit `liste_brute` et `Détail droits agent lecture seule`.
Les colonnes « rôle Partageons l’eau » et « Détail » priment sur le profil
historique ; « ACCES A SUPPRIMER » et « accès supprimé » ferment les droits
Réunion. La suppression des anciens comptes est définie par la liste
`retireAccounts` ci-dessous. Les dates de fermeture renseignées sont
conservées ; `--effective-date`, identique à chaque rejeu, remplace uniquement
les dates absentes et fixe les retraits demandés. Le territoire manquant dans
une liste exclusivement réunionnaise et les identités incomplètes apparaissent
dans les avertissements. Une identité absente n’est pas déduite de l’email.

Les 26 permissions de lecture sont obtenues par correspondance des libellés
avec le catalogue applicatif et leurs dépendances sont contrôlées. Elles
incluent les exports décrits dans l’ODS ; le profil générique de lecture ne les
remplace pas. Les agents en écriture reçoivent les permissions du catalogue.
Le pouvoir d’administrer les agents est un choix distinct dans le mapping.

Le mapping privé doit contenir l’empreinte `sourceHash` de la préparation et
des identifiants source stables, jamais les UUID propres à testing :

```json
{
  "version": 1,
  "sourceHash": "<empreinte-de-source.json>",
  "writersAreZoneAdmins": true,
  "preserveGlobalAdmins": true,
  "declarants": [
    {"structure": "<structure exacte ODS>", "sourceId": "reunion:DEP-974:declarant:<id source>"}
  ]
}
```

Chaque adresse marquée déclarant rejoint le compte de sa structure comme
adresse principale si elle est absente, sinon comme alias. Le mapping de
structure doit être justifié par la source de migration. Les contacts existants
restent conservés. Une ancienne adresse d’agent ne peut être transférée que si
le compte est limité à Réunion et sans dépendance métier ; son identité est
conservée sauf retrait explicite dans `retireAccounts`. Les autres rôles, comptes supprimés, réservations
d’emails et identités ambiguës bloquent la transaction. Avec
`preserveGlobalAdmins`, un administrateur global déjà présent correspondant à
une ligne en écriture est signalé et conservé ; cette option ne crée ni ne
promeut aucun administrateur global. Un administrateur global déclaré en
lecture seule reste un conflit à résoudre.

### Supprimer les anciens comptes

Après autorisation de suppression, ajouter `retireAccounts` au mapping privé.
Cette liste désigne précisément les identités importées à supprimer, par
`Instructor.sourceId` stable, avec leur ancien email et le motif :

```json
{
  "retireAccounts": [
    {
      "sourceId": "reunion:DEP-974:agent:<identifiant source>",
      "email": "ancien-agent@example.test",
      "reason": "REPLACED"
    }
  ]
}
```

Les motifs sont `REPLACED` (adresse transférée au compte déclarant), `CLOSED`
(retrait du registre) et `ABSENT_FROM_REGISTER` (ancien agent absent du registre).
Conserver les preuves du rapprochement avec le manifeste historique et le
registre. Ne pas sélectionner des comptes à supprimer par leur seule zone,
leur domaine email ou leur nom. Les comptes actifs du registre, administrateurs
globaux, déclarants, accès à d’autres zones et dépendances métier bloquent leur
suppression. Le transfert au déclarant est vérifié avant de retirer un compte
remplacé.

La même séquence simulation/application/vérification supprime physiquement les
comptes listés et leurs données d’authentification, droits de zone et activité
mensuelle liée au compte. Les audits sont conservés. La liste, les dépendances
et leur état sont liés à la simulation ; une dérive annule la transaction.
Une identité déjà supprimée ne provoque ni nouvelle suppression ni nouvel audit
au rejeu. Conserver ce mapping complété pour rejouer la même opération en prod.

La cible `local` exige APP_ENV=reunion-local et exactement la base isolée
127.0.0.1:5433/pe_reunion avec le rôle pe_reunion, sans tunnel ni paramètre URL.
Les mêmes simulations, preuves de sauvegarde et vérifications sont requises.

Pour une cible distante, le fichier cible conserve la `DATABASE_URL` native attendue par
`scripts/network/{testing,prod}-database-target.js`, avec `sslmode=verify-full`
et `sslrootcert=/usr/local/share/ca-certificates/scw-postgres-ca.crt`.
Pour testing et prod, le transport emprunte un tunnel local déjà ouvert ; le certificat de la cible
est vérifié via `deploy/certs/<cible>/postgres-ca.pem`. L’identité SQL est
contrôlée avant la simulation et à l’intérieur de chaque transaction.

```sh
npm run migrate:reunion -- access-apply \
  --access-file "$access_dir/gestion_acces_prelevements_deau.ods" \
  --effective-date 2026-10-05 --mappings "$access_dir/mappings.json" \
  --target testing --target-env "$access_dir/testing.env" --tunnel-port PORT_LOCAL \
  --report "$access_dir/testing-simulation.json"
# Après examen de la simulation et restauration vérifiée de la sauvegarde :
npm run migrate:reunion -- access-apply \
  --access-file "$access_dir/gestion_acces_prelevements_deau.ods" \
  --effective-date 2026-10-05 --mappings "$access_dir/mappings.json" \
  --target testing --target-env "$access_dir/testing.env" --tunnel-port PORT_LOCAL \
  --apply --against-report "$access_dir/testing-simulation.json" \
  --backup-evidence "$access_dir/testing-backup.json" \
  --report "$access_dir/testing-application.json"
npm run migrate:reunion -- access-verify \
  --access-file "$access_dir/gestion_acces_prelevements_deau.ods" \
  --effective-date 2026-10-05 --mappings "$access_dir/mappings.json" \
  --target testing --target-env "$access_dir/testing.env" --tunnel-port PORT_LOCAL \
  --against-report "$access_dir/testing-application.json" \
  --report "$access_dir/testing-verification.json"
```

La preuve de sauvegarde contient `target`, `backupFile`, `backup.sha256` et
`restore: {success: true, matchesPreflight: true}`. Le SHA-256 du dump est
recalculé avant application. Un état privé des comptes et droits est aussi
conservé dans le rapport `.before.json`. Toute dérive de la source, du mapping,
de la cible ou des comptes depuis la simulation bloque l’application entière.
Les sessions des comptes modifiés sont invalidées ; aucun email n’est envoyé.

Refaire simulation, application et vérification avec des rapports neufs pour
démontrer le rejeu : `changes` doit être zéro et aucun audit ne doit être créé.
Pour la production, conserver le même ODS, mapping et date, remplacer la cible
et sa configuration par `prod`, puis produire une sauvegarde restaurée et une
simulation **production** neuves. Un rapport testing ne peut pas autoriser une
écriture production. La livraison du référentiel Mongo/S3 reste une étape
distincte ; ne pas la relancer après le registre d’accès avec les anciens rôles
Mongo, qui ne représentent plus les droits validés par l’ODS.

## Prérequis et protection des fichiers

- Node.js 24, `npm ci` et Docker/Compose pour la répétition locale.
- Un backup Mongo figé et identifié, restauré sur une source accessible en
  lecture. Le Compose fournit la version Mongo compatible ; ne pas modifier
  la base source pour préparer la migration.
- Un accès en lecture aux documents S3 sources et suffisamment d'espace
  temporaire pour le plus gros document.
- Une version compatible de PE, ses migrations Prisma et les zones de référence
  importées avant le préflight.

Conserver backup, BSON, manifeste, checksum, copies des mappings, configurations
et rapports hors dépôt. Le manifeste contient des données personnelles :
répertoire en `0700`, fichiers en `0600`. Ne pas afficher d'URI avec credentials
ni passer de secret en argument de commande.

Avant d'extraire un backup, vérifier sa provenance et ses chemins. Refuser les
traversées de répertoire, liens et entrées hors du périmètre attendu ; restaurer
uniquement dans un répertoire dédié vide. Ne pas réutiliser une procédure
d'extraction liée à un autre format d'archive.

```sh
migration_dir=/chemin/prive/migration-reunion
install -d -m 700 "$migration_dir"
install -m 600 scripts/reunion/data/usage-map.csv "$migration_dir/usage-map.csv"
install -m 600 scripts/reunion/data/point-overrides.csv "$migration_dir/point-overrides.csv"
install -m 600 scripts/reunion/data/document-exclusions.csv "$migration_dir/document-exclusions.csv"
```

Les trois CSV définissent les correspondances d'usages, les corrections de points
et les exclusions documentaires. Le manifeste lie leur contenu exact et la
version du transformateur par checksum. Les commandes suivantes refusent un
mapping modifié ; une évolution sémantique exige une nouvelle version et une
nouvelle validation.

Préparer séparément un fichier privé `source-s3.env` contenant
`S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` et
`S3_BUCKET_PREFIX`. Utiliser des droits limités à la lecture de la source.
Les objets absents doivent être traités par une exclusion explicite validée,
sans masquer les erreurs de téléchargement.

## Préparer une répétition locale

```sh
docker compose -f scripts/reunion/compose.yaml up -d
install -m 600 scripts/reunion/target-local.env.example "$migration_dir/target-local.env"
```

Attendre les contrôles de santé et la création du bucket local avant de continuer.
Cette pile isole MongoDB, PostgreSQL, MinIO, Redis et Mailpit des services de
développement habituels. Elle ne lance pas l'API, l'orchestrateur ou le front.

Restaurer le backup Mongo validé dans cette pile. Configurer ensuite les commandes
Prisma et d'import des zones pour la même base locale que `target-local.env`,
puis exécuter :

```sh
APP_ENV=reunion-local \
DATABASE_URL='postgresql://pe_reunion:pe_reunion_local_only@127.0.0.1:5433/pe_reunion' \
npm run migrate:prisma
APP_ENV=reunion-local \
DATABASE_URL='postgresql://pe_reunion:pe_reunion_local_only@127.0.0.1:5433/pe_reunion' \
node scripts/import-zones.js
```

Le fichier `--target-env` du migrateur ne configure pas ces deux commandes.
Vérifier leur cible avant exécution.

## Créer le manifeste immuable

```sh
REUNION_MONGO_URL=mongodb://127.0.0.1:27018/reunion_source \
  npm run migrate:reunion -- snapshot \
  --source-mongo-db reunion_source \
  --source-s3-env "$migration_dir/source-s3.env" \
  --backup-id '<identifiant-du-backup-validé>' \
  --usage-map "$migration_dir/usage-map.csv" \
  --point-overrides "$migration_dir/point-overrides.csv" \
  --document-exclusions "$migration_dir/document-exclusions.csv" \
  --manifest "$migration_dir/manifest.jsonl"
```

L'exemple utilise une URI locale sans secret. Pour une source authentifiée,
charger `REUNION_MONGO_URL` depuis une configuration privée sans l'afficher ;
`--source-mongo-uri` est réservé aux URI locales sans secret.

Le snapshot calcule les checksums des documents sources. `--skip-s3` est réservé
au diagnostic : un manifeste ainsi produit ne peut pas être appliqué.
Le manifeste et son compagnon `.sha256` ne doivent pas déjà exister.
Utiliser de nouveaux chemins pour un nouveau backup.

## Préflight, simulation, application et vérification

```sh
npm run migrate:reunion -- preflight \
  --manifest "$migration_dir/manifest.jsonl" \
  --usage-map "$migration_dir/usage-map.csv" \
  --point-overrides "$migration_dir/point-overrides.csv" \
  --document-exclusions "$migration_dir/document-exclusions.csv" \
  --target local --target-env "$migration_dir/target-local.env" \
  --report "$migration_dir/local-preflight.json"

npm run migrate:reunion -- apply \
  --manifest "$migration_dir/manifest.jsonl" \
  --usage-map "$migration_dir/usage-map.csv" \
  --point-overrides "$migration_dir/point-overrides.csv" \
  --document-exclusions "$migration_dir/document-exclusions.csv" \
  --source-s3-env "$migration_dir/source-s3.env" \
  --target local --target-env "$migration_dir/target-local.env" \
  --report "$migration_dir/local-dry-run.json"
```

La seconde commande reste une simulation. Après contrôle et accord explicite,
la reprendre avec un rapport neuf et `--apply --confirm-target local`.

```sh
npm run migrate:reunion -- verify \
  --manifest "$migration_dir/manifest.jsonl" \
  --usage-map "$migration_dir/usage-map.csv" \
  --point-overrides "$migration_dir/point-overrides.csv" \
  --document-exclusions "$migration_dir/document-exclusions.csv" \
  --target local --target-env "$migration_dir/target-local.env" \
  --report "$migration_dir/local-verify.json"
```

Rejouer `apply`, puis `verify`, avec le même manifeste, son checksum et les
mêmes mappings, mais des rapports distincts. Les compteurs de base et S3 doivent
être `unchanged`, sans nouvel audit de permissions.

Les `sourceId` sont stables et les transactions bornées à un agrégat.
La migration ne supprime pas les entités racines absentes d'un snapshot plus
récent. Elle peut retirer les contacts et relations qu'elle gère pour réconcilier
le manifeste. `verify` compare les champs et relations migrés et relit chaque
objet S3 cible pour recalculer sa taille et son SHA-256. `verify --skip-s3`
est refusé.

La commande `all` enchaîne snapshot, préflight, application et vérification.
Elle reprend les options source de `snapshot` et les options cible de
`apply`, avec un chemin de manifeste neuf. Sans `--apply`, elle ne réalise
pas d'écriture cible. Pour démontrer la rejouabilité, conserver ensuite ce
manifeste et relancer `apply` puis `verify`, pas `all`.

## Passage vers testing

Réutiliser le manifeste et son checksum validés localement. Avant toute écriture :

1. vérifier la compatibilité des migrations, de l'API et du front ;
2. préparer un fichier cible privé à partir de `target-testing.env.example`,
   avec la base, le rôle, le point d'accès et le certificat autorisés par la
   révision utilisée ; ne pas copier une ancienne configuration sans contrôle ;
3. vérifier le bucket cible attendu, privé et versionné, et les droits S3 ;
4. disposer d'une sauvegarde PostgreSQL restaurable ;
5. exécuter `preflight` avec `--target testing` et le fichier cible privé ;
6. relire son rapport et obtenir l'accord avant l'application.

Les garde-fous vérifient l'identité PostgreSQL et TLS après connexion, puis la
région et le versioning S3. Les scripts ne créent ni réseau ni tunnel. Une
adresse de transport n'est pas implicitement autorisée : utiliser une révision
compatible avec l'accès réseau disponible, sans contourner les contrôles.

Les commandes sont celles de la répétition locale, en remplaçant la cible et le
fichier d'environnement par ceux de testing. L'application exige
`--apply --confirm-target 'testing:<empreinte-du-préflight>'`.
Cette empreinte lie le manifeste, la base et le bucket attestés.

Après application, lancer `verify`, puis rejouer `apply` et `verify` avec
des rapports neufs. Le code de sortie et les rapports doivent être contrôlés
avant de considérer le transfert comme terminé.

## Fin de session et rétention

Pour arrêter la pile locale en conservant ses données :

```sh
docker compose -f scripts/reunion/compose.yaml down
```

La suppression des volumes est une décision distincte et irréversible ;
elle n'est pas nécessaire pour arrêter la pile. Décider séparément de la
rétention des backups, manifestes, checksums et rapports.

Révoquer les accès temporaires créés pour la migration après validation.
Ne pas révoquer un credential partagé avec l'application. Les configurations
contenant des secrets doivent être conservées ou détruites séparément des preuves.
