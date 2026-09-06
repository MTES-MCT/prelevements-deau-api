# Réseau privé demo

Ce pilote concerne **demo uniquement**. Ne pas substituer des identifiants
testing/prod dans ces commandes. Les identifiants non secrets sont conservés
dans `demo-resources.json`. Le VPC et le Private Network existants sont réutilisés.

## Sortie Internet fixe

L'IPv4 réservée est **51.158.122.78**. La gateway `VPC-GW-S` et la VM `DEV1-S`
sans IP publique sont en `fr-par-1`. La VM rejoint uniquement le PN demo.
Le proxy est `http://172.16.12.19:3128` depuis ce PN ; son nom privé est
`partageonsleau-demo-egress-proxy.partageonsleau-demo-pn.internal`.

Pour l'instant, Squid autorise seulement `CONNECT api.ipify.org:443`.
Aucun appel métier existant n'a été reconfiguré. **Le seul rattachement d'un
Serverless Container au PN ne force pas sa sortie Internet via la gateway.**
Une future intégration devra utiliser explicitement ce proxy, ajouter son nom
d'hôte exact à l'allowlist et refuser tout repli direct en cas d'erreur.

La configuration reproductible de la VM est `demo-proxy.cloud-init.yaml` :
remplacer son unique marqueur de clé SSH publique avant provisionnement,
valider le YAML et créer la VM arrêtée, sans IPv4/IPv6 publique. Attacher le PN
**avant** le premier démarrage. Ne jamais injecter de mot de passe ou de clé
privée dans cloud-init. La gateway annonce la route par défaut avec NAT ; la
propagation de cette route est activée sur le PN demo uniquement.

Après modification d'un fichier de configuration sur la VM, valider `sshd -t`,
`nft -c -f /etc/nftables.conf` et `squid -k parse`, puis redémarrer les services
concernés. `systemctl enable --now` seul ne recharge pas un service déjà actif.

## Accès opérateur après fermeture PostgreSQL

Le bastion écoute sur **61000**, avec une allowlist d'IPv4 opérateurs `/32`.
Lors de l'installation, seule l'IP du poste de Samy a été autorisée. Si cette IP
change : Console Scaleway → projet **partageons l eau** → **Network > Public
Gateways** → **Paris 1** → `partageonsleau-demo-gw` → **SSH Bastion > Allowed IPs**.
Ajouter la nouvelle IPv4 en `/32`, retirer l'ancienne devenue inutile. Ne jamais
ajouter `0.0.0.0/0`. Les droits API actuels permettent aussi cette opération.

La clé SSH existante de Samy doit être chargée dans l'agent. Ne pas activer le
transfert d'agent. Le compte VM est `pe-admin`, pas `root`.

L'empreinte ED25519 de la VM créée le 6 septembre 2026 est :

```text
SHA256:JGPtaO6Cn88xfmGSYLS1exX+4RKH0KiN54NZ5gRJCpA
```

Avant un premier accès, la relire indépendamment avec :

```sh
scw instance user-data get \
  server-id=d7cf7bc6-fcb7-4810-af93-f4474ddddbf4 \
  key=ssh-host-fingerprints zone=fr-par-1
```

Faire le premier accès interactif, comparer l'empreinte avant de l'accepter,
puis ouvrir le tunnel dans un terminal dédié :

```sh
ssh -J bastion@51.158.122.78:61000 pe-admin@172.16.12.19
sh deploy/network/demo-tunnel.sh
```

Le script conserve la vérification stricte des clés connues et n'écoute que sur
`127.0.0.1`. PostgreSQL devient joignable sur le port local **17063**, le proxy
sur **13128**. `Ctrl-C` ferme ces accès sans changer le réseau distant.

```sh
curl --proxy http://127.0.0.1:13128 https://api.ipify.org
# attendu : 51.158.122.78
```

Le tunnel ne justifie pas de désactiver TLS : garder `verify-full`, le CA demo,
le nom de base et le rôle propres à demo. Les scripts demo refusent toujours
une cible PostgreSQL localhost générique. Un conteneur Docker opérateur peut
conserver le nom TLS PostgreSQL attendu avec le tunnel :

```sh
docker run --rm --network=host \
  --add-host rw-ea5a07db-05df-4869-9e57-fa5f5c6c81cc.rdb.fr-par.scw.cloud:127.0.0.1 \
  --mount type=bind,src=/chemin/absolu/demo.env,dst=/run/pe/demo.env,readonly \
  --mount type=bind,src=/chemin/absolu/accounts.json,dst=/run/pe/accounts.json,readonly \
  --mount type=bind,src=/chemin/absolu/postgres-ca.pem,dst=/chemin/absolu/postgres-ca.pem,readonly \
  --entrypoint node '<image-api-demo@sha256:digest-vérifié>' \
  scripts/demo/seed-demo.js verify --target demo --dataset grivaise-v1 \
  --target-env /run/pe/demo.env --accounts /run/pe/accounts.json
```

