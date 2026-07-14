# Matrice des droits des agents par zone

## Principes

- Un droit est attribué à un agent pour une zone et une période données.
- Les droits sont additifs. Un agent rattaché à plusieurs zones cumule ses droits actifs.
- Pour une ressource liée à plusieurs zones, le droit accordé sur une seule de ces zones suffit pour agir sur la ressource.
- Le rôle global `ADMIN` possède implicitement tous les droits sur toutes les zones.
- Il n'existe pas de profil de droits prédéfini : l'interface présente les droits atomiques, regroupés par domaine.
- Les dépendances indiquées dans la matrice sont obligatoires. L'interface les sélectionne et les retire automatiquement ; l'API refuse une combinaison incohérente.
- Il n'existe aucune incompatibilité métier entre deux droits. Les seules contraintes sont les dépendances et les règles de délégation.
- Un agent ne peut pas modifier ni retirer ses propres droits.
- Un agent qui gère les habilitations ne peut attribuer que des droits qu'il possède lui-même sur la zone.
- Le dernier gestionnaire actif d'une zone ne peut pas perdre l'ensemble des droits `zone.agent.create`, `zone.agent.update` et `zone.agent.remove`, ni être retiré.
- Chaque création, modification, migration ou suppression d'une habilitation est journalisée en base.

## Matrice exhaustive

La colonne **Dépend de** est vide lorsque le droit peut être attribué seul.

