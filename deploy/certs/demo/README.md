# Certificats publics de l'environnement demo

Le build `demo` attend exactement les deux autorités de certification publiques
fournies par les ressources Scaleway dédiées à cet environnement :

- `postgres-ca.pem` pour PostgreSQL ;
- `redis-ca.pem` pour Redis.

Les CA de `testing` et de `prod` ne sont pas identiques et sont liées à leurs
ressources respectives. Elles ne doivent pas être copiées ici. Récupérer les CA
publiques depuis les nouvelles ressources `demo`, vérifier leurs empreintes,
puis remplacer les deux fichiers `.example` par les fichiers `.pem` attendus.

Le workflow refuse de construire l'image tant que ces deux fichiers réels sont
absents ou vides.
