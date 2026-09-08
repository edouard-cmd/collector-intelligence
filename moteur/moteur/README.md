# Moteur de découverte et de collecte

Implémente les blocs 5 et 6 du schéma, et la grappe A. Deux régimes : une
ouverture profonde par objet, puis des passes mensuelles bon marché.

## Lancer

```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...

python run.py ouvrir musette-tango "Louis Vuitton Musette Tango, toile monogram, bandoulière longue, modèle arrêté"
python run.py passer musette-tango
```

## Le test de scalabilité

```bash
grep -rEic "ebay|vinted|leboncoin|catawiki|drouot|vestiaire|stockx" moteur/*.py
```

Doit rendre zéro. Aucune place de marché, aucun sélecteur, aucune regex de
site n'existe dans le code. Tout ce qui est spécifique à un univers vit dans
`profils/<objet>.json`, produit par l'IA. **Ajouter un univers coûte zéro
ligne de code.**

Si un jour ce grep rend autre chose que zéro, la promesse vendue à la cliente
est cassée : c'est le signal qu'on a recommencé à coder par plateforme.

## Les quatre étages

| Étage | Fichier | IA | Fréquence |
|---|---|---|---|
| 1. Expansion des requêtes | `decouverte.py` | oui | 1× par objet |
| 2. Découverte des points d'entrée | `decouverte.py` | oui | 1× par objet |
| 3. Pagination | `collecte.py` | **non** | à chaque passe |
| 4. Extraction vers le pivot | `extraction.py` | oui | à chaque passe |

L'étage 3 ne coûte rien : c'est lui qui fait passer de 4 résultats à 300, en
déroulant chaque point d'entrée jusqu'à épuisement au lieu de s'arrêter à la
première page.

## Ce qui ne passe jamais par l'IA

Le chiffre. Le modèle trouve où chercher, lit ce qu'il trouve, normalise —
il ne produit aucune valeur. Toute vente sans `url_source` est rejetée par
`pivot.nettoyer()`, et ce rejet n'est pas contournable.

## Critère d'arrêt

`saturation.py`. On ne s'arrête pas à un nombre de résultats — « cent ventes »
ne veut rien dire et masque le cas où la vérité est zéro. On s'arrête quand
une nouvelle variante de requête n'apporte plus que 5 % de transactions
inédites, deux fois de suite.

Le rapport de couverture (`profil["couverture"]`) est ce qu'on montre à la
cliente : requêtes passées, transactions uniques, saturation atteinte ou non.

## Sortie

`profils/<objet>.json` contient le profil gravé (univers, maille, requêtes
retenues, points d'entrée), les ventes avec leur URL, les trois champs de
liquidité, le cas 1/2/3, le coût réel en euros et le nombre de pages lues.

Les requêtes qui n'ont rien produit à l'ouverture ne sont pas rejouées le mois
suivant : c'est ce qui rend la passe mensuelle bon marché.

## Réglages

- `ouvrir(budget_eur=8.0)` — plafond dur, l'exécution s'arrête proprement au dépassement
- `Saturation(seuil=0.05, patience=2)` — agressivité de l'arrêt
- `Collecteur(delai=1.5)` — délai entre requêtes, à ne pas descendre

`robots.txt` est respecté. Un refus n'est pas une erreur : c'est une limite de
couverture à documenter côté client.
