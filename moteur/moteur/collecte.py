"""
Étage 3 — la pagination. Aucun appel IA ici, donc aucun coût par page.

C'est cet étage qui fait passer de 4 résultats à 300 : il déroule chaque point
d'entrée jusqu'à épuisement au lieu de se contenter de la première page.

Le collecteur est générique : il ne sait pas quel site il lit. Il applique un
modèle d'URL, récupère le texte, et s'arrête quand la page n'apporte plus rien.
"""

from __future__ import annotations

import re
import time
import urllib.parse
import urllib.robotparser as robotparser
from dataclasses import dataclass

import httpx

UA = "CollectorIntelligence/0.1 (veille de cotation; contact via le repo)"


@dataclass
class Page:
    plateforme: str
    nature: str  # ventes | annonces
    url: str
    texte: str


class Collecteur:
    def __init__(self, delai: float = 1.5, timeout: float = 20.0):
        self.delai = delai
        self.client = httpx.Client(
            headers={"User-Agent": UA, "Accept-Language": "fr,en;q=0.8"},
            timeout=timeout,
            follow_redirects=True,
        )
        self._robots: dict[str, robotparser.RobotFileParser] = {}

    # ---------- politesse ----------

    def autorise(self, url: str) -> bool:
        """Respect de robots.txt. Un refus n'est pas une erreur, c'est une
        limite de couverture à documenter côté client."""
        p = urllib.parse.urlparse(url)
        racine = f"{p.scheme}://{p.netloc}"
        if racine not in self._robots:
            rp = robotparser.RobotFileParser()
            rp.set_url(racine + "/robots.txt")
            try:
                rp.read()
            except Exception:
                rp = None
            self._robots[racine] = rp
        rp = self._robots[racine]
        return True if rp is None else rp.can_fetch(UA, url)

    # ---------- lecture ----------

    def lire(self, url: str) -> str | None:
        if not self.autorise(url):
            return None
        try:
            r = self.client.get(url)
            if r.status_code != 200:
                return None
            return _texte_utile(r.text)
        except Exception:
            return None
        finally:
            time.sleep(self.delai)

    def parcourir(self, entree: dict, terme: str, pages_max: int | None = None) -> list[Page]:
        """Déroule un point d'entrée page par page jusqu'à épuisement.

        Arrêt sur : plus de contenu, page identique à la précédente, ou
        plafond de pages. Le plafond vient du profil, pas du code.
        """
        pages: list[Page] = []
        modele = entree["url_modele"]
        debut = int(entree.get("page_debut", 1))
        plafond = pages_max or int(entree.get("pages_max", 20))
        empreinte_prec = None

        for n in range(debut, debut + plafond):
            url = modele.replace("{q}", urllib.parse.quote_plus(terme)).replace(
                "{page}", str(n)
            )
            texte = self.lire(url)
            if not texte or len(texte) < 400:
                break
            empreinte = hash(texte[:3000])
            if empreinte == empreinte_prec:
                break  # la plateforme resert la même page : fin de liste
            empreinte_prec = empreinte
            pages.append(
                Page(
                    plateforme=entree["plateforme"],
                    nature=entree.get("nature", "ventes"),
                    url=url,
                    texte=texte,
                )
            )
        return pages


def _texte_utile(html: str) -> str:
    """Réduit le HTML à son texte. Volontairement grossier : c'est le modèle
    qui interprète, pas nous. Un parseur fin serait du code par plateforme."""
    html = re.sub(r"(?is)<(script|style|noscript|svg|head).*?</\1>", " ", html)
    html = re.sub(r"(?s)<!--.*?-->", " ", html)
    html = re.sub(r"(?i)<(br|/p|/div|/li|/tr)>", "\n", html)
    texte = re.sub(r"<[^>]+>", " ", html)
    texte = re.sub(r"&nbsp;?", " ", texte)
    texte = re.sub(r"[ \t\xa0]+", " ", texte)
    texte = re.sub(r"\n\s*\n+", "\n", texte)
    return texte.strip()
