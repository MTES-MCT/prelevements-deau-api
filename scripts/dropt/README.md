# Procédure d'import du SAGE Dropt

Ces scripts importent les données de l'onglet `PAR_2026-2027` du fichier :

```text
data/dropt/FICHIER_PLAT_OUDropt_RETOUR_ENQUETE26-27.xlsx
```

Depuis la racine du projet :

```bash
bash scripts/dropt/import-dropt-data.sh
```

Ou étape par étape :

```bash
node scripts/import-zones.js
node scripts/dropt/import-point-prelevements.js
node scripts/dropt/import-declarants.js
node scripts/dropt/import-exploitations.js
```

## Mapping retenu

- `PointPrelevement`
  - identifiant stable `sourceId = dropt-par-2026-2027-point-*`
  - nom priorisé depuis `N° Ouvrage OUGC`, puis `code ouvrage ougc`, `N° Point DDT`, `Code CACG`, puis commune/lieu/ligne
  - gestion des doublons et des libellés génériques par suffixe `ligne <n>`
  - coordonnées X/Y contrôlées avant insertion ; les zones sont recalculées par `ST_Contains` après chaque upsert
  - codes techniques conservés dans `codePTP`, `codeOPR` et `otherNames`
  - commune, lieu-dit, section, parcelle, ressource locale, méthode de remplissage, compteur et commentaires conservés dans les champs descriptifs

- `User` / `Declarant`
  - identifiant stable `sourceId = dropt-par-2026-2027-declarant-*`
  - clé déclarant priorisée par SIRET, sinon nom, sinon email, sinon ligne
  - email applicatif synthétique `@import.local` pour éviter de fusionner deux déclarants qui partageraient un email de contact
  - emails réels ajoutés dans `UserEmailAlias` quand ils sont valides et disponibles
  - type `LEGAL_PERSON` si SIRET ou mot-clé juridique, sinon `NATURAL_PERSON`
  - accès au type de déclaration `template-file` activé comme dans les imports BLV template

- `DeclarantPointPrelevement`
  - identifiant stable `sourceId = dropt-par-2026-2027-exploitation-*`
  - type `PRELEVEUR_DECLARANT`
  - usage `IRRIGATION`
  - statut dérivé des colonnes `ACTIVITE DU POINT 2025`, `ACTIVITE DU POINT 2024` et `ACTION`

## Coordonnées / SRID

L'exploration de l'onglet montre que la très grande majorité des coordonnées sont en Lambert-93 (`EPSG:2154`), avec quelques anomalies de saisie. Le helper `scripts/dropt/lib/dropt-data.js` teste et valide les coordonnées dans une emprise WGS84 approximative du bassin Dropt avant insertion :

- Lambert-93 `EPSG:2154`
- WGS84 `EPSG:4326`, y compris les cas latitude/longitude inversés
- Conique Conforme 44 `EPSG:3944` pour une ligne manifestement dans ce système
- Web Mercator `EPSG:3857` pour une ligne manifestement dans ce système
- corrections simples d'ordonnée avec facteur 10 ou chiffre en trop

Si aucune hypothèse ne retombe dans l'emprise Dropt approximative, le point est importé sans géométrie et un warning est émis. Après insertion, les liens `PointPrelevementZone` sont recalculés avec les géométries `Zone`; un warning est également émis lorsqu'aucune zone SAGE ne contient le point.

## Données volontairement non importées

Les compteurs et volumes détaillés sont conservés dans les champs de commentaire des points/exploitations, mais ne sont pas importés dans `Compteur`, `ResourceRule` ou les déclarations de volumes. Le fichier PAR contient des informations agrégées et des numéros de compteurs parfois ambigus ; les importer comme objets métier séparés mériterait une passe dédiée.
