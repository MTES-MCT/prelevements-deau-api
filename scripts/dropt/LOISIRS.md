# Complément autonome Loisirs

Ce complément reprend les identités du registre epIdropt déjà importé. Il sélectionne exclusivement l’usage Sandre **7 — Loisirs** ; le code **17 — Domestique** et l’import AEP autonome restent distincts. Les PP et les préleveurs doivent déjà exister avec leurs UUID, `sourceId` et références historiques. Leur profil et leurs caractéristiques ne sont pas réimportés.

## Préparer la source

Conserver hors de tout dépôt Git le classeur epIdropt original, le manifeste historique complet et un fichier de décisions. Ne pas remplacer les anciens manifestes, le fichier AEP ni leurs rapports. Le fichier de décisions contient uniquement :

```json
{
  "version": 1,
  "sourceSha256": "SHA256_DU_CLASSEUR_ORIGINAL",
  "previousManifestHash": "MANIFESTHASH_DU_REGISTRE_HISTORIQUE",
  "exploitations": [
    {
      "row": 3,
      "rowHash": "DIGEST_CANONIQUE_DES_VALUES_SOURCE",
      "pointName": "POINT-SYNTHETIQUE",
      "declarantKey": "epidropt:preleveur:siret:12345678900001",
      "declarantSiret": "12345678900001"
    }
  ]
}
```

`rowHash` est `digest(row.values)` après `readWorkbook(classeur, EPIDROPT_SHEETS)`. Il ne s’agit ni du SHA256 de la cellule ni d’un hash de texte CSV. Une résolution explicite du propriétaire peut corriger une ligne historiquement ambiguë, mais doit être justifiée par le nom exact et le SIRET de la source dans le dossier privé. La préparation refuse toute ligne différente, un propriétaire absent, un usage autre que Loisirs, des références divergentes ou une exploitation historiquement classée autrement.

Depuis la racine de l’API, la préparation copie les sources originales en lecture seule dans le dossier privé et ne se connecte à aucune base :

```sh
node scripts/dropt/import-loisirs.js prepare \
  --input /chemin/prive/loisirs \
  --source /chemin/prive/source.xlsx \
  --previous-manifest /chemin/prive/ancien-manifeste.json \
  --decisions /chemin/prive/decisions.json
```

Les copies source sont conservées sous `raw/` avec permissions `0400`. Une copie différente de même nom est refusée. Le manifeste est archivé sous son empreinte et disponible sous `mapping/manifest.json`. Chaque commande suivante reconstruit le manifeste depuis ces copies et refuse toute dérive. La sortie ne publie que des comptes et une empreinte ; les données nominatives restent dans les fichiers privés.

```sh
node scripts/dropt/import-loisirs.js review --input /chemin/prive/loisirs \
  --target prod --target-env /chemin/prive/prod.env --tunnel-port 55441 \
  --report /chemin/prive/loisirs/review.json

node scripts/dropt/import-loisirs.js apply --apply --input /chemin/prive/loisirs \
  --target prod --target-env /chemin/prive/prod.env --tunnel-port 55441 \
  --against-report /chemin/prive/loisirs/review.json \
  --backup-proof /chemin/prive/loisirs/backup-proof.json \
  --report /chemin/prive/loisirs/applied.json

node scripts/dropt/import-loisirs.js verify --input /chemin/prive/loisirs \
  --target prod --target-env /chemin/prive/prod.env --tunnel-port 55441 \
  --report /chemin/prive/loisirs/verified.json
```

La preuve doit attester une sauvegarde native restaurée et un état identique à la simulation. La transaction sérialisable revalide cible TLS, empreintes du code, état et plan avant les écritures. Les commandes sans `--apply` restent en lecture seule ; utiliser un nouveau rapport à chaque passage. Pour testing, fournir sa propre cible, son environnement et son tunnel.

## Contrat du manifeste et limites

