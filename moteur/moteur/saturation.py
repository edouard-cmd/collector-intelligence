"""
Le critère d'arrêt.

On ne s'arrête pas à un nombre de résultats — « cent ventes » ne veut rien dire
et cache le cas où la vérité est zéro. On s'arrête quand une nouvelle variante
de requête n'apporte plus de transactions que les précédentes n'avaient pas
déjà ramenées.

Rend « le plus profond possible » mesurable, et produit l'indicateur de
couverture affiché en sortie.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Saturation:
    seuil: float = 0.05  # sous 5 % d'apport nouveau, on coupe
    patience: int = 2  # nombre de requêtes maigres tolérées d'affilée
    mini: int = 3  # jamais moins de 3 requêtes avant de conclure

    _vues: set[str] = field(default_factory=set)
    _maigres: int = 0
    passes: list[dict] = field(default_factory=list)

    def integrer(self, terme: str, cles: list[str]) -> float:
        """Enregistre une passe. Retourne le taux d'apport nouveau."""
        nouvelles = [c for c in cles if c not in self._vues]
        taux = len(nouvelles) / len(cles) if cles else 0.0
        self._vues.update(nouvelles)

        self.passes.append(
            {
                "terme": terme,
                "ramenees": len(cles),
                "nouvelles": len(nouvelles),
                "taux_nouveaute": round(taux, 3),
                "cumul": len(self._vues),
            }
        )
        self._maigres = self._maigres + 1 if taux < self.seuil else 0
        return taux

    def continuer(self) -> bool:
        if len(self.passes) < self.mini:
            return True
        return self._maigres < self.patience

    def rapport(self) -> dict:
        return {
            "requetes_passees": len(self.passes),
            "transactions_uniques": len(self._vues),
            "saturation_atteinte": not self.continuer(),
            "detail": self.passes,
        }