Le fichier `demo.env` doit contenir `APP_ENV=demo` et `DATABASE_URL` avec le
rôle `prelevements_demo_app`, la base `prelevements_demo`, le FQDN ci-dessus,
le port `17063`, `sslmode=verify-full` et `sslrootcert` pointant vers le chemin
absolu monté du CA. Ne pas transmettre ces valeurs en arguments `docker -e`.
Cette commande est une **vérification sans réinitialisation du dataset**.

## Migrations et déploiement

Le workflow `.github/workflows/deploy-demo.yml` déploie exclusivement la branche
demo. Il construit une image, puis utilise **le même digest** pour l'exécuteur
de migrations, l'API et le worker. Il ne publie `demo-latest` qu'après réussite.
Une exécution en cours n'est pas annulée par un nouveau push.

Le conteneur `demo-api-migrations` réside dans le namespace séparé `demo-partageons-leau-migrations`,
sans secrets métier hérités, sur le PN demo, `privacy=private`, `max_scale=1`,
`min_scale=0`, timeout plateforme `1200s`. Sa commande est
`node scripts/network/migration-service.js`. Il possède uniquement deux secrets :
`DATABASE_URL` (rôle `demo_admin`, adresse privée `172.16.12.2:5432`) et
`MIGRATION_INVOKE_SECRET`. Les variables ordinaires comprennent `APP_ENV=demo`
et `MIGRATION_RELEASE_SHA`.

GitHub utilise les variables `SCW_DEMO_MIGRATION_NAMESPACE_ID` et
`SCW_DEMO_MIGRATION_CONTAINER_ID`, et le secret **demo uniquement**
`DEMO_MIGRATION_INVOKE_SECRET`. Les secrets Scaleway communs testing/prod ne
doivent pas être remplacés. Leur clé réelle est testée depuis la CI contre
`/healthz` et `/status` avant toute modification d'image.

- `GET /healthz` : état du service sans requête PostgreSQL.
- `GET /status` : secret secondaire requis, lecture du registre des migrations
  dans une transaction en lecture seule, avec contrôle identité et TLS réels.
- `POST /migrate` : secret secondaire requis, corps exact
  `{"expectedRelease":"<SHA Git complet>"}`. Seule la commande embarquée
  `prisma migrate deploy` est autorisée ; aucun SQL, shell ou URL client.

Un timeout ou un résultat inconnu bloque le déploiement, sans nouveau POST
automatique. Inspecter le registre PostgreSQL avant de décider d'une reprise.
Le service ignore les sorties Prisma brutes pour éviter de journaliser des
credentials. Le statut fournit les noms/états des migrations, jamais leur SQL
ni le champ de logs de Prisma.

TLS utilise deux syntaxes distinctes, normalisées dans le code :

- `pg` : `sslmode=verify-full`, `sslrootcert`, contrôle explicite du nom/IP
  de la cible et validation du certificat ;
- CLI Prisma 7.8 : `sslmode=require`, `sslaccept=strict`, `sslcert`.

Ne pas ajouter de contournement `rejectUnauthorized=false` ou `accept_invalid_certs`.

## Retour arrière

Conserver l'IPv4 réservée de la gateway lors d'une reconstruction de la VM.
Pour revenir à une image applicative précédente, vérifier d'abord sa
compatibilité TLS avec l'adresse privée ; les anciennes images sans correctif
ne constituent pas un rollback réseau complet.

La recréation d'un endpoint public PostgreSQL est une opération de secours
explicite : Scaleway peut attribuer **une autre IP et un autre port**. Relire
l'endpoint créé et actualiser les seuls consommateurs concernés, sans recopier
aveuglément l'ancienne URL et sans remplacer les maps de secrets.

Le retrait d'un endpoint public réinitialise temporairement l'instance PostgreSQL.
Il ne doit intervenir qu'après validation de la CI privée, du tunnel opérateur,
du seed `verify`, des consommateurs applicatifs et d'une sauvegarde récente.

Le 6 septembre, la création d'un snapshot supplémentaire a été refusée par le
quota de l'organisation (`rdb_snapshots`: 141 utilisés / 100 autorisés). Aucun
snapshot testing/prod n'a été supprimé pour contourner ce quota. Une sauvegarde
logique complète demo via le tunnel privé remplace ce snapshot préalable ; le
quota doit être traité séparément avec le propriétaire de l'organisation.

## Coût indicatif

Gateway + IPv4 + VM : environ **29,19 € HT/mois** pour 730 h, hors stockage,
trafic et exécution ponctuelle des migrations. Une seule VM/gateway n'est pas
une architecture haute disponibilité. Le proxy étant réservé aux intégrations
futures, son indisponibilité ne détourne aucun appel métier existant.

Références : [réseau des Serverless Containers](https://www.scaleway.com/en/docs/serverless-containers/reference-content/containers-private-networks/),
[bastion](https://www.scaleway.com/en/docs/public-gateways/how-to/use-ssh-bastion/),
[cloud-init sans IP publique](https://www.scaleway.com/en/docs/instances/how-to/use-cloud-init/),
[retrait de l'endpoint PostgreSQL public](https://www.scaleway.com/en/docs/managed-databases-for-postgresql-and-mysql/how-to/remove-public-endpoint/).
