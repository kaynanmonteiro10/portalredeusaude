"""Teste: quantas vidas de odonto a importação oficial recupera, por situação."""
from datetime import date
import s4e_connector as s4e
import s4e_usuarios
import portal_server as ps
from collections import Counter

session = s4e_usuarios.open_session(ps.s4e_saved_credentials())
for rotulo, (ini, fim) in {
    "2026 (jan-nov)": (date(2026,1,1), date(2026,11,30)),
    "2023-2026": (date(2023,1,1), date(2026,11,30)),
}.items():
    try:
        r = s4e_usuarios.fetch_users(session, ini, fim, escopo="all")
    except Exception as e:
        print(f"{rotulo}: ERRO {str(e)[:70]}")
        continue
    rows = r["rows"]
    od = [x for x in rows if "ODONTOLOGIA" in (x.get("centro") or "").upper()]
    print(f"{rotulo}: total={len(rows)} | odonto={len(od)} | situações={dict(Counter(x['situacao'] for x in od))}")