| Scope | Action | Nom du droit | Nature | Dépend de |
|---|---|---|---|---|
| Zone et tableau de bord | Consulter la vue d'ensemble et les informations générales d'une zone | `zone.detail.read` | Lecture | |
| Zone et tableau de bord | Consulter le périmètre géographique d'une zone | `zone.geometry.read` | Lecture | `zone.detail.read` |
| Zone et tableau de bord | Accéder au tableau de bord d'une zone | `zone.dashboard.read` | Lecture | |
| Zone et tableau de bord | Inclure la zone dans l'export de la liste des zones | `zone.export` | Export | `zone.detail.read` |
| Paramétrage des ressources en eau | Voir les piézomètres et stations de débit paramétrés | `zone.resource.list` | Lecture | `zone.detail.read` |
| Paramétrage des ressources en eau | Ajouter une ressource à la zone | `zone.resource.create` | Écriture | `zone.resource.list` |
| Paramétrage des ressources en eau | Modifier une ressource de la zone | `zone.resource.update` | Écriture | `zone.resource.list` |
| Paramétrage des ressources en eau | Supprimer une ressource de la zone | `zone.resource.delete` | Suppression | `zone.resource.list` |
| Paramètres de déclaration | Consulter la périodicité et les règles de déclaration | `zone.declaration.settings.read` | Lecture | `zone.detail.read` |
| Paramètres de déclaration | Modifier la périodicité et les règles de déclaration | `zone.declaration.settings.update` | Écriture | `zone.declaration.settings.read` |
| Paramètres de déclaration | Créer une dérogation de période | `zone.declaration.override.create` | Écriture | `zone.declaration.settings.read` |
| Paramètres de déclaration | Modifier une dérogation de période | `zone.declaration.override.update` | Écriture | `zone.declaration.settings.read` |
| Paramètres de déclaration | Supprimer une dérogation de période | `zone.declaration.override.delete` | Suppression | `zone.declaration.settings.read` |
| Déclarations | Voir la liste des déclarations | `declaration.list` | Lecture | |
| Déclarations | Voir le détail d'une déclaration | `declaration.detail.read` | Lecture | `declaration.list` |
| Déclarations | Télécharger les fichiers sources d'une déclaration | `declaration.file.download` | Lecture | `declaration.detail.read` |
| Déclarations | Valider, rejeter ou commenter les lignes d'une déclaration | `declaration.instruct` | Écriture | `declaration.detail.read` |
| Déclarations | Associer ou détacher les lignes d'un fichier aux points | `declaration.reconcile` | Écriture | `declaration.detail.read` |
| Déclarations | Voir le suivi des déclarations attendues, reçues et manquantes | `declaration.followup.read` | Lecture | `zone.detail.read` |
| Déclarations | Exporter les déclarations manquantes | `declaration.followup.export` | Export | `declaration.followup.read` |
| Points de prélèvement | Voir la liste des points | `pp.list` | Lecture | `zone.detail.read` |
| Points de prélèvement | Voir la carte des points | `pp.map.read` | Lecture | |
| Points de prélèvement | Exporter la liste des points | `pp.export` | Export | `pp.list` |
| Points de prélèvement | Voir le détail d'un point | `pp.detail.read` | Lecture | `pp.list` |
| Points de prélèvement | Voir les index et volumes d'un point | `pp.volumes.read` | Lecture | `pp.detail.read` |
| Points de prélèvement | Créer un point | `pp.create` | Écriture | `pp.list`, `zone.geometry.read` |
| Points de prélèvement | Modifier un point | `pp.update` | Écriture | `pp.detail.read`, `zone.geometry.read` |
| Points de prélèvement | Supprimer un point | `pp.delete` | Suppression | `pp.detail.read` |
| Exploitations | Voir la liste des exploitations | `exploitation.list` | Lecture | `zone.detail.read` |
| Exploitations | Exporter la liste des exploitations | `exploitation.export` | Export | `exploitation.list` |
| Exploitations | Voir le détail d'une exploitation | `exploitation.detail.read` | Lecture | `exploitation.list` |
| Exploitations | Voir les index et volumes d'une exploitation | `exploitation.volumes.read` | Lecture | `exploitation.detail.read` |
| Exploitations | Créer une exploitation | `exploitation.create` | Écriture | `exploitation.list`, `pp.list`, `declarant.list` |
| Exploitations | Modifier une exploitation, son usage ou ses collecteurs | `exploitation.update` | Écriture | `exploitation.detail.read`, `pp.list`, `declarant.list` |
| Exploitations | Supprimer une exploitation | `exploitation.delete` | Suppression | `exploitation.detail.read` |
| Déclarants et collecteurs | Voir la liste des déclarants et collecteurs | `declarant.list` | Lecture | `zone.detail.read` |
| Déclarants et collecteurs | Exporter la liste des déclarants et collecteurs | `declarant.export` | Export | `declarant.list` |
| Déclarants et collecteurs | Voir le détail d'un déclarant ou collecteur | `declarant.detail.read` | Lecture | `declarant.list` |
| Déclarants et collecteurs | Voir les index et volumes d'un déclarant | `declarant.volumes.read` | Lecture | `declarant.detail.read` |
| Déclarants et collecteurs | Créer un déclarant ou collecteur | `declarant.create` | Écriture | `declarant.list` |
| Déclarants et collecteurs | Envoyer ou renvoyer l'email de création de compte | `declarant.invite` | Envoi | `declarant.detail.read` |
| Déclarants et collecteurs | Modifier l'identité et les options d'un déclarant | `declarant.update` | Écriture | `declarant.detail.read` |
| Déclarants et collecteurs | Supprimer un déclarant | `declarant.delete` | Suppression | `declarant.detail.read` |
| Déclarants et collecteurs | Envoyer manuellement un rappel de déclaration | `declarant.reminder.send` | Envoi | `declarant.detail.read` |
| Déclarants et collecteurs | Ajouter ou retirer les zones explicites d'un déclarant | `declarant.zone.update` | Écriture | `declarant.detail.read` |
| Déclarants et collecteurs | Voir les types de déclaration autorisés | `declarant.declaration-type.read` | Lecture | `declarant.detail.read` |
| Déclarants et collecteurs | Modifier les types de déclaration autorisés | `declarant.declaration-type.update` | Écriture | `declarant.declaration-type.read` |
| Déclarants et collecteurs | Voir les alias d'email | `declarant.email-alias.read` | Lecture | `declarant.detail.read` |
| Déclarants et collecteurs | Ajouter ou supprimer un alias d'email | `declarant.email-alias.update` | Écriture | `declarant.email-alias.read` |
| Déclarants et collecteurs | Voir les règles de gestion | `declarant.rule.read` | Lecture | `declarant.detail.read` |
| Déclarants et collecteurs | Créer une règle de gestion | `declarant.rule.create` | Écriture | `declarant.rule.read`, `exploitation.list` |
| Déclarants et collecteurs | Modifier une règle de gestion | `declarant.rule.update` | Écriture | `declarant.rule.read`, `exploitation.list` |
| Déclarants et collecteurs | Supprimer une règle de gestion | `declarant.rule.delete` | Suppression | `declarant.rule.read` |
| Déclarants et collecteurs | Voir et télécharger les documents | `declarant.document.read` | Lecture | `declarant.detail.read` |
| Déclarants et collecteurs | Ajouter un document | `declarant.document.create` | Écriture | `declarant.document.read` |
| Déclarants et collecteurs | Modifier les informations d'un document | `declarant.document.update` | Écriture | `declarant.document.read` |
| Déclarants et collecteurs | Supprimer un document | `declarant.document.delete` | Suppression | `declarant.document.read` |
| Agents de la zone | Voir la liste des agents | `zone.agent.list` | Lecture | `zone.detail.read` |
| Agents de la zone | Exporter la liste des agents | `zone.agent.export` | Export | `zone.agent.list` |
| Agents de la zone | Voir le détail, la période et les droits d'un agent | `zone.agent.detail.read` | Lecture | `zone.agent.list` |
| Agents de la zone | Créer ou rattacher un agent | `zone.agent.create` | Écriture | `zone.agent.list` |
| Agents de la zone | Modifier la période et les droits d'un autre agent | `zone.agent.update` | Écriture | `zone.agent.detail.read` |
| Agents de la zone | Retirer un agent de la zone | `zone.agent.remove` | Suppression | `zone.agent.detail.read` |
| Agents de la zone | Envoyer ou renvoyer les emails d'accès | `zone.agent.notify` | Envoi | `zone.agent.detail.read` |
| Exports de données | Créer, consulter, télécharger et supprimer ses exports de mesures | `export.volumes` | Export | |

