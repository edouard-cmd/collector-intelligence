# Collector Intelligence

Plateforme privée de suivi de valeur pour collections personnelles.
Mission Cobound. Bloc 1 en cours : faisabilité des sources et cadrage.
Livraison prévue mi-septembre 2026.

## Contenu

- `docs/schema.html` : schéma d'architecture, source unique de vérité.
  Trois niveaux : plan d'ensemble, zoom routeur d'univers, zoom catalogue
  et adaptateurs. Contient aussi les trous ouverts et le journal des versions.
- `docs/atelier.html` : l'atelier, estimation d'un objet à partir de photos.
- `docs/espace.html` : l'espace collectionneur, derrière une connexion Google. Collection,
  veille quotidienne des ventes conclues, cote sur douze mois, tendance et projection,
  anomalies expliquées, paliers, e-mails, enchères suivies, tableau de bord.
- `passerelle/espace-worker.js` : le coffre de l'espace (worker Cloudflare et base D1).
  Installation pas à pas, sans Terminal : `passerelle/INSTALLATION.md`.

## Convention de travail

Les blocs du plan d'ensemble sont numérotés de 1 à 11, les sorties
parallèles suffixées (8a, 8b, 8c). On désigne un bloc par son numéro.

Un commit par version du schéma. Le message de commit reprend la ligne
correspondante du journal, en bas du fichier.

Les modifications se font par remplacement de bloc, pas par réécriture
complète, une fois la structure stabilisée.

## État

Le schéma évolue à chaque faille identifiée. La section « trous ouverts »
liste ce qui est connu et non encore traité : elle se vide au fil des
versions, elle ne doit jamais être supprimée.
