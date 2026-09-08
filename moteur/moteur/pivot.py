"""
Format pivot — le seul schéma de données du système.

Toute source, quelle qu'elle soit, est ramenée ici. Aucun autre module n'a le
droit de définir sa propre forme de donnée. C'est ce qui permet d'ajouter une
plateforme ou un univers sans toucher au reste.

Règle dure : une vente sans url_source n'entre pas dans la cote. Si le moteur
ne peut pas produire l'URL, il ne produit pas le chiffre.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field, asdict
from datetime import date
from typing import Optional


@dataclass
class Vente:
    """Une transaction conclue. Entre dans la cote."""

    objet: str  # libellé tel qu'affiché par la plateforme
    prix: float
    devise: str  # ISO 4217
    date_vente: Optional[str]  # AAAA-MM-JJ
    plateforme: str
    url_source: str
    etat: Optional[str] = None
    maille: str = "unite"  # unite | lot | serie | scelle
    conclue: bool = True

    def cle(self) -> str:
        """Empreinte de déduplication.

        Deux annonces différentes peuvent décrire la même transaction. On
        déduplique sur l'URL quand elle est stable, sinon sur le triplet
        libellé normalisé + prix + date.
        """
        if self.url_source:
            base = self.url_source.split("?")[0].rstrip("/")
        else:
            libelle = re.sub(r"[^a-z0-9]+", "", self.objet.lower())
            base = f"{libelle}|{self.prix}|{self.date_vente}"
        return hashlib.sha1(base.encode()).hexdigest()[:16]

    def valide(self) -> tuple[bool, str]:
        if not self.url_source:
            return False, "pas d'url source"
        if self.prix is None or self.prix <= 0:
            return False, "prix absent ou nul"
        if len(self.devise or "") != 3:
            return False, "devise non ISO"
        if self.date_vente and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", self.date_vente):
            return False, "date mal formée"
        return True, ""

    def dict(self) -> dict:
        return asdict(self)


@dataclass
class Annonce:
    """Une offre active. N'entre JAMAIS dans la cote.

    Sert uniquement à mesurer la liquidité : rotation, profondeur d'intérêt,
    écart annonce-cote. Bloc 6 du schéma, ajout v5.
    """

    objet: str
    prix_demande: float
    devise: str
    plateforme: str
    url_source: str
    jours_en_ligne: Optional[int] = None
    exemplaires_vendus: Optional[int] = None
    suiveurs: Optional[int] = None

    def cle(self) -> str:
        return hashlib.sha1(self.url_source.split("?")[0].encode()).hexdigest()[:16]

    def rotation(self) -> Optional[float]:
        """Ventes par jour d'exposition. Le détecteur d'anomalie principal."""
        if self.exemplaires_vendus is None or not self.jours_en_ligne:
            return None
        return self.exemplaires_vendus / self.jours_en_ligne


@dataclass
class Recolte:
    """Ce que rapporte une passe de collecte."""

    ventes: list[Vente] = field(default_factory=list)
    annonces: list[Annonce] = field(default_factory=list)
    pages_lues: int = 0
    cout_eur: float = 0.0

    def fusionner(self, autre: "Recolte") -> "Recolte":
        vues = {v.cle() for v in self.ventes}
        for v in autre.ventes:
            if v.cle() not in vues:
                self.ventes.append(v)
                vues.add(v.cle())
        vues_a = {a.cle() for a in self.annonces}
        for a in autre.annonces:
            if a.cle() not in vues_a:
                self.annonces.append(a)
                vues_a.add(a.cle())
        self.pages_lues += autre.pages_lues
        self.cout_eur += autre.cout_eur
        return self

    def nettoyer(self) -> list[str]:
        """Écarte les ventes non conformes. Retourne les motifs de rejet."""
        gardees, rejets = [], []
        for v in self.ventes:
            ok, motif = v.valide()
            if ok:
                gardees.append(v)
            else:
                rejets.append(f"{v.objet[:40]} — {motif}")
        self.ventes = gardees
        return rejets
