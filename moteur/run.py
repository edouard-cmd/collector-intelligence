#!/usr/bin/env python3
"""
Lancement du moteur.

    export ANTHROPIC_API_KEY=sk-ant-...
    python run.py ouvrir musette-tango "Louis Vuitton Musette Tango, toile monogram, bandoulière longue, modèle arrêté"
    python run.py passer musette-tango
"""
import json
import os
import sys

from moteur import ouvrir, passer

BUDGET = float(os.environ.get("BUDGET_EUR", "8"))


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    action, objet_id = sys.argv[1], sys.argv[2]

    if action == "ouvrir":
        if len(sys.argv) < 4:
            print("il manque la description de l'objet")
            sys.exit(1)
        p = ouvrir(objet_id, sys.argv[3], budget_eur=BUDGET)
    elif action == "passer":
        p = passer(objet_id)
    else:
        print(__doc__)
        sys.exit(1)

    c = p.get("couverture", {})
    print(f"\nobjet        {objet_id}")
    print(f"univers      {p.get('univers')}   maille {p.get('maille')}")
    print(f"cas          {p.get('cas')}  {p.get('verdict') or ''} {p.get('motif') or ''}")
    print(f"plateformes  {len(p.get('entrees', []))}")
    print(f"requetes     {c.get('requetes_passees', '-')} passées, "
          f"saturation {'atteinte' if c.get('saturation_atteinte') else 'non atteinte'}")
    print(f"ventes       {len(p.get('ventes', []))} conclues avec URL")
    print(f"liquidite    {json.dumps(p.get('liquidite', {}), ensure_ascii=False)}")
    print(f"pages lues   {p.get('pages_lues', '-')}")
    print(f"cout         {p.get('cout_total_eur', p.get('cout_derniere_passe_eur'))} €")
    print(f"\nprofil grave dans profils/{objet_id}.json")


if __name__ == "__main__":
    main()
