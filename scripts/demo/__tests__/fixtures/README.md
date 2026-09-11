# Ancres géographiques synthétiques

`synthetic-location-anchors.csv` contient seize coordonnées inventées sur une
grille de 0,05 degré à l'intérieur des géométries publiques départementales et
du SAGE utilisées par le générateur. Chaque coordonnée figure pour les deux
types de milieu. Aucun point réel ni fichier du sous-module privé n'est copié.

Les coordonnées sont encodées au format historique attendu par le lecteur :
EWKB little-endian, point avec SRID 32740, transformé depuis WGS84 avec `proj4`.
Les codes `26000` et `38000` sont synthétiques ; seul le préfixe départemental
est utilisé par ces tests.

Coordonnées WGS84 (longitude, latitude) :

```text
38 : (4.80, 45.30), (5.35, 45.30), (5.00, 45.35), (5.30, 45.35),
     (5.00, 45.40), (5.30, 45.40), (5.25, 45.45), (5.40, 45.50)
26 : (4.85, 45.20), (4.90, 45.25), (4.95, 45.25), (5.05, 45.25),
     (5.10, 45.25), (4.90, 45.30), (4.95, 45.30), (5.05, 45.30)
```

Le helper de test choisit explicitement cette référence. Le comportement par
défaut du générateur reste inchangé : une référence absente provoque une erreur,
sans remplacement automatique par les données de test.
