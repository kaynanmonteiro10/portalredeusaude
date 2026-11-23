"""Vidas ATIVAS do plano de odonto, por empresa, direto do S4E."""
import json, time
import s4e_connector as s4e
import s4e_usuarios
import portal_server as ps

EMPRESAS = {"5353":"TAKE A JUICE RIOMAR","5355":"TAKE A JUICE IGUATEMI","5305":"CHA DE PRAIA",
            "702425":"JESSICA","702426":"JESSICA2"}

session = s4e_usuarios.open_session(ps.s4e_saved_credentials())
resultado = {}
for codigo, rotulo in EMPRESAS.items():
    try:
        linhas = s4e_usuarios.fetch_company_associates(session, codigo)
    except Exception as e:
        print(f"  {rotulo:20s} ERRO {str(e)[:60]}")
        continue
    od = [l for l in linhas if "ODONTOLOGIA" in (l.get("centro") or "").upper()]
    resultado[codigo] = {"rotulo": rotulo, "total": len(linhas), "odonto": len(od), "vidas": od}
    print(f"  {rotulo:20s} total={len(linhas):4d} odonto={len(od):3d}")
    time.sleep(0.3)
json.dump(resultado, open("_odonto_empresas.json","w",encoding="utf-8"), ensure_ascii=False, indent=1)
print("salvo")
