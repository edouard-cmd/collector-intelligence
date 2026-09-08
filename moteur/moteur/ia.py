"""
Le seul endroit du système qui parle à un modèle.

Deux raisons : pouvoir compter le coût réel à l'euro près, et pouvoir couper
net quand le budget d'un profil est atteint. Aucun autre module n'importe le
SDK.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass

import anthropic

# Tarifs $/million de tokens. À réajuster : le moteur affiche le coût réel,
# donc une erreur ici se voit tout de suite au premier profil.
TARIFS = {
    "claude-sonnet-5": (3.0, 15.0),
    "claude-haiku-4-5-20251001": (1.0, 5.0),
}
USD_EUR = 0.92
COUT_RECHERCHE_WEB = 0.01  # par requête


class BudgetDepasse(RuntimeError):
    pass


@dataclass
class Compteur:
    entree: int = 0
    sortie: int = 0
    recherches: int = 0
    cout_eur: float = 0.0


class IA:
    def __init__(self, budget_eur: float = 10.0, cle: str | None = None):
        self.client = anthropic.Anthropic(api_key=cle or os.environ["ANTHROPIC_API_KEY"])
        self.budget = budget_eur
        self.c = Compteur()

    # ---------- comptabilité ----------

    def _facturer(self, modele: str, usage, recherches: int = 0) -> None:
        e, s = TARIFS.get(modele, (3.0, 15.0))
        cout = (usage.input_tokens * e + usage.output_tokens * s) / 1e6
        cout = cout * USD_EUR + recherches * COUT_RECHERCHE_WEB * USD_EUR
        self.c.entree += usage.input_tokens
        self.c.sortie += usage.output_tokens
        self.c.recherches += recherches
        self.c.cout_eur += cout
        if self.c.cout_eur > self.budget:
            raise BudgetDepasse(
                f"budget de {self.budget:.2f} € atteint "
                f"({self.c.cout_eur:.2f} € consommés)"
            )

    # ---------- appels ----------

    def json(
        self,
        instruction: str,
        message: str,
        modele: str = "claude-sonnet-5",
        recherche_web: bool = False,
        max_tokens: int = 4000,
    ) -> dict | list:
        """Un appel, une réponse JSON. Le seul mode de dialogue du moteur.

        On force le JSON parce que toute sortie du modèle doit être une
        structure exploitable, jamais de la prose à réinterpréter.
        """
        outils = []
        if recherche_web:
            outils = [{"type": "web_search_20250305", "name": "web_search", "max_uses": 8}]

        rep = self.client.messages.create(
            model=modele,
            max_tokens=max_tokens,
            system=instruction + "\n\nRéponds uniquement par du JSON valide, "
                                 "sans préambule ni balises de code.",
            messages=[{"role": "user", "content": message}],
            tools=outils or anthropic.NOT_GIVEN,
        )

        recherches = sum(
            1 for b in rep.content if getattr(b, "type", "") == "server_tool_use"
        )
        self._facturer(modele, rep.usage, recherches)

        texte = "\n".join(
            b.text for b in rep.content if getattr(b, "type", "") == "text"
        )
        return _extraire_json(texte)


def _extraire_json(texte: str):
    texte = texte.strip()
    texte = re.sub(r"^```(?:json)?|```$", "", texte, flags=re.M).strip()
    try:
        return json.loads(texte)
    except json.JSONDecodeError:
        # Le modèle a parfois bavardé autour. On récupère le premier objet
        # ou tableau équilibré plutôt que d'échouer.
        for ouvre, ferme in (("[", "]"), ("{", "}")):
            d = texte.find(ouvre)
            f = texte.rfind(ferme)
            if d != -1 and f > d:
                try:
                    return json.loads(texte[d : f + 1])
                except json.JSONDecodeError:
                    continue
        raise ValueError(f"réponse non parsable : {texte[:200]}")
