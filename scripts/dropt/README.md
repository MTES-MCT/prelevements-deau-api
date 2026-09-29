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

Pour un nouveau classeur, utiliser `prepare --epidropt-file chemin.xlsx --previous-manifest ancien-manifeste.json --snapshot export-testing.json`. L’export doit être complet et en lecture seule. Les anciennes identités sont conservées même lorsqu’une référence Rives est découverte ; les décisions et les candidats non validés figurent dans `reconciliation`. Le code comptage reste distinct du numéro de série. Son attribution automatique exige un code unique et un propriétaire unique dans toutes les lignes sources correspondantes.

Si `mapping/dataset.json` existe, il sélectionne les sources et paramètres privés du jeu courant : `version: 1`, `files: {epidropt, rives, ...justificatifs}`, `overrides`, `previousManifest`, `snapshot`, `manifest`. Les chemins sont relatifs au dossier `--input` ; aucune dépendance à `/tmp` n’est nécessaire. `--dataset` permet d’en choisir un autre, les options explicites restent prioritaires. Les corrections arbitrées conservent les originaux, les empreintes des lignes et la cellule justificative ; une source modifiée exige une nouvelle revue.

Après examen de la simulation, `apply --apply --against-report simulation.json` exige les mêmes identités et changements. Une erreur d’exécution sur un objet annule **toute** la transaction et produit un rapport `applied: false, complete: false` ; les cas non rapprochés déjà exclus du manifeste ne constituent pas une erreur d’exécution. Un rejeu conserve les corrections manuelles. Pour les exploitations concurrentes codées, `MULTIPLE_EXPLOITATIONS_ENABLED=true` doit avoir été activé explicitement sur la cible après le rattachement des déclarations historiques.

Pour testing, utiliser `--target testing --target-env .env.testing --tunnel-port PORT_LOCAL` à travers un tunnel déjà ouvert vers PostgreSQL privé. Le script contrôle la cible et vérifie le certificat TLS ; il ne prend pas en charge la production. Les secrets ne passent pas en arguments de commande.

L’import utilise une transaction unique, limitée à 15 minutes par défaut pour couvrir les allers-retours du tunnel. `--transaction-timeout-seconds 900` permet de modifier cette limite (entier de 1 à 1800 secondes). Un dépassement annule toute la transaction, sans import partiel ; le rollback de simulation reste inchangé.

## Réappliquer des arbitrages et fusions ciblées sur testing

`review --target testing` simule en une transaction les seules fusions/retraits explicités dans `reviewedConsolidationPlan`, puis l’import complet. Les UUID survivants et les anciens liens vers les PP fusionnés sont conservés. Les documents, règles, réponses de campagne et données manuelles empêchant une fusion la bloquent : aucun effacement implicite.

```sh
npm run import:dropt -- prepare
npm run import:dropt -- review --target testing --target-env .env.testing --tunnel-port PORT_LOCAL --report data/dropt/epidropt-2026/reports/revue-simulation.json
# Après examen et vérification d’une sauvegarde restaurée :
npm run import:dropt -- review --target testing --target-env .env.testing --tunnel-port PORT_LOCAL --apply --against-report data/dropt/epidropt-2026/reports/revue-simulation.json --backup-evidence data/dropt/epidropt-2026/reports/preuve-sauvegarde.json
```

La preuve contient `target: "testing"`, `backup.sha256`, `restore: {success: true, matchesPreflight: true}` et `reviewedStateHash`, obtenu sur la copie restaurée via `inspectReviewedApplication`. L’état doit correspondre à la simulation et à la cible. Les copies restaurées ne sont utilisables que par le lanceur interne protégé ; aucune cible demo/prod n’est acceptée.

Sur autorisation explicite, `retireEmptyCampaignResponseIds` peut désigner les inscriptions entièrement vierges de la campagne importée à supprimer avec une exploitation retirée. Le script verrouille et revérifie leur état ; tout brouillon, envoi ou changement de périmètre bloque la suppression. Les autres réponses sont conservées et le retrait est journalisé pour le rejeu.