Le résultat conserve `formatVersion: 1`, `scope: "epidropt"` et le hash canonique du parseur historique, pour rester compatible avec ses contrôles d’identité et son opération séparée `enable-logins`. `loisirsPolicy` impose les points et préleveurs existants, l’usage 7, l’absence de collecteur, la saisie rapide non exclue et la conservation des réponses de campagne. `loisirsEvidence` lie chaque objet à son empreinte historique et aux décisions source. Les tableaux `meters`, `allocations` et `contracts` restent vides, même si le classeur comporte des numéros de série de compteur.

Appliquer exclusivement le complément dédié après simulation, sauvegarde restaurée et revue des identités. Ne pas passer ce manifeste à un réimport général pour configurer la saisie rapide : celui-ci pourrait remettre à jour des champs encore conformes à une ancienne référence d’import. Le complément ne doit modifier ni les PP, ni les préleveurs, ni les compteurs, ni les campagnes ou leurs réponses. Une exploitation manquante reçoit l’identité déterministe calculée par le parseur historique ; une exploitation existante conserve son identité et son historique.

L’accès au compte est une opération distincte. `enable-logins` conserve ses contrôles d’unicité globale, de contacts importés, d’alias, de vérifications en attente et d’activité existante. Un email présent dans plusieurs contacts reste bloqué par défaut : une décision d’identité pour une exploitation ne donne aucune autorisation de déplacer ou partager une adresse de connexion. Aucun email, invitation, jeton ou mot de passe n’est créé par la préparation.

## Connexion avec un contact partagé explicitement revu

Après autorisation explicite pour **un UUID précis**, le compagnon suivant permet d’utiliser son unique email source déjà importé, même s’il figure aussi comme simple contact d’un autre préleveur. Il conserve ce contact et les fiches existantes. Il refuse toujours un email déjà utilisé ou réservé comme identifiant principal, alias ou vérification, un contact sans preuve d’import et un compte déjà configuré différemment. Il ne fusionne aucun compte et n’envoie aucun message.

```sh
node scripts/dropt/enable-loisirs-login.js --input /chemin/prive/loisirs \
  --owner UUID_EXPLICITEMENT_AUTORISE --target prod \
  --target-env /chemin/prive/prod.env --tunnel-port 55441 \
  --report /chemin/prive/loisirs/login-review.json

node scripts/dropt/enable-loisirs-login.js --input /chemin/prive/loisirs \
  --owner UUID_EXPLICITEMENT_AUTORISE --target prod \
  --target-env /chemin/prive/prod.env --tunnel-port 55441 --apply \
  --against-report /chemin/prive/loisirs/login-review.json \
  --backup-proof /chemin/prive/loisirs/login-backup-proof.json \
  --report /chemin/prive/loisirs/login-applied.json
```

La preuve de connexion contient `target`, `ownerId`, `manifestHash` du manifeste Loisirs complet, `loginStateHash` égal au `result.entries[0].stateHash` de sa simulation, `restoreMatched: true`, `restoredAt`, `backupFile` absolu et `backupSha256`. Elle doit être établie depuis la sauvegarde native restaurée et un contrôle de l’état précis du compte avant activation. Le reçu `PREPARED` est synchronisé sur disque dans la transaction avant le commit ; `COMMITTED` confirme ensuite sa réussite. Un rejeu utilise une nouvelle simulation et une preuve cohérente avec le nouvel état ; il constate le compte inchangé. Aucun paramètre d’exception n’est exposé par le CLI générique Dropt.

Après application, vérifier les identités, l’usage 7, les capacités effectives de saisie rapide, l’absence de nouveau collecteur et la conservation des réponses existantes ; rejouer doit produire zéro modification. Le rollback AEP et les reçus AEP antérieurs restent attachés à leur code et à leur manifeste d’origine : ils ne servent pas à annuler ce complément Loisirs.

## Tests ciblés

```sh
node_modules/.bin/ava scripts/dropt/lib/__tests__/loisirs-source.js \
  scripts/dropt/lib/__tests__/epidropt-declarant-name.js
node_modules/.bin/eslint scripts/dropt/lib/loisirs-source.js \
  scripts/dropt/lib/__tests__/loisirs-source.js
```

Les tests de source n’ouvrent aucune base. Les tests d’application doivent utiliser exclusivement la base PostgreSQL/PostGIS jetable prévue par `AGENTS.md`, avec fixtures synthétiques.
