# Reprise des publications de campagne

`scripts/recheck-campaign-publications.js` réévalue les réponses déjà envoyées et
`PENDING_REVIEW` avec le même service métier que les nouveaux envois. Les motifs
réels de blocage restent conservés : aucun rattachement, partage historique ou
index fournisseur n'est déduit ou forcé par ce script.

La cible est obligatoirement `prod` (URL et identité PostgreSQL contrôlées) ou
`disposable` (uniquement la base jetable des tests avec `NODE_ENV=test`). Aucun
envoi de réponse ni notification n'est effectué. Brouillons, données envoyées,
révisions, dates d'envoi, propriétaires, index déclarés et données fournisseurs
sont vérifiés avant et après chaque opération ; une différence annule la
transaction. Les seuls changements attendus sont les états de publication,
métadonnées de calcul, volumes dérivés et, lorsque les preuves historiques sont
suffisantes, la publication physique propre à la campagne.

Les identifiants ci-dessous sont à remplacer par un périmètre préalablement
vérifié. La liste explicite contient de 1 à 500 réponses d'une seule campagne.
Si plusieurs réponses partagent un point ou un compteur, l'application du lot
est refusée avant toute mutation : exécuter la séquence complète
prévisualisation/application/vérification **une réponse à la fois**, puis refaire
une prévisualisation fraîche pour la suivante. Les résultats calculés pour la
première réponse peuvent modifier les éléments à examiner pour la seconde.
Les rapports et sauvegardes doivent rester hors du dépôt, dans un répertoire
appartenant à l'opérateur en mode `0700` ; chaque fichier est créé en `0600`,
sans écrasement, puis synchronisé sur disque. Ne pas mettre de secret en ligne
de commande ; utiliser la configuration PostgreSQL du processus d'exploitation.

```sh
node scripts/recheck-campaign-publications.js --mode preview --target prod \
  --campaign-id UUID_CAMPAGNE --response-ids UUID_REPONSE_1,UUID_REPONSE_2 \
  --report /chemin/prive/preview.json

node scripts/recheck-campaign-publications.js --mode apply --target prod \
  --campaign-id UUID_CAMPAGNE --response-ids UUID_REPONSE_1,UUID_REPONSE_2 \
  --expected-report /chemin/prive/preview.json --expected-report-hash SHA256_PREVIEW \
  --backup-dir /chemin/prive/sauvegardes --report /chemin/prive/apply.json

node scripts/recheck-campaign-publications.js --mode verify --target prod \
  --campaign-id UUID_CAMPAGNE --response-ids UUID_REPONSE_1,UUID_REPONSE_2 \
  --expected-report /chemin/prive/apply.json --expected-report-hash SHA256_APPLY \
  --report /chemin/prive/verify.json
```

La prévisualisation et la vérification utilisent des transactions PostgreSQL
explicitement en lecture seule. Chaque application est une transaction
`Serializable`, limitée à 60 secondes, verrouillée sur la campagne et la
réponse ; le service métier verrouille aussi les compteurs et points concernés.
La sauvegarde complète du périmètre de calcul est écrite **avant** sa première
mutation. Un fichier `committed-*` est enregistré après chaque transaction
réussie : une erreur sur une réponse ultérieure ne masque pas les précédentes.
Consulter ces journaux et le rapport `failure-*` avant toute reprise.

L'empreinte affichée est celle du contenu canonique du rapport (`reportHash`),
pas celle de ses octets mis en forme. L'application exige cette empreinte et le
périmètre exact de la prévisualisation. Si les données ont changé entre-temps,
elle refuse la réponse et demande une nouvelle prévisualisation. Une réponse
devenue publiée avec ses données protégées inchangées est ignorée au rejeu.
Les réponses encore bloquées peuvent nécessiter un nouveau rapport après mise
à jour de leurs motifs ; aucun rejeu ne réécrit les réponses envoyées.

La vérification relit les résultats et les invariants sauvegardés ; tout écart
produit `complete: false` et un code de sortie non nul. La console ne contient
que les identifiants, états, codes de motifs, compteurs et empreintes ; les
données détaillées restent dans les fichiers privés. Aucune restauration
automatique n'est prévue : les sauvegardes permettent d'examiner une réparation
précise sans effacer les modifications intervenues depuis.

Pour une connexion d'exploitation déjà vérifiée (par exemple un tunnel privé),
les fonctions `previewCampaignPublications`, `applyCampaignPublications` et
`verifyCampaignPublications` du module `scripts/lib/campaign-publication-recheck.js`
acceptent un client Prisma injecté. Le contrôle de l'identité PostgreSQL connectée
reste obligatoire ; `apply` exige un callback `onBeforeApply` qui persiste la
sauvegarde avant de renvoyer sa référence, et permet `onAfterEntry` pour le journal.