Un usage modifié dans la source n’est corrigé que si sa valeur en base correspond encore au précédent import, sans compteur, déclaration ou usage secondaire dépendant. Les corrections manuelles sont conservées et les changements qui nécessiteraient un recalcul restent bloqués.

Sans dates d’effet fiables, `resetMeterIds` peut lister les compteurs dont les dérivés doivent être supprimés, **sur autorisation explicite**. Le rapport chiffre ces suppressions ; les index, révisions et ingestions bruts restent intacts. Les flux concernés restent désactivés, sans recalcul ni rétroactivité. Le journal empêche une nouvelle suppression au rejeu ; toute nouvelle activation/publication exige une nouvelle revue. Les autres volumes sont conservés. Les liens du collecteur déjà habilité sont ajoutés aux nouvelles exploitations, sans créer de compte ou de campagne.

## Activer les connexions des préleveurs importés

Après l’import du référentiel, `enable-logins` permet d’utiliser l’email source pour recevoir le lien de connexion habituel. Cette opération distincte ne modifie que les identifiants de connexion : aucun point, exploitation, compteur, volume, contact ou réglage de notification n’est réimporté. Aucun email ni mot de passe n’est envoyé ou généré.

```sh
npm run import:dropt -- enable-logins --target local --target-env .env.local --manifest chemin/manifeste.json --login-scope non-realimente --report data/dropt/epidropt-2026/reports/simulation-connexions.json
# Examiner le rapport privé avant l’application, avec le même manifeste et périmètre.
npm run import:dropt -- enable-logins --target local --target-env .env.local --manifest chemin/manifeste.json --login-scope non-realimente --apply --against-report data/dropt/epidropt-2026/reports/simulation-connexions.json
```

Pour testing, remplacer les options de connexion comme indiqué plus haut. `--login-scope non-realimente` sélectionne les préleveurs ayant une exploitation importée active sur un PP sans `CACG` ; `all` inclut aussi le réalimenté et exige une autorisation portant sur cet ensemble. Utiliser le manifeste effectivement appliqué, pas un ancien fichier par défaut.

Sur autorisation explicite, ajouter `--allow-email-aliases` aux **deux** commandes pour permettre la connexion avec toutes les adresses source d’un même préleveur. La première adresse normalisée du manifeste (tri alphabétique stable de l’import) devient l’adresse principale ; les suivantes deviennent des alias du même compte, sans créer de préleveur supplémentaire. Toutes doivent être confirmées et libres : un conflit sur une seule adresse bloque le compte entier. Un alias retiré manuellement ne sera pas rétabli au rejeu.

Seuls les comptes vierges, actifs, avec un email source unique confirmé dans les contacts importés (ou des alias explicitement autorisés) sont activés. Les emails partagés, déjà attribués/réservés, les identités non confirmées et les sources ambiguës restent bloqués et détaillés dans le rapport. Les comptes déjà configurés et les retraits manuels d’email sont préservés. Les cas bloqués sont exclus, les autres peuvent être appliqués après examen de la simulation. Toute dérive du plan depuis cette simulation ou erreur SQL annule toute l’application. Le rejeu exige une nouvelle simulation et ne réactive pas les comptes modifiés manuellement.

## Préparer la campagne de collecte

Après l’import du référentiel et les migrations de campagne, `seed-campaign` crée le collecteur et ses droits sur **toutes** les exploitations du manifeste, puis une campagne **brouillon sans dates** pour les seules exploitations non réalimentées. Les exploitations sans compteur et les usages non agricoles sont inclus. Aucun compteur, répartition, index, connexion de préleveur ou volume n’est modifié ; aucun email n’est envoyé.

