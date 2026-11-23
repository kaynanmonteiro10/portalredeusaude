"""A importação oficial perde o centro de custo? Comparar com o meu parser direto."""
from datetime import date
import s4e_connector as s4e
import s4e_usuarios
import portal_server as ps

session = s4e_usuarios.open_session(ps.s4e_saved_credentials())
r = s4e_usuarios.fetch_users(session, date(2026,1,1), date(2026,11,30), escopo="all")
rows = r["rows"]
print("total:", len(rows))
print("com centro preenchido:", sum(1 for x in rows if (x.get("centro") or "").strip()))
print("com 'ODONTOLOGIA' no centro:", sum(1 for x in rows if "ODONTOLOGIA" in (x.get("centro") or "").upper()))
from collections import Counter
print("top centros:", Counter((x.get('centro') or '(vazio)') for x in rows).most_common(8))
