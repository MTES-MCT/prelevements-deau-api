# Scanner ClamAV à la demande

Image autonome, sans dépendance npm, à déployer exclusivement derrière l’endpoint
HTTPS privé Scaleway. `clamd` écoute uniquement sur `127.0.0.1:3310`. Le processus
Node et ClamAV s’exécutent avec l’utilisateur non privilégié `clamav`.

- `CLAMAV_INVOKE_TOKEN` : secret obligatoire, 32 octets aléatoires encodés en 64
  caractères hexadécimaux minuscules. Transmis par `Authorization: Bearer …`.
- `PORT` : port HTTP, 8080 par défaut.
- `GET /readyz` : disponibilité minimale pour les sondes de plateforme ; aucune
  métadonnée ni authentification. Ne pas le sonder périodiquement depuis un service
  externe : cela empêcherait la descente à zéro instance.
- `GET /healthz` : disponibilité, versions, `bootId` et `startedAt`, authentifié.
  L’identifiant de démarrage permet de vérifier un redémarrage après inactivité
  sans installer une surveillance externe qui garderait le service actif.
- `POST /scan` : corps binaire `application/octet-stream`, authentifié ; aucune
  URL distante, chemin de fichier ou clé de stockage n’est accepté.

Un verdict HTTP 200 contient `status` (`clean`, `infected`, `unscannable`), `sha256`,
`bytes`, `engineVersion`, `signatureVersion` et `signatureUpdatedAt`. Le client doit
accepter uniquement `clean`, vérifier l’empreinte des octets effectivement envoyés
et refuser les erreurs ou réponses inconnues. Les heuristiques d’archives chiffrées,
de documents cassés et de limites atteintes donnent `unscannable`.

Le scanner refuse les fichiers de plus de 50 000 000 octets, admet au maximum deux
analyses simultanées et limite chacune à 120 secondes. L’API conserve une échéance
globale de 180 secondes, incluant le démarrage du conteneur et l’ensemble du lot.
Une déconnexion arrête le flux et libère sa place. Les fichiers ne sont pas
conservés ; les temporaires internes de ClamAV sont supprimés après analyse.

Les signatures officielles sont mises à jour et validées **pendant la construction**,
avec un argument `SIGNATURE_REFRESH` renouvelé par la CI quotidienne. Le scanner
ne démarre ni `freshclam` ni téléchargement à l’exécution. Il refuse de rendre un
verdict lorsque la date de la base chargée dépasse 72 heures. Les images précédentes
ne peuvent donc pas masquer un échec prolongé de mise à jour.

`MaxFileSize` est volontairement supérieur à `MaxScanSize` : l’extracteur ZIP de
ClamAV peut tronquer avant de vérifier la taille d’un fichier extrait. Avec cette
configuration, même un contenu tronqué dépasse le budget total et déclenche le
refus. Le smoke couvre les deux limites avec de vraies archives synthétiques.

```sh
node --test deploy/antivirus/scanner/*.checks.mjs
docker build --build-arg SIGNATURE_REFRESH=2026-11-10 \
  -t ple-clamav:candidate deploy/antivirus/scanner
node deploy/antivirus/scanner/smoke.mjs ple-clamav:candidate
```

Le smoke démarre une instance Docker jetable limitée à 4 Gio / 2 CPU, génère son
propre secret et vérifie un fichier sain, EICAR brut et compressé, une archive
chiffrée et la limite de 50 Mo. Il supprime son conteneur et son secret même en cas
d’échec. La mesure locale ne constitue pas une preuve de délai à froid Scaleway.

L’audit d’image dédié exige un digest exact, un inventaire système complet et zéro
vulnérabilité, sans exception. Le contrôle distinct de l’image applicative reste
inchangé : son exigence d’inventaire npm ne s’applique pas à ce scanner sans npm.