La configuration JSON privée doit être dans `data/`, exclue du suivi Git du sous-dépôt : `name` (facultatif), `createdByUserId` (ou option `--actor-user-id`) et `collecteur: {socialReason, firstName, lastName, email, phoneNumber}`. Les coordonnées réelles ne doivent jamais apparaître dans ce README, les fixtures ou le dépôt public. L’administrateur doit déjà exister et être actif sur la cible. Ne pas lui substituer un compte synthétique. La configuration locale préparée se trouve dans `mapping/campaign-index-needs-2026-2027.json`.

```sh
npm run import:dropt -- seed-campaign --target local --target-env .env.local --manifest chemin/manifeste-applique.json --campaign-config data/dropt/epidropt-2026/mapping/campaign-index-needs-2026-2027.json --actor-user-id UUID_ADMIN_EXISTANT --report data/dropt/epidropt-2026/reports/simulation-campagne.json
# Examiner les populations et changements, puis répéter avec les mêmes arguments :
# --apply --against-report data/dropt/epidropt-2026/reports/simulation-campagne.json
```

Pour testing, utiliser les options de connexion privée décrites plus haut. Seules les cibles local et testing sont autorisées. La simulation transactionnelle ne conserve rien ; l’application exige les mêmes manifeste, configuration, cible et état. Tout conflit d’identité/email, exploitation absente ou réaffectée, ou dérive depuis la simulation annule l’ensemble. Les identités source du collecteur et de la campagne sont stables. Le rejeu préserve les identifiants de connexion, coordonnées, réponses, nom et dates modifiés manuellement, ainsi que les autres droits du collecteur ; une population modifiée exige une vérification manuelle, jamais un remplacement des réponses. Une fois les dates choisies, le lancement reste une action explicite dans l’administration.

## Préremplir les index et les besoins d’une campagne existante

Ces commandes distinctes ne rejouent **pas** l’import du référentiel. Elles ne créent aucun participant, compteur, index publié, déclaration ou notification. Les propositions sont conservées séparément des réponses et ne comptent pas comme des brouillons. La migration `20260929160000_collection_response_prefill` doit être appliquée avant les commandes connectées à la base.

Le classeur attendu est `BASE GLOBALE`, avec les 25 colonnes du fichier d’index/besoins. `prepare-prefill` ne se connecte à aucune base : il contrôle la structure, les doublons et les valeurs, puis produit un rapport privé. Le fichier source est lu sans modification. Les rapports doivent être de **nouveaux fichiers JSON hors de tout dépôt Git** ; aucun rapport existant n’est écrasé.

```sh
npm run import:dropt -- prepare-prefill --prefill-file /chemin/prive/besoins.xlsx --report /chemin/prive/lecture.json
npm run import:dropt -- prefill-campaign --prefill-file /chemin/prive/besoins.xlsx --target local --target-env .env.local --campaign-id UUID_CAMPAGNE --actor-user-id UUID_ADMIN --report /chemin/prive/simulation.json
# Examiner les correspondances et exclusions avant application explicite :
npm run import:dropt -- prefill-campaign --prefill-file /chemin/prive/besoins.xlsx --target local --target-env .env.local --campaign-id UUID_CAMPAGNE --actor-user-id UUID_ADMIN --apply --against-report /chemin/prive/simulation.json --report /chemin/prive/application.json
npm run import:dropt -- verify-prefill-campaign --prefill-file /chemin/prive/besoins.xlsx --target local --target-env .env.local --campaign-id UUID_CAMPAGNE --actor-user-id UUID_ADMIN --against-report /chemin/prive/application.json --report /chemin/prive/verification.json
```

