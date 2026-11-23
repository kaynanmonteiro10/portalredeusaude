"""Baixa o faturamento do S4E uma vez e guarda em .s4e_faturamento_cache.json."""
import datetime, json, sys
import portal_server as ps
import s4e_connector as s4e
import adesoes_conferencia as ac

inicio = datetime.date.fromisoformat(sys.argv[1]) if len(sys.argv) > 1 else datetime.date(2026, 1, 1)
fim = datetime.date.fromisoformat(sys.argv[2]) if len(sys.argv) > 2 else datetime.date.today()

cred = ps.s4e_saved_credentials()
s4e.connect(cred[0], cred[1])
sessao = s4e.ensure_session()
print("baixando", inicio, "a", fim, flush=True)
linhas = s4e.fetch_faturamento_rows(sessao, inicio.strftime("%d/%m/%Y"), fim.strftime("%d/%m/%Y"))
print("linhas:", len(linhas), flush=True)
arquivo = ac.ROOT / ".s4e_faturamento_cache.json"
arquivo.write_text(json.dumps({"inicio": inicio.isoformat(), "fim": fim.isoformat(), "linhas": linhas}), encoding="utf-8")
print("salvo em", arquivo, flush=True)
