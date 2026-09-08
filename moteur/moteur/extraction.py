"""
Étage 4 — extraction. Le modèle lit une page qu'il n'a jamais vue et la ramène
au format pivot.

C'est ce qui remplace un parseur par plateforme. Le coût marginal d'un nouveau
site tombe à zéro : on ne code rien, on lit.

Traitement par paquets pour amortir l'instruction sur plusieurs pages.
"""

from __future__ import annotations

from .collecte import Page
from .ia import IA
from .pivot import Annonce, Recolte, Vente

INSTRUCTION = """\
Tu extrais des transactions depuis le texte brut de pages de places de marché.

Ne retiens comme VENTE que ce qui est explicitement conclu : vendu, adjugé,
sold, transaction terminée avec un prix effectif. Un prix affiché sur une offre
en cours n'est PAS une vente.

Ne retiens comme ANNONCE que les offres en cours. Elles servent à mesurer la
liquidité, jamais à établir une valeur.

Pour chaque ligne, l'url_source doit pointer vers l'élément lui-même quand la
page la donne, sinon vers l'URL de la page fournie. Une ligne sans url_source
est inutilisable : ne la produis pas.

N'invente aucun prix, aucune date, aucun état. Un champ absent vaut null.
Si la page ne contient aucune transaction exploitable, retourne des listes vides.

Format :
{"ventes": [{"objet": "...", "prix": 0.0, "devise": "EUR",
  "date_vente": "AAAA-MM-JJ ou null", "plateforme": "...", "url_source": "...",
  "etat": "... ou null", "maille": "unite|lot|serie|scelle"}],
 "annonces": [{"objet": "...", "prix_demande": 0.0, "devise": "EUR",
  "plateforme": "...", "url_source": "...", "jours_en_ligne": null,
  "exemplaires_vendus": null, "suiveurs": null}]}
"""

MODELE = "claude-haiku-4-5-20251001"  # tâche mécanique, volume : le moins cher
CAR_MAX = 14000  # par page, pour ne pas payer de la navigation inutile


def extraire(ia: IA, pages: list[Page], par_lot: int = 3) -> Recolte:
    recolte = Recolte()

    for i in range(0, len(pages), par_lot):
        lot = pages[i : i + par_lot]
        message = "\n\n".join(
            f"=== PAGE {n + 1} ===\n"
            f"plateforme : {p.plateforme}\n"
            f"nature attendue : {p.nature}\n"
            f"url : {p.url}\n\n{p.texte[:CAR_MAX]}"
            for n, p in enumerate(lot)
        )
        try:
            d = ia.json(INSTRUCTION, message, modele=MODELE, max_tokens=8000)
        except ValueError:
            continue  # lot illisible : on avance, la saturation compensera

        recolte.pages_lues += len(lot)
        for v in d.get("ventes", []) or []:
            try:
                recolte.ventes.append(Vente(**v))
            except TypeError:
                pass
        for a in d.get("annonces", []) or []:
            try:
                recolte.annonces.append(Annonce(**a))
            except TypeError:
                pass

    recolte.cout_eur = ia.c.cout_eur
    return recolte