Pour testing, remplacer les options de connexion par `--target testing --target-env .env.testing --tunnel-port PORT_LOCAL`, comme pour les autres commandes. Pour prod, seules `prefill-campaign` et `verify-prefill-campaign` acceptent `--target prod`, avec `--target-env FICHIER_PRIVE` et `--tunnel-port PORT_LOCAL` obligatoires, sur un tunnel déjà ouvert. Le fichier doit contenir l’URL PostgreSQL de déploiement prod : endpoint, base, utilisateur, `sslmode=verify-full` et certificat attendus par `scripts/network/prod-database-target.js`. Le certificat local `deploy/certs/prod/postgres-ca.pem` est ensuite utilisé avec contrôle d’identité TLS ; l’identité de la base connectée est revérifiée avant toute opération. Une simulation prod distincte est obligatoire avant `--apply` : un rapport local/testing n’est jamais réutilisable sur prod. Demo et toutes les autres opérations Dropt sur prod restent interdites.

Aucun manifeste de l’ancien import n’est requis : le rapprochement utilise exactement le code point OUGC (nom ou alias déjà enregistré), le SIRET et le code comptage parmi les participants actuels. Aucune correspondance approximative. Le numéro de série doit désigner un compteur déjà rattaché ; à défaut de série exploitable, un seul rattachement actuel doit exister.

Règles de préparation :

- Besoins étiage 2027 : volume D, débit E, surface F, usage W. Hors étiage 2027–2028 : volume **L + N + Q**, débit I, surface H, usage X. Les trois volumes doivent être numériques explicites ; zéro est valide, une cellule vide n’est pas zéro. Aucun recours au total G. Addition exacte puis arrondi à quatre décimales ; les décimaux sont transmis en chaînes.
- Un second usage réel en Y exclut le bloc de besoins hors étiage entier. `Sans usage` reste une information d’absence d’autorisation, pas une consommation nulle ou une interdiction de besoin futur. Les cultures et informations historiques d’usage/surface ne sont pas inventées.
- Seul V peut proposer l’index physique du 31 octobre 2025, sans pondération par U. Zéros ambigus, valeurs négatives/annotées et conflits de compteur sont exclus. Les observations existantes restent prioritaires ; les désaccords figurent au rapport. Les index contradictoires sont recherchés avant exclusion des zéros et après rapprochement des compteurs.
- Des lignes identiques ne dupliquent jamais les volumes. Plusieurs propositions divergentes pour une même réponse restent exclues. Les propositions et leur provenance sont privées, sans exposition des lignes source aux collecteurs.
- Toute réponse déjà commencée, soumise ou déjà préremplie différemment est préservée. Le rejeu du même fichier est sans effet. Une modification de source ou d’état depuis la simulation empêche toute application : refaire la simulation, avec un nouveau rapport.

L’application verrouille la campagne comme les sauvegardes manuelles et recontrôle toutes les conditions en une transaction. Elle ne modifie que `prefillData`/`prefillMetadata` (et la date technique de modification), jamais les droits, secrets, répartitions, brouillons, révisions ou données soumises. `verify-prefill-campaign` compare les propositions enregistrées au rapport d’application sans remplacer les saisies intervenues depuis.

## Reconstruction exceptionnelle sur testing

Préparer un manifeste distinct avec `prepare --rebuild-identities --previous-manifest ancien-manifeste.json --snapshot export-testing.json --manifest nouveau-manifeste.json` et le classeur sélectionné. Cela renouvelle les identités PP/exploitations à regrouper, tout en conservant les ancres des préleveurs et compteurs.

`rebuild --target testing` est une simulation par défaut. Cette opération remplace les PP et exploitations de l’import identifié, jamais un périmètre choisi par sa seule géographie. Elle conserve les comptes, préleveurs, compteurs, flux et index bruts ; seules leurs publications calculées et affectations sont reconstruites. Toute donnée manuelle, document, règle ou dépendance extérieure bloque l’opération.

Avant `--apply`, suspendre les ingestions concernées et disposer d’une sauvegarde privée dont la restauration a été vérifiée. Fournir `--against-report simulation.json --backup-evidence preuve.json` avec le même manifeste, `--activate-at DATE_ISO` historiquement validée et le compte de service. La preuve JSON contient `target: "testing"`, `completed: true`, `restored: true`, `backupSha256`, `restoredAt` et le `scopeStateHash` mesuré sur la restauration via `inspectRebuildScope`. Ce dernier doit correspondre exactement à la simulation et à l’état courant : toute dérive arrête l’opération. Les anciens/nouveaux identifiants figurent dans le rapport privé.

