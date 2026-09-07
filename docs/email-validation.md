# Validation des adresses email

## Parcours

Le changement d'adresse principale et l'ajout d'un email alternatif créent une
demande valable 24 heures. Une seule demande reste active par compte et par
finalité. Le renvoi est possible après 60 secondes ; l'annulation est immédiate.

Les états persistés sont : `PENDING`, `SEND_FAILED`, `EXPIRED`, `VERIFIED`,
`CANCELLED`, `SUPERSEDED` et `CONFLICT`.

La confirmation d'une nouvelle adresse principale :

- remplace l'adresse de connexion et retire l'ancien alias éventuel ;
- synchronise l'adresse de contact principale du déclarant ;
- révoque les magic links, activations de mot de passe et sessions humaines ;
- demande une nouvelle connexion avec la nouvelle adresse.

La confirmation d'un alias ne ferme pas les sessions existantes. La suppression
d'un alias révoque les magic links encore utilisables qui auraient pu lui être
envoyés.

## Garanties de sécurité

Les jetons de validation contiennent 256 bits aléatoires. Seule leur empreinte
SHA-256 est stockée. Le secret est transmis au front dans le fragment d'URL,
puis retiré avant le chargement des outils de mesure d'audience.

Le registre SQL `UserEmailIdentity` sérialise les revendications concurrentes
d'une même adresse entre les emails principaux, les alias et les validations en
cours. `User.authVersion` empêche une ancienne instance de créer un magic link,
une activation ou une session après la révocation liée à une adresse devenue
obsolète. Les versions du compte cible et de l'administrateur sont toutes deux
contrôlées pour une session d'impersonation.

Pendant une session d'assistance ouverte par un administrateur, les
coordonnées et les adresses de connexion du compte peuvent être gérées. Chaque
mutation conserve l'administrateur comme auteur réel dans le journal d'audit.
Le changement de mot de passe reste interdit dans ce contexte.

## Déploiement

1. Suspendre brièvement les écritures d'authentification de l'API, ou laisser le
   job de migration échouer fermé puis le relancer après drainage des requêtes
   en cours. La migration prend des verrous exclusifs avec un délai de 10 secondes
   afin de ne jamais poursuivre sur un backfill partiel.
2. Appliquer la migration `20260831170000_add_user_email_verifications`.
3. Déployer entièrement la nouvelle version de l'API et vérifier `/healthz`.
4. Déployer ensuite le front qui expose `/mon-compte` et `/validation-email`.

Après la migration, la génération d'authentification protège le chevauchement
temporaire entre anciennes et nouvelles instances. Le drainage du premier point
reste nécessaire pour éviter qu'un cycle de verrous d'une requête déjà en vol ne
fasse échouer le job DDL.
