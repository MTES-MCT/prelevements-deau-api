# Aperçu général du validateur

## Pourquoi ce validateur ?

Le validateur a été développé pour rapprocher les fichiers transmis via Démarches Simplifiées du contenu saisi dans le formulaire. Les objectifs principaux sont :

- garantir que le fichier fourni correspond bien à l’un des modèles partagés avec les préleveurs ;
- bloquer les incohérences qui empêcheraient l’import (dates invalides, valeurs négatives, métadonnées absentes, etc.) ;
- distinguer clairement les erreurs bloquantes des avertissements non bloquants ;
- documenter précisément quelles données ont été retenues ou écartées afin d’aider l’usager et l’instructeur.

## Pipeline de validation

1. **Ouverture du fichier** — prise en charge des formats `xls`, `xlsx` et `ods`, avec gestion des fichiers corrompus.
2. **Contrôle structurel** — vérification des feuilles attendues, des en-têtes et de la présence d’au moins une ligne exploitable.
3. **Validation métier** — vérifications fines par type de fichier (métadonnées, pas de temps, plages de dates, doublons, cohérence des unités…).
4. **Consolidation** — normalisation des données valides en séries temporelles (`series[]`) et collecte des informations intermédiaires dans `rawData`.
5. **Déduplication** — suppression des doublons temporels dans chaque série, accompagnée d’un avertissement global lorsqu’un nettoyage est effectué.

Chaque étape peut ajouter des messages de validation, toujours encapsulés dans la propriété `errors`.

## Structure du retour

- `data.series[]` regroupe les séries prêtes à être exploitées : chaque entrée expose l’identifiant du point de prélèvement, le paramètre mesuré, l’unité, la fréquence, la nature de la valeur (`valueType`) ainsi que les bornes temporelles (`minDate`, `maxDate`).
- `rawData` contient les éléments intermédiaires : métadonnées issues des onglets, lignes interprétées, en-têtes normalisés, etc. Cette structure facilite le diagnostic en cas d’erreur et permet des traitements spécifiques côté application.
- `errors[]` référence les erreurs et avertissements. Un message peut inclure une `explanation` destinée à l’utilisateur et, parfois, un `internalMessage` utile pour la traçabilité technique.

## Niveaux de sévérité

- `error` : l’anomalie bloque l’exploitation du fichier ou d’un paramètre particulier. L’appelant est invité à interrompre l’import ou à demander une correction.
- `warning` : l’information est incomplète mais le reste des données demeure exploitable. C’est le cas, par exemple, lorsqu’une valeur est manquante sans remarque associée ou lorsque des doublons ont été nettoyés.

## Gestion des versions de templates

Les modèles Excel ont évolué : intitulés ajustés, fréquences reformulées, unités écrites différemment, espacements variables, etc. Le code applique plusieurs stratégies pour rester compatible avec ces déclinaisons :

- normalisation systématique des noms d’onglet `Data | T=…` (espaces multiples, casse, ponctuation) ;
- tolérance sur certaines orthographes (`15 min`, `15mn`, `15m`, `1jour`, `jour`, etc.) ;
- conversion des unités en minuscules sans caractères spéciaux pour accepter à la fois `µS/cm` et `uS/cm`, ou `degrés` ↔ `degres` ;
- lecture des dates/heures à partir de valeurs Excel ou de chaînes textuelles variées (format français, format ISO, saisies manuelles) ;
- agrégation des erreurs répétées (ex. dizaines de lignes invalides) en un seul message pour faciliter la lecture.

Lorsqu’un élément ne peut pas être reconnu malgré ces normalisations, l’erreur générée précise la valeur rencontrée et la forme attendue.

## Ajouter une nouvelle variante de template

1. Reproduire le cas via un fichier de test dans `lib/**/__tests__/test-files`.
2. Identifier la règle à assouplir ou à étendre (par exemple, un nouvel intitulé de colonne ou une unité supplémentaire).
3. Adapter la logique de parsing ou la liste des valeurs autorisées.
4. Ajouter ou mettre à jour un test automatisé.
5. Documenter la nouvelle règle dans le fichier spécifique (`docs/camion-citerne.md` ou `docs/multi-param.md`) ainsi que dans [`docs/validation.md`](validation.md) si elle introduit un message différent.

Cette démarche garantit que le validateur reste aligné avec les évolutions des formulaires DS tout en préservant la traçabilité des règles métier.
