"""Teste: para uma empresa de odonto, o título da competência foi pago?"""
import s4e_connector as s4e
import s4e_usuarios
import portal_server as ps
import sqlite3

# 1) o que o banco tem de título para a empresa 57583649 (Francisca) e 5353
c = sqlite3.connect("portal.db"); c.row_factory = sqlite3.Row
run = c.execute("SELECT id FROM apuracao_runs WHERE competencia_label='Outubro/2026' AND status='done' ORDER BY finished_at DESC LIMIT 1").fetchone()
print("run outubro:", run["id"] if run else None)
for emp in ("FRANCISCA", "SUCOS", "JESSICA", "ARMAZEM", "FECOMERCIO"):
    rows = c.execute("""SELECT empresa, valor, vidas, valor_recebido, data_pagamento, situacao
        FROM apuracao_rows WHERE run_id=? AND UPPER(empresa) LIKE ?""", (run["id"], f"%{emp}%")).fetchall()
    for r in rows:
        print(f"  {r['empresa'][:46]:48s} faturado={r['valor']:>8.2f} vidas={r['vidas']:>3s} recebido={r['valor_recebido']:>8.2f} pgto={r['data_pagamento'] or '-'}")
    if not rows:
        print(f"  {emp:48s} -- SEM TÍTULO em outubro")
