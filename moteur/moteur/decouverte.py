"""
Étages 1 et 2 — la phase chère, exécutée une fois par profil d'objet.

Sortie : un profil JSON qui contient tout ce qui est spécifique à cet objet
et à son univers. C'est le seul endroit où vivent les noms de plateformes et
les URL de recherche. Le code, lui, n'en connaît aucun.

Aucun fichier du moteur ne cite de place de marché. C'est le test de
scalabilité : un grep sur les noms de plateformes doit rendre zéro.
"""

from __future__ import annotations

from .ia import IA

INSTRUCTION_REQUETES = """\
Tu prépares la surveillance d'un objet de collection sur les marchés secondaires.

Produis les variantes de requête sous lesquelles cet objet est réellement mis
en vente par des vendeurs, pas les termes d'un catalogue officiel. Couvre les
appellations commerciales, les références internes ou codes modèle, les fautes
et abréviations courantes des vendeurs, et les langues des marchés où cet objet
s'échange vraiment.

Classe chaque variante par précision :
- "exacte" : ne ramène que cet objet
- "large" : ramène cet objet et des voisins, utile si le marché est mince

Format : {"maille": "unite|lot|serie|scelle", "univers": "...",
"requetes": [{"terme": "...", "langue": "fr", "precision": "exacte"}]}

Entre 15 et 30 variantes. Ordonne de la plus précise à la plus large.
"""

INSTRUCTION_ENTREES = """\
Tu identifies où un objet de collection s'échange réellement, et comment y lire
les VENTES CONCLUES — pas les annonces en cours.

Pour chaque place de marché pertinente, donne le modèle d'URL de recherche qui
filtre sur les transactions terminées, avec ses paramètres de pagination.
Utilise {q} pour le terme de recherche et {page} pour le numéro de page.

Distingue deux natures de source :
- "ventes" : la page liste des transactions conclues avec leur prix
- "annonces" : la page liste des offres en cours (sert à la liquidité, jamais à la cote)

Écarte les plateformes sans accès public, les espaces fermés type messagerie
communautaire, et les agrégateurs qui recopient d'autres sources.

Format : {"entrees": [{"plateforme": "...", "nature": "ventes|annonces",
"url_modele": "https://.../?q={q}&page={page}", "page_debut": 1,
"pages_max": 20, "note": "..."}]}

Si aucune source publique ne permet de coter cet objet, retourne
{"entrees": [], "hors_couverture": "raison en une phrase"}.
"""


def profiler(ia: IA, description: str) -> dict:
    """Construit le profil complet d'un objet. Étages 1 et 2 enchaînés."""

    req = ia.json(INSTRUCTION_REQUETES, description, recherche_web=True)

    contexte = (
        f"Objet : {description}\n"
        f"Univers : {req.get('univers')}\n"
        f"Maille : {req.get('maille')}\n"
        f"Termes de recherche retenus : "
        + ", ".join(r["terme"] for r in req.get("requetes", [])[:8])
    )
    ent = ia.json(INSTRUCTION_ENTREES, contexte, recherche_web=True)

    return {
        "description": description,
        "univers": req.get("univers"),
        "maille": req.get("maille", "unite"),
        "requetes": req.get("requetes", []),
        "entrees": ent.get("entrees", []),
        "hors_couverture": ent.get("hors_couverture"),
        "cout_decouverte_eur": round(ia.c.cout_eur, 3),
    }
