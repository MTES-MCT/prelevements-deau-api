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

Après examen de la simulation, `apply --apply --against-report simulation.json` exige les mêmes identités et changements. Une erreur d’exécution sur un objet annule **toute** la transaction et produit un rapport `applied: false, complete: false` ; les cas non rapprochés déjà exclus du manifeste ne constituent pas une erreur d’exécution. Un rejeu conserve les corrections manuelles. Pour les exploitations concurrentes codées, `MULTIPLE_EXPLOITATIONS_ENABLED=true` doit avoir été activé explicitement sur la cible après le rattachement des déclarations historiques.

Pour testing, utiliser `--target testing --target-env .env.testing --tunnel-port PORT_LOCAL` à travers un tunnel déjà ouvert vers PostgreSQL privé. Le script contrôle la cible et vérifie le certificat TLS ; il ne prend pas en charge la production. Les secrets ne passent pas en arguments de commande.

L’import utilise une transaction unique, limitée à 15 minutes par défaut pour couvrir les allers-retours du tunnel. `--transaction-timeout-seconds 900` permet de modifier cette limite (entier de 1 à 1800 secondes). Un dépassement annule toute la transaction, sans import partiel ; le rollback de simulation reste inchangé.

## Reconstruction exceptionnelle sur testing

Préparer un manifeste distinct avec `prepare --rebuild-identities --previous-manifest ancien-manifeste.json --snapshot export-testing.json --manifest nouveau-manifeste.json` et le classeur sélectionné. Cela renouvelle les identités PP/exploitations à regrouper, tout en conservant les ancres des préleveurs et compteurs.

`rebuild --target testing` est une simulation par défaut. Cette opération remplace les PP et exploitations de l’import identifié, jamais un périmètre choisi par sa seule géographie. Elle conserve les comptes, préleveurs, compteurs, flux et index bruts ; seules leurs publications calculées et affectations sont reconstruites. Toute donnée manuelle, document, règle ou dépendance extérieure bloque l’opération.

Avant `--apply`, suspendre les ingestions concernées et disposer d’une sauvegarde privée dont la restauration a été vérifiée. Fournir `--against-report simulation.json --backup-evidence preuve.json` avec le même manifeste, `--activate-at DATE_ISO` historiquement validée et le compte de service. La preuve JSON contient `target: "testing"`, `completed: true`, `restored: true`, `backupSha256`, `restoredAt` et le `scopeStateHash` mesuré sur la restauration via `inspectRebuildScope`. Ce dernier doit correspondre exactement à la simulation et à l’état courant : toute dérive arrête l’opération. Les anciens/nouveaux identifiants figurent dans le rapport privé.

Après application, lancer `recompute-rebuild --target testing --against-report application.json --report recalcul.json --apply` avec le même manifeste et les options de connexion habituelles. Le recalcul est explicite et transactionnel par compteur, sans écraser les données ordinaires. `--resume recalcul.json` reprend les compteurs non terminés ; un compteur commis juste avant une interruption peut être rejoué sans doublon. Vérifier les motifs de blocage et les volumes avant de reprendre les ingestions. Les rapports sont écrits atomiquement et restent privés. Aucune commande de reconstruction ne cible demo ou prod.

Pour compléter l’historique depuis des archives vérifiées, `prepare-meter-archive-replay.js --selection all-validated` prépare tous les flux validés du nouveau manifeste, y compris ceux déjà actifs. Les identifiants de lots intègrent le manifeste reconstruit ; le rejeu reste reprenable sans réutiliser les acquittements d’avant reconstruction. Sans cette option, la sélection reste limitée aux nouveaux flux validés.

## Règles

- Seuls les noms source contenant `CACG` sont rapprochés de Rives (réalimentés). Les autres restent non réalimentés. Après le nom exact, les variantes département/zéros conservent le suffixe complet et exigent une preuve par compteur ou coordonnées ; les références contradictoires restent à vérifier. Un lieu présent chez Rives ne prouve pas, à lui seul, la disponibilité d’une télérelève.
- Identités stables par référence métier, jamais par numéro de ligne ou adresse email. Les doublons ambigus et coordonnées incohérentes sont isolés dans les rapports.
- Les emails importés sont des contacts, pas des identifiants de connexion. Aucune invitation ni notification n’est envoyée.
- Le rejeu conserve les changements manuels. Les corrections ambiguës exigent un mapping explicite, sans fusion automatique.
- Un compteur physique peut desservir plusieurs exploitations. Sa répartition inclut aussi les parts hors périmètre, sans les redistribuer aux exploitations importées.
- Les compteurs sans correspondance complète ne publient pas de volumes. L’import initial n’active aucun flux et ne charge pas l’exemple JSON dans les mesures courantes.
- `--activate-at DATE_ISO --service-account-id UUID` active seulement les rapprochements validés à partir de cette date. Une correction de répartition active exige `--effective-at DATE_ISO` et conserve les anciennes versions. Ne pas antidater une répartition actuelle sans justificatif historique.
- Le connecteur Rives récupère des index bruts. Le calcul et la répartition des volumes sont faits une seule fois par l’API. Une collision avec une consommation non identifiée reste à résoudre ; les autres connecteurs restent inchangés.

Les anciens imports `PAR_2026-2027` ont été remplacés ; leur historique reste disponible dans Git.
