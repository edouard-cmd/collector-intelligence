# Collector Intelligence

Plateforme privée de suivi de valeur pour collections personnelles.
Mission Cobound. Bloc 1 en cours : faisabilité des sources et cadrage.
Livraison prévue mi-septembre 2026.

## Contenu

- `docs/schema.html` — schéma d'architecture, source unique de vérité.
  Trois niveaux : plan d'ensemble, zoom routeur d'univers, zoom catalogue
  et adaptateurs. Contient aussi les trous ouverts et le journal des versions.

## Convention de travail

Les blocs du plan d'ensemble sont numérotés de 1 à 11, les sorties
parallèles suffixées (8a, 8b, 8c). On désigne un bloc par son numéro.

Un commit par version du schéma. Le message de commit reprend la ligne
correspondante du journal, en bas du fichier.

Les modifications se font par remplacement de bloc, pas par réécriture
complète, une fois la structure stabilisée.

## État

Le schéma évolue à chaque faille identifiée. La section « trous ouverts »
liste ce qui est connu et non encore traité — elle se vide au fil des
versions, elle ne doit jamais être supprimée.
