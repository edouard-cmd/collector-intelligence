"""
Orchestration. Deux régimes, comme le bloc 4 du schéma.

ouvrir()  — passe profonde, une fois par objet. Ratisse tout l'historique
            disponible jusqu'à saturation. Chère, mais unique.
passer()  — passe mensuelle. Rejoue les points d'entrée déjà gravés, ne
            cherche que ce qui est apparu depuis. Une fraction du coût.

Le profil gravé entre les deux est ce qui rend le mensuel bon marché.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

from .collecte import Collecteur
from .decouverte import profiler
from .extraction import extraire
from .ia import IA, BudgetDepasse
from .pivot import Recolte
from .saturation import Saturation

PROFILS = Path("profils")


def _fichier(objet_id: str) -> Path:
    PROFILS.mkdir(exist_ok=True)
    return PROFILS / f"{objet_id}.json"


def ouvrir(
    objet_id: str,
    description: str,
    budget_eur: float = 8.0,
    pages_par_requete: int = 10,
) -> dict:
    """Passe profonde. Découvre, ratisse jusqu'à saturation, grave le profil."""

    ia = IA(budget_eur=budget_eur)
    collecteur = Collecteur()
    sat = Saturation()
    recolte = Recolte()

    profil = profiler(ia, description)

    if not profil["entrees"]:
        profil.update(
            cas=3,
            verdict="hors couverture",
            motif=profil.get("hors_couverture", "aucune source publique cotable"),
            cout_total_eur=round(ia.c.cout_eur, 3),
        )
        _fichier(objet_id).write_text(json.dumps(profil, ensure_ascii=False, indent=1))
        return profil

    try:
        for req in profil["requetes"]:
            if not sat.continuer():
                break
            pages = []
            for entree in profil["entrees"]:
                pages += collecteur.parcourir(entree, req["terme"], pages_par_requete)
            if not pages:
                sat.integrer(req["terme"], [])
                continue
            r = extraire(ia, pages)
            r.nettoyer()
            sat.integrer(req["terme"], [v.cle() for v in r.ventes])
            recolte.fusionner(r)
    except BudgetDepasse as e:
        profil["budget"] = str(e)

    profil.update(
        objet_id=objet_id,
        derniere_passe=date.today().isoformat(),
        couverture=sat.rapport(),
        ventes=[v.dict() for v in recolte.ventes],
        liquidite=_liquidite(recolte),
        cas=_cas(recolte),
        cout_total_eur=round(ia.c.cout_eur, 3),
        pages_lues=recolte.pages_lues,
    )
    # On ne garde que les requêtes qui ont produit : c'est ce qui allège le mensuel.
    productives = {p["terme"] for p in sat.passes if p["nouvelles"] > 0}
    profil["requetes_retenues"] = [
        r for r in profil["requetes"] if r["terme"] in productives
    ]
    _fichier(objet_id).write_text(json.dumps(profil, ensure_ascii=False, indent=1))
    return profil


def passer(objet_id: str, budget_eur: float = 1.5, pages_par_requete: int = 3) -> dict:
    """Passe mensuelle. Rejoue les requêtes retenues, sur peu de pages."""

    profil = json.loads(_fichier(objet_id).read_text())
    if profil.get("cas") == 3:
        return profil

    ia = IA(budget_eur=budget_eur)
    collecteur = Collecteur()
    recolte = Recolte()
    connues = {v["url_source"] for v in profil.get("ventes", [])}

    try:
        for req in profil.get("requetes_retenues") or profil["requetes"][:5]:
            pages = []
            for entree in profil["entrees"]:
                pages += collecteur.parcourir(entree, req["terme"], pages_par_requete)
            if pages:
                r = extraire(ia, pages)
                r.nettoyer()
                recolte.fusionner(r)
    except BudgetDepasse:
        pass

    nouvelles = [v for v in recolte.ventes if v.url_source not in connues]
    profil["ventes"] = profil.get("ventes", []) + [v.dict() for v in nouvelles]
    profil["derniere_passe"] = date.today().isoformat()
    profil["liquidite"] = _liquidite(recolte)
    profil["dernier_apport"] = len(nouvelles)
    profil["cout_derniere_passe_eur"] = round(ia.c.cout_eur, 3)
    _fichier(objet_id).write_text(json.dumps(profil, ensure_ascii=False, indent=1))
    return profil


# ---------- lecture des signaux ----------

def _liquidite(r: Recolte) -> dict:
    """Bloc 6, ajout v5. Trois champs, aucun n'est un prix."""
    rots = [a.rotation() for a in r.annonces if a.rotation() is not None]
    suiveurs = [a.suiveurs for a in r.annonces if a.suiveurs is not None]
    return {
        "ventes_conclues": len(r.ventes),
        "annonces_actives": len(r.annonces),
        "rotation_mediane": round(sorted(rots)[len(rots) // 2], 5) if rots else None,
        "suiveurs_median": sorted(suiveurs)[len(suiveurs) // 2] if suiveurs else None,
    }


def _cas(r: Recolte) -> int:
    """Cas 1 automatisable, 2 assisté, 3 hors couverture. Bloc 8 du schéma."""
    n = len(r.ventes)
    if n >= 12:
        return 1
    if n >= 3:
        return 2
    return 3
