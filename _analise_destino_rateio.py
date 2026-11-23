"""Quem recebe o quê: cenário com todas as regras ligadas + checagem de viabilidade.

Só lê o banco. Não grava nada.
"""
import json
import sqlite3
from collections import defaultdict
from pathlib import Path

RAIZ = Path(__file__).resolve().parent
BANCO = RAIZ / "portal.db"
SAIDA = RAIZ / "entregas" / "rateio-destino.json"


def dinheiro(valor):
    return float(valor or 0)


def main():
    conexao = sqlite3.connect(BANCO)
    conexao.row_factory = sqlite3.Row
    run = conexao.execute(
        "SELECT * FROM apuracao_runs WHERE status='done' ORDER BY finished_at DESC LIMIT 1"
    ).fetchone()
    linhas = conexao.execute(
        "SELECT * FROM apuracao_rows WHERE run_id=?", (run["id"],)
    ).fetchall()

    regras = defaultdict(list)
    for regra in conexao.execute("SELECT * FROM rateio_rules ORDER BY grupo, recebedor"):
        regras[regra["grupo"]].append(regra)

    # ── cenário A: só as regras ativas hoje ─────────────────────────────
    # ── cenário B: todas as regras cadastradas (ligando as inativas) ────
    def distribuir(usar_inativas):
        por_recebedor = defaultdict(float)
        por_grupo = {}
        for linha in linhas:
            grupo = (linha["grupo_mae"] or "").strip()
            aplicaveis = [
                r for r in regras.get(grupo, [])
                if usar_inativas or r["ativo"]
            ]
            if not aplicaveis:
                continue
            faturado = dinheiro(linha["valor"])
            por_vida = sum(dinheiro(r["valor"]) for r in aplicaveis if r["metodo"] == "por_vida")
            if por_vida <= 0:
                continue
            vidas = faturado / por_vida
            detalhe = por_grupo.setdefault(grupo, {"faturado": 0.0, "recebedores": defaultdict(float)})
            detalhe["faturado"] += faturado
            for regra in aplicaveis:
                valor = round(vidas * dinheiro(regra["valor"]), 2)
                por_recebedor[regra["recebedor"]] += valor
                detalhe["recebedores"][regra["recebedor"]] += valor
        return por_recebedor, por_grupo

    ativas, grupo_ativas = distribuir(False)
    todas, grupo_todas = distribuir(True)

    # ── viabilidade: a regra cabe no preço real por vida? ───────────────
    viabilidade = []
    for grupo, lista in sorted(regras.items()):
        do_grupo = [l for l in linhas if (l["grupo_mae"] or "").strip() == grupo]
        if not do_grupo:
            continue
        faturado = sum(dinheiro(l["valor"]) for l in do_grupo)
        vidas = sum(int(float(l["vidas"] or 0)) for l in do_grupo)
        soma_regras = sum(dinheiro(r["valor"]) for r in lista if r["metodo"] == "por_vida")
        preco_real = faturado / vidas if vidas else 0
        ativas_grupo = [r for r in lista if r["ativo"]]
        viabilidade.append({
            "grupo": grupo,
            "faturado": round(faturado, 2),
            "vidas": vidas,
            "precoRealPorVida": round(preco_real, 2),
            "somaRegras": round(soma_regras, 2),
            "sobraPorVida": round(preco_real - soma_regras, 2),
            "cabe": preco_real >= soma_regras - 0.005,
            "temRegraAtiva": bool(ativas_grupo),
            "totalRegras": len(lista),
            "regrasAtivas": len(ativas_grupo),
        })

    # ── grupos sem nenhuma regra ────────────────────────────────────────
    sem_regra = []
    for grupo in sorted({(l["grupo_mae"] or "").strip() for l in linhas}):
        if grupo in regras:
            continue
        do_grupo = [l for l in linhas if (l["grupo_mae"] or "").strip() == grupo]
        faturado = sum(dinheiro(l["valor"]) for l in do_grupo)
        vidas = sum(int(float(l["vidas"] or 0)) for l in do_grupo)
        sem_regra.append({
            "grupo": grupo,
            "titulos": len(do_grupo),
            "faturado": round(faturado, 2),
            "vidas": vidas,
            "precoRealPorVida": round(faturado / vidas, 2) if vidas else 0,
        })
    sem_regra.sort(key=lambda x: -x["faturado"])

    # ── viabilidade pelo preço MODAL (o preço que a maioria das empresas paga) ──
    from collections import Counter
    for item in viabilidade:
        do_grupo = [l for l in linhas
                    if (l["grupo_mae"] or "").strip() == item["grupo"]
                    and int(float(l["vidas"] or 0)) > 0]
        precos = [round(dinheiro(l["valor"]) / int(float(l["vidas"])), 2) for l in do_grupo]
        if precos:
            modal, quantas = Counter(precos).most_common(1)[0]
            item["precoModal"] = modal
            item["empresasNoModal"] = quantas
            item["empresasComVidas"] = len(precos)
            item["diferencaModal"] = round(item["somaRegras"] - modal, 2)
            item["ajustada"] = abs(item["diferencaModal"]) <= 0.02
        else:
            item["precoModal"] = 0
            item["diferencaModal"] = 0
            item["ajustada"] = False

    resultado = {
        "apuracao": run["competencia_label"],
        "cenarioAtivo": [{"recebedor": k, "valor": round(v, 2)}
                         for k, v in sorted(ativas.items(), key=lambda x: -x[1])],
        "cenarioTodasRegras": [{"recebedor": k, "valor": round(v, 2)}
                               for k, v in sorted(todas.items(), key=lambda x: -x[1])],
        "totalAtivo": round(sum(ativas.values()), 2),
        "totalTodas": round(sum(todas.values()), 2),
        "porGrupoTodas": [
            {"grupo": g, "faturado": round(d["faturado"], 2),
             "recebedores": [{"recebedor": k, "valor": round(v, 2)}
                             for k, v in sorted(d["recebedores"].items(), key=lambda x: -x[1])],
             "total": round(sum(d["recebedores"].values()), 2)}
            for g, d in sorted(grupo_todas.items(), key=lambda x: -x[1]["faturado"])
        ],
        "viabilidade": sorted(viabilidade, key=lambda x: x["sobraPorVida"]),
        "semRegra": sem_regra,
    }
    SAIDA.parent.mkdir(exist_ok=True)
    SAIDA.write_text(json.dumps(resultado, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"cenário com regras ATIVAS hoje : R$ {resultado['totalAtivo']:,.2f}")
    print(f"cenário com TODAS as regras    : R$ {resultado['totalTodas']:,.2f}")
    print(f"\ngrupos onde a regra NÃO cabe no preço real:")
    for v in resultado["viabilidade"]:
        if not v["cabe"]:
            print(f"  {v['grupo']:24s} preço R$ {v['precoRealPorVida']:>7.2f}  regras R$ {v['somaRegras']:>7.2f}"
                  f"  falta R$ {-v['sobraPorVida']:>7.2f}")
    print(f"\ngrupos sem nenhuma regra: {len(resultado['semRegra'])}")
    print("\nregras desalinhadas com o preço real (preço modal x soma das regras):")
    for v in resultado["viabilidade"]:
        if not v["ajustada"] and v["precoModal"]:
            print(f"  {v['grupo']:22s} preço R$ {v['precoModal']:>7.2f}  regras R$ {v['somaRegras']:>7.2f}"
                  f"  diferença R$ {v['diferencaModal']:>7.2f}  ({v['empresasNoModal']}/{v['empresasComVidas']} empresas)")
    print(f"json: {SAIDA}")


if __name__ == "__main__":
    main()