## Rattachement des déclarants aux zones

`DeclarantZone` est la source de vérité du périmètre d'un déclarant ou collecteur. Un déclarant créé depuis l'administration doit être rattaché à au moins une zone. Les liens sont aussi ajoutés automatiquement lorsqu'une exploitation ou un collecteur est associé à un point zoné, ou lorsqu'une déclaration est rapprochée d'un point zoné.

Un déclarant historique qui reste sans zone après le rattrapage n'est accessible qu'aux administrateurs globaux. L'API ne déduit pas un accès à partir de l'absence de rattachement.

## Migration des deux rôles historiques

La migration est additive et conserve temporairement `InstructorZone.isAdmin` pour permettre un déploiement progressif. Les autorisations applicatives ne doivent plus lire ce booléen.

- Une habilitation historique avec `isAdmin = true` reçoit les 65 droits.
- Une habilitation historique avec `isAdmin = false` reçoit tous les droits de lecture qu'elle exerçait, ainsi que l'instruction, le rapprochement et les exports auparavant accessibles.
- Une nouvelle habilitation reçoit par défaut uniquement les 25 droits de lecture.
- `isAdmin` est maintenu à `true` par compatibilité uniquement lorsque l'habilitation contient les 65 droits.
- La suppression définitive de `isAdmin` fera l'objet d'une migration ultérieure, après vérification des déploiements et des consommateurs.

## Contrôle de cohérence

Le catalogue exécutable se trouve dans `lib/constants/zone-permissions.js`. La documentation, la migration de données, l'API de catalogue et les tests doivent contenir exactement les mêmes codes. Le script `npm run audit:zone-agent-permissions` contrôle les droits inconnus, les dépendances manquantes, les habilitations vides, les zones sans gestionnaire actif et les déclarants sans zone.

## Déploiement

1. Appliquer les migrations Prisma avant de démarrer la nouvelle version de l'API.
2. Déployer l'API, puis le front.
3. Exécuter `npm run audit:zone-agent-permissions` et conserver son rapport.
4. Vérifier en priorité les déclarants orphelins et les zones qui n'ont aucun gestionnaire actif.

Après la première modification de droits atomiques, un retour à une ancienne version de l'API n'est pas sûr : l'ancien code ne connaît que `isAdmin` et accorderait de nouveau le périmètre historique complet aux agents non administrateurs. Un rollback applicatif doit donc être accompagné d'un retour des données ou du maintien de la nouvelle couche d'autorisation.
