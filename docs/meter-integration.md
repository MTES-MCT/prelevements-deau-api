# Intégration générique des compteurs physiques

Cette intégration est indépendante des connecteurs historiques. Elle ne multiplie jamais un index par un taux générique : elle calcule la différence entre deux observations physiques consécutives, puis répartit le volume.

## Identité et autorisations

`ExternalReference` relie `(provider, scope, kind, externalId)` à exactement un point, déclarant ou compteur avec une vraie clé étrangère. Fournisseur et périmètre sont des chaînes opaques obligatoires, sans valeur par défaut. La référence n’accorde aucun droit.

`MeterStream` relie un identifiant fournisseur à un compteur et à un compte de service explicitement autorisé. Un seul flux peut être activé par compteur. Une série ou un client fournisseur inconnu ne crée aucune ressource automatiquement.

`MeterAllocation` relie un compteur à une exploitation. Plusieurs affectations peuvent cibler la même exploitation : leurs contributions sont regroupées dans une seule valeur publiée. Les métadonnées fournisseur sont opaques. Une affectation référentielle incomplète peut rester désactivée, sans dates ni pourcentage.

Les résumés d’affectations suivent les droits de lecture de l’exploitation. Les index physiques globaux restent réservés aux administrateurs : le droit sur un bénéficiaire ne donne pas le droit sur tous les bénéficiaires d’un compteur partagé.

## API dédiée

- `GET /service-accounts/meter-streams?provider=sample-provider&scope=sample-scope` : flux activés rattachés au compte de service ; les deux paramètres sont obligatoires.
- `POST /service-accounts/meter-readings/ingestions` : lot LIVE normalisé.
- `POST /admin/meter-readings/ingestions` : lot LIVE ou OFFLINE normalisé, administrateur hors impersonation.
- `GET /exploitations/:exploitationId/meter-allocations` : résumé des affectations et synchronisation.
- `GET /exploitations/:exploitationId/meters/:meterId/readings?cursor=UUID&limit=50` : index canoniques paginés, administrateur uniquement (limite 200).

Enveloppe d’ingestion :

```json
{
  "batchId": "identifiant déterministe de cette réponse fournisseur",
  "provider": "sample-provider",
  "scope": "sample-scope",
  "mode": "LIVE",
  "fetchedAt": "2026-09-17T04:00:00.000Z",
  "windowStart": "2026-09-01T22:00:00.000Z",
  "windowEnd": "2026-09-16T22:00:00.000Z",
  "complete": true,
  "readings": [{
    "externalId": "meter-123",
    "observedAt": "2026-09-10T08:00:00.000Z",
    "index": "1234.5000",
    "status": "VALID",
    "quality": "producer-quality-code",
    "origin": "producer-origin",
    "raw": {"original": "source row"}
  }]
}
```

Un retry réutilise exactement le même `batchId`, `fetchedAt`, les bornes et les lignes. Une nouvelle récupération, même identique, a un nouvel identifiant incorporant `fetchedAt`. Une collision d’identifiant avec un contenu différent reçoit 409. La réponse `{persisted:true, ingestionId, counts, checkpoint}` n’est envoyée qu’après validation de la transaction entière. Le checkpoint est exactement `windowEnd`, y compris si des lignes sont mises en quarantaine. `received` inclut toutes les enveloppes normalisées, valides ou invalides. Les autres compteurs sont `accepted`, `blocked`, `unknownMeters`, `unchanged`, `published`, `conflicts` ; `unchanged` est un indicateur de déduplication, pas une catégorie exclusive.

L’orchestrateur interprète seul les identifiants, dates locales, fuseaux, codes qualité et formats numériques du fournisseur. L’API exige une enveloppe normalisée : `externalId` chaîne ou null, `observedAt` instant ISO avec offset explicite ou null, `index` chaîne décimale non négative (16 chiffres entiers, 4 décimales maximum) ou null, `status` VALID ou INVALID. VALID exige ces trois champs non nulls. `quality`, `origin` et `reason` sont des annotations opaques facultatives. `raw` conserve le JSON original, y compris une primitive ou null. Un payload fournisseur brut à la place d’une enveloppe est refusé avec 400. Les dates métier des exploitations restent des jours du calendrier français ; elles ne constituent pas un parseur fournisseur.

