# Réparation du chevauchement Tech-Albères / Roussillon

Ce script corrige exclusivement les liens territoriaux des points actifs situés dans l’intersection géographique des deux SAGE suivants :

| Milieu du point | SAGE conservé ou ajouté | Code |
| --- | --- | --- |
| `SUPERFICIELLE` | Tech-Albères | `sage-SAGE06030` |
| `SOUTERRAIN` | Nappes plio-quaternaires de la plaine du Roussillon | `sage-SAGE06028` |

Il réutilise le sélecteur métier commun et ne modifie pas les paramètres `managedResourceType`. Il conserve intégralement les autres liens territoriaux, les points, les exploitations, les déclarations et les rattachements des utilisateurs (`DeclarantZone`). La disparition du lien d’un PP vers un SAGE ne supprime donc pas automatiquement le territoire de ses déclarants ou collecteurs.

## Périmètre et exceptions

L’inventaire comprend les points géométriquement dans les deux SAGE ainsi que les points déjà rattachés à au moins l’un d’eux. Les points supprimés, sans coordonnées, hors intersection ou dont le milieu est `TRANSITION`/indéterminé sont signalés sans modification. Un troisième SAGE déjà rattaché au point est également conservé, même s’il est hors géométrie ou incompatible. Un troisième candidat géographique compatible, ou une configuration incompatible du SAGE cible, produit une exception à examiner.

Seuls les liens de la paire sont ajoutés ou retirés. Un lien cible déjà présent conserve son UUID et sa date. Les nouveaux liens ont un UUID déterministe et la date de préparation de la revue ; le reçu conserve les UUID et horodatages à la microseconde de tous les liens avant et après.

## Revue privée, puis application explicite

Depuis la racine du dépôt, avec la version Node de `.nvmrc`. Le fichier d’environnement est privé ; sa `DATABASE_URL` doit conserver l’identité native de la cible et le TLS `verify-full`. Le tunnel local ne réécrit que la destination TCP, après validation de la cible. Aucun secret n’est passé en argument ni écrit dans les rapports.

Conserver les fichiers dans un dossier privé **hors de tout dépôt Git**, par exemple dans `$HOME/.local/share/preservonsleau/imports/sage-overlap-20261008/`. Les commandes ci-dessous utilisent des chemins d’exemple à adapter. Le tunnel SSH doit être ouvert séparément selon la procédure réseau du projet.

```sh
node scripts/sage-overlap/repair.js review \
  --target testing \
  --target-env /chemin/prive/testing.env \
  --tunnel-port 55440 \
  --report /chemin/prive/review-testing.json
```

`review` est la commande par défaut. Elle utilise une transaction en lecture seule et produit l’inventaire, ses empreintes, le delta avant/après et les exceptions. Relire `summary` et les entrées `CHANGE`/`EXCEPTION` avant l’application. Les rapports contiennent des identifiants techniques, pas de noms ni de coordonnées en clair.

Avant l’application, disposer d’une sauvegarde de cette cible, restaurée dans un environnement isolé. La preuve privée doit avoir cette forme :

```json
{
  "target": "testing",
  "backupFile": "/chemin/prive/backup.dump",
  "backupSha256": "SHA256_DU_FICHIER_DUMP",
  "stateHash": "EMPREINTE_DE_L_INVENTAIRE_SUR_LA_BASE_RESTAUREE",
  "restoreMatched": true,
  "restoredAt": "2026-10-08T12:00:00.000Z"
}
```

`stateHash` est l’empreinte calculée sur la base fraîchement restaurée avec `readState`/`fingerprint` du module `lib/repair.js` ; elle doit correspondre à celle du rapport revu. Ne pas la recopier simplement du rapport sans vérification de la restauration. La CLI vérifie l’empreinte du fichier de sauvegarde et cette correspondance.

```sh
node scripts/sage-overlap/repair.js apply \
  --target testing \
  --target-env /chemin/prive/testing.env \
  --tunnel-port 55440 \
  --against-report /chemin/prive/review-testing.json \
  --backup-proof /chemin/prive/backup-proof-testing.json \
  --receipt /chemin/prive/apply-testing.json
```

La CLI refuse d’écraser un rapport ou reçu existant. Pour la production, préparer sa propre sauvegarde, preuve et revue avec `--target prod` et un tunnel/configuration production explicites. Un rapport testing est refusé sur prod.

## Atomicité, contrôle de dérive et rejeu

L’application verrouille brièvement `Zone`, `PointPrelevement` et `PointPrelevementZone` en `SHARE ROW EXCLUSIVE` : les lectures ordinaires restent possibles, les écritures concurrentes sur ces tables attendent. Le délai d’acquisition est limité à cinq secondes ; chaque requête est limitée à deux minutes. Une indisponibilité du verrou interrompt la réparation sans changement.

Les empreintes incluent les géométries et paramètres de tous les SAGE, les coordonnées, milieux, dates de modification/suppression et tous les liens des points inventoriés. Elles détectent aussi de nouveaux candidats. Une dérive impose une nouvelle revue ; le script ne recalcule pas silencieusement un autre plan. Le hash du code du script et du sélecteur commun lie également la revue à l’implémentation utilisée.

Après le delta, une relecture vérifie l’état complet attendu. Le reçu `PREPARED` est écrit et synchronisé sur disque **avant le COMMIT**. Une erreur de persistance annule la transaction. Après le commit, le reçu est finalisé `COMMITTED`. Le rejeu d’un même rapport, si l’état après est toujours identique, produit `summary.changed: 0`. Une nouvelle revue de l’état réparé produit également zéro changement.

Si le processus s’arrête après l’écriture `PREPARED`, ce statut seul ne prouve pas que le commit a eu lieu. Conserver le reçu : le rejeu ou le retour arrière vérifie l’état réel avant toute décision. Ne pas supprimer ni modifier manuellement les empreintes.

## Retour arrière borné

```sh
node scripts/sage-overlap/repair.js rollback \
  --target testing \
  --target-env /chemin/prive/testing.env \
  --tunnel-port 55440 \
  --against-receipt /chemin/prive/apply-testing.json \
  --receipt /chemin/prive/rollback-testing.json
```

Le retour arrière restaure seulement les liens réellement modifiés par ce reçu, avec leurs UUID et dates d’origine. Il exige que l’état courant corresponde exactement à l’état après, ou reconnaît un retour arrière déjà effectué. Toute dérive ultérieure bloque l’opération entière. Le reçu d’un rejeu à zéro changement ne permet pas d’annuler l’application initiale : utiliser son reçu original.

## Validation synthétique

```sh
npx --no-install ava scripts/sage-overlap/__tests__/repair.js scripts/sage-overlap/__tests__/cli.js
SAGE_OVERLAP_INTEGRATION_TESTS=1 NODE_ENV=test \
  npx --no-install ava --concurrency=1 scripts/sage-overlap/__tests__/repair.integration.js
npx --no-install eslint scripts/sage-overlap
```

Les intégrations s’activent avec `SAGE_OVERLAP_INTEGRATION_TESTS=1` ou le `DROPT_INTEGRATION_TESTS=1` déjà utilisé par la CI. Elles exigent `DATABASE_URL` vers la base jetable autorisée par `requireDisposableDatabase` (`localhost:55439`, `security_tests` ou `integration_tests`, sans options d’URL ; service CI dédié également accepté). Elles créent et nettoient leur propre schéma synthétique. Ne jamais employer une base applicative pour ces tests.
