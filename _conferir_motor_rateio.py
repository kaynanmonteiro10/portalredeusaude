"""Confere o motor de rateio depois das mudanças: escopo, juros e cobertura."""
import importlib.util
import sqlite3
import sys
from collections import defaultdict

spec = importlib.util.spec_from_file_location("ps", "portal_server.py")
ps = importlib.util.module_from_spec(spec)
sys.modules["ps"] = ps
spec.loader.exec_module(ps)

db = sqlite3.connect("portal.db")
db.row_factory = sqlite3.Row
run = db.execute(
    "SELECT id FROM apuracao_runs WHERE status='done' ORDER BY finished_at DESC LIMIT 1"
).fetchone()[0]
rows = db.execute("SELECT * FROM apuracao_rows WHERE run_id=?", (run,)).fetchall()
regras = db.execute("SELECT * FROM rateio_rules").fetchall()
ativas = [r for r in regras if r["ativo"]]

print("=" * 62)
print("1. ESCALA DE PRIORIDADE")
print("=" * 62)
exemplo = [
    {"grupo": "G", "grupo_empresa": "", "empresa": "", "recebedor": "CENTRO",
     "metodo": "por_vida", "valor": 1, "ativo": 1, "encargos": "rateio",
     "encargos_recebedor": "", "nivel": 1},
    {"grupo": "G", "grupo_empresa": "SUB", "empresa": "", "recebedor": "GRUPO",
     "metodo": "por_vida", "valor": 1, "ativo": 1, "encargos": "rateio",
     "encargos_recebedor": "", "nivel": 2},
    {"grupo": "G", "grupo_empresa": "", "empresa": "EMPRESA X", "recebedor": "EMPRESA",
     "metodo": "por_vida", "valor": 1, "ativo": 1, "encargos": "rateio",
     "encargos_recebedor": "", "nivel": 3},
]
casos = [
    ("empresa específica", ("G", "SUB", "EMPRESA X"), ["EMPRESA"]),
    ("grupo específico", ("G", "SUB", "EMPRESA Y"), ["GRUPO"]),
    ("centro de custo", ("G", "OUTRO", "EMPRESA Y"), ["CENTRO"]),
]
for nome, args, esperado in casos:
    obtido = [r["recebedor"] for r in ps.rules_for_line(exemplo, *args)]
    marca = "ok" if obtido == esperado else "FALHOU"
    print(f"  {nome:22s} -> {obtido}  [{marca}]")

print()
print("=" * 62)
print("2. JUROS, MULTA E ACRÉSCIMO")
print("=" * 62)
linha = {"multa": 10.0, "acrescimo": 2.5, "acrescimo_avulso": 0.5}
print(f"  multa 10,00 + acréscimo 2,50 + avulso 0,50 = {ps.line_encargos(linha):.2f}")
print(f"  conta da Rede Saúde: {ps.REDE_SAUDE}")

print()
print("=" * 62)
print("3. COBERTURA NA COMPETÊNCIA")
print("=" * 62)
base = defaultdict(float)
enc = defaultdict(float)
fat_total = coberto = 0.0
for linha in rows:
    grupo = (linha["grupo_mae"] or "").strip()
    grupo_empresa = (linha["grupo_empresa"] or "").strip()
    empresa = (linha["empresa"] or "").strip()
    fat = float(linha["valor"] or 0)
    fat_total += fat
    aplic = ps.rules_for_line(ativas, grupo, grupo_empresa, empresa)
    if not aplic:
        continue
    coberto += fat
    soma = sum(float(r["valor"] or 0) for r in aplic)
    for r in aplic:
        parte = float(r["valor"] or 0) / soma if soma else 0
        base[r["recebedor"]] += round(fat * parte, 2)
    juros = ps.line_encargos(linha)
    if abs(juros) <= 0.005:
        continue
    pesos = {}
    for r in aplic:
        modo = (r["encargos"] if "encargos" in r.keys() else "rateio") or "rateio"
        if modo == "recebedor":
            conta = (r["encargos_recebedor"] if "encargos_recebedor" in r.keys() else "") or r["recebedor"]
        elif modo == "rede":
            conta = ps.REDE_SAUDE
        else:
            conta = r["recebedor"]
        pesos[conta] = pesos.get(conta, 0) + 1
    total_peso = sum(pesos.values())
    for conta, peso in pesos.items():
        enc[conta] += juros * peso / total_peso

print(f"  faturado        R$ {fat_total:>13,.2f}")
print(f"  com regra       R$ {coberto:>13,.2f}  ({coberto / fat_total * 100:.1f}%)")
print(f"  sem regra       R$ {fat_total - coberto:>13,.2f}  ({(fat_total - coberto) / fat_total * 100:.1f}%)")
print()
print(f"  {'recebedor':18s} {'base':>13s} {'juros':>9s} {'total':>13s}")
for conta in sorted(set(base) | set(enc), key=lambda k: -(base[k] + enc[k])):
    print(f"  {conta[:18]:18s} {base[conta]:>13,.2f} {enc[conta]:>9,.2f} {base[conta] + enc[conta]:>13,.2f}")
print(f"  {'TOTAL':18s} {sum(base.values()):>13,.2f} {sum(enc.values()):>9,.2f} "
      f"{sum(base.values()) + sum(enc.values()):>13,.2f}")