Après application, lancer `recompute-rebuild --target testing --against-report application.json --report recalcul.json --apply` avec le même manifeste et les options de connexion habituelles. Le recalcul est explicite et transactionnel par compteur, sans écraser les données ordinaires. `--resume recalcul.json` reprend les compteurs non terminés ; un compteur commis juste avant une interruption peut être rejoué sans doublon. Vérifier les motifs de blocage et les volumes avant de reprendre les ingestions. Les rapports sont écrits atomiquement et restent privés. Aucune commande de reconstruction ne cible demo ou prod.

Pour compléter l’historique depuis des archives vérifiées, `prepare-meter-archive-replay.js --selection all-validated` prépare tous les flux validés du nouveau manifeste, y compris ceux déjà actifs. Les identifiants de lots intègrent le manifeste reconstruit ; le rejeu reste reprenable sans réutiliser les acquittements d’avant reconstruction. Sans cette option, la sélection reste limitée aux nouveaux flux validés.

## Règles

- Seuls les noms source contenant `CACG` sont rapprochés de Rives (réalimentés). Les autres restent non réalimentés. Après le nom exact, les variantes département/zéros conservent le suffixe complet et exigent une preuve par compteur ou coordonnées ; les références contradictoires restent à vérifier. Un lieu présent chez Rives ne prouve pas, à lui seul, la disponibilité d’une télérelève.
- Identités stables par référence métier, jamais par numéro de ligne ou adresse email. Les doublons ambigus et coordonnées incohérentes sont isolés dans les rapports.
- En l’absence d’email/SIRET dans une ligne d’exploitation (y compris la mention explicite « pas de mail »), le commentaire peut retrouver un préleveur par raison sociale source complète et unique. Les homonymes, identités incomplètes et correspondances approximatives restent exclus ; une adresse invalide ou inconnue n’est pas assimilée à une absence d’email.
- Le SAGE est choisi parmi les seuls périmètres intersectant les coordonnées, selon le milieu du PP et le type de ressource gérée configuré dans PE (surface, souterraine, transition, mixte). Un SAGE spécialisé compatible est prioritaire sur un SAGE mixte. Plusieurs spécialisés compatibles, ou plusieurs mixtes sans spécialisé, bloquent la décision ; aucun SAGE n’est choisi hors de sa géographie. Le rejeu réévalue aussi les PP dont les coordonnées n’ont pas changé, sans altérer les coordonnées corrigées manuellement.
- L’import conserve les emails comme contacts ; l’activation des connexions est explicite via `enable-logins` et ses contrôles ci-dessus. Aucune invitation ni notification n’est envoyée.
- Le rejeu conserve les changements manuels. Les corrections ambiguës exigent un mapping explicite, sans fusion automatique.
- Un compteur physique peut desservir plusieurs exploitations. Sa répartition inclut aussi les parts hors périmètre, sans les redistribuer aux exploitations importées.
- Les compteurs sans correspondance complète ne publient pas de volumes. L’import initial n’active aucun flux et ne charge pas l’exemple JSON dans les mesures courantes.
- `--activate-at DATE_ISO --service-account-id UUID` active seulement les rapprochements validés à partir de cette date. Une correction de répartition active exige `--effective-at DATE_ISO` et conserve les anciennes versions. Ne pas antidater une répartition actuelle sans justificatif historique.
- Le connecteur Rives récupère des index bruts. Le calcul et la répartition des volumes sont faits une seule fois par l’API. Une collision avec une consommation non identifiée reste à résoudre ; les autres connecteurs restent inchangés.

Les anciens imports `PAR_2026-2027` ont été remplacés ; leur historique reste disponible dans Git.