La fenêtre inclut ses deux bornes et ne dépasse pas 32 jours ou l’instant de récupération ; le lot est limité à 50 000 enveloppes. Les réponses de résumés fournissent `sync.available` pour indiquer l’existence d’un flux, sans que l’interface ait à reconnaître son fournisseur.

## Historique, qualité et publication

Une observation canonique est unique par compteur et instant. Ses révisions sont immuables ; tous les lots bruts sont conservés. LIVE est prioritaire sur OFFLINE, puis l’ordre est celui de `fetchedAt`, jamais l’ordre d’arrivée. Des corrections contradictoires au même instant de récupération bloquent l’observation jusqu’à une récupération ultérieure.

Le statut normalisé INVALID et les baisses d’index bloquent le segment concerné. Aucun calcul ne saute une observation bloquée. Une enveloppe rattachée à un compteur mais sans instant bloque les segments recouvrant la fenêtre de récupération ; un lot complet plus récent couvrant cette fenêtre peut lever cette quarantaine. L’API ne connaît aucun code qualité fournisseur. Les données préactivation sont conservées sans interpolation à la date d’activation.

Le snapshot de répartition doit être explicitement validé et totaliser exactement 100 %, parts externes comprises. Chaque version d’affectation contient dans `metadata.allocationSnapshot` le snapshot complet daté, et `metadata.allocationSnapshotValidated: true`. Le snapshot courant du flux n’est qu’un fallback pour les versions initiales. Les parts externes ne nécessitent pas d’exploitation fictive. La méthode des plus forts restes assure la conservation exacte à quatre décimales avant regroupement par exploitation.

Une version activée ne change ni taux ni début ni identité. Sa fin peut être fermée/raccourcie, avec journal SQL `metadata._periodClosures`. Une correction crée les versions suivantes et appelle `reprocessMeterStreamInTransaction(tx, streamId)` dans la même transaction. Sans relevé au changement de version, l’intervalle traversant la frontière n’est pas interpolé. `reprocessMeterStream(streamId, {client})` ouvre sa propre transaction pour un recalcul autonome.

Chaque publication lie les deux révisions, le snapshot, les contributions et leurs versions à une `Source`, des `Chunk` METER et leurs valeurs. La publication remplacée devient inactive et ses chunks sont rejetés ; les anciennes valeurs ne sont jamais supprimées. Les requêtes de lecture et exports doivent exclure les chunks rejetés. Le recalcul générique ne traite que GENERIC.

Une série ordinaire est remplacée seulement si le flux possède `supersedeSameMeter=true` (false par défaut), si son `compteurId` correspond explicitement au même compteur et si son intervalle est entièrement couvert ; la valeur remplacée est auditée avec la politique `METER_KNOWN_SAME_CONSUMPTION`. Une identité inconnue, un chevauchement partiel ou une affectation ambiguë reste en conflit. Deux compteurs distincts ne peuvent s’additionner que si les deux affectations possèdent une validation additive datée explicite. Des triggers SQL protègent aussi les insertions historiques réalisées après un contrôle applicatif de conflit devenu obsolète.

## Vérification

Les tests PostgreSQL requièrent `METER_INTEGRATION_TESTS=1`, `NODE_ENV=test` et une base jetable reconnue par `requireDisposableDatabase`. Ils utilisent deux fournisseurs synthétiques, sans accès au fournisseur ni aux bases applicatives. Exemple local autorisé : base `security_tests`, hôte `127.0.0.1`, port `55439`.

Le recalcul s’arrête explicitement au-delà de 20 000 observations par compteur : ce cas exige une évolution paginée avant de reprendre l’ingestion, sans troncature silencieuse. Les erreurs réseau du fournisseur ne créent aucun lot API ; elles restent visibles dans l’orchestration.
