"""Análise do rateio: o que foi faturado x o que foi recebido x quem recebe o quê.

Só lê. Não grava nada no banco e não altera o portal.
Fonte do faturamento: apuracao_rows (competência Novembro/2026, run mais recente).
Fonte do recebido: finance_rateios (relatórios P4X), deduplicados por conteúdo.
"""
import json
import sqlite3
import unicodedata
from collections import defaultdict
from pathlib import Path

RAIZ = Path(__file__).resolve().parent
BANCO = RAIZ / "portal.db"
SAIDA = RAIZ / "entregas" / "rateio-analise.json"


def norm(valor):
    texto = unicodedata.normalize("NFKD", str(valor or "").strip().lower())
    return " ".join("".join(c for c in texto if not unicodedata.combining(c)).split())


def dinheiro(valor):
    return float(valor or 0)


def main():
    conexao = sqlite3.connect(BANCO)
    conexao.row_factory = sqlite3.Row

    run = conexao.execute(
        "SELECT * FROM apuracao_runs WHERE status='done' ORDER BY finished_at DESC LIMIT 1"
    ).fetchone()
    if not run:
        raise SystemExit("Nenhuma apuração concluída.")
    linhas = conexao.execute(
        "SELECT * FROM apuracao_rows WHERE run_id=?", (run["id"],)
    ).fetchall()
    regras = conexao.execute("SELECT * FROM rateio_rules WHERE ativo=1").fetchall()

    # ── 1. Faturado x recebido por grupo ────────────────────────────────
    grupos = defaultdict(lambda: {"titulos": 0, "faturado": 0.0, "recebido": 0.0,
                                  "aberto": 0.0, "vidas": 0})
    for linha in linhas:
        grupo = (linha["grupo_mae"] or "").strip() or "(sem grupo)"
        faturado = dinheiro(linha["valor"])
        recebido = dinheiro(linha["valor_recebido"])
        grupos[grupo]["titulos"] += 1
        grupos[grupo]["faturado"] += faturado
        grupos[grupo]["recebido"] += recebido
        if recebido <= 0.005:
            grupos[grupo]["aberto"] += faturado
        try:
            grupos[grupo]["vidas"] += int(float(linha["vidas"] or 0))
        except ValueError:
            pass

    # ── 2. Faturado x recebido por forma de recebimento ─────────────────
    formas = defaultdict(lambda: {"titulos": 0, "faturado": 0.0, "recebido": 0.0,
                                  "grupos": defaultdict(float)})
    for linha in linhas:
        forma = (linha["tipo_recebimento"] or "").strip() or "(sem forma)"
        grupo = (linha["grupo_mae"] or "").strip() or "(sem grupo)"
        formas[forma]["titulos"] += 1
        formas[forma]["faturado"] += dinheiro(linha["valor"])
        formas[forma]["recebido"] += dinheiro(linha["valor_recebido"])
        formas[forma]["grupos"][grupo] += dinheiro(linha["valor"])

    # ── 3. Rateios recebidos de verdade (P4X), sem importação repetida ──
    importacoes = conexao.execute(
        "SELECT id, file_name, created_at FROM finance_imports ORDER BY created_at"
    ).fetchall()
    assinaturas, mantidas, repetidas = {}, [], []
    for imp in importacoes:
        chave = tuple(
            tuple(x) for x in conexao.execute(
                "SELECT occurrence, payer_doc, nominal, paid FROM finance_rateios "
                "WHERE import_id=? ORDER BY occurrence, payer_doc", (imp["id"],)
            )
        )
        if chave in assinaturas:
            repetidas.append({"arquivo": imp["file_name"], "igualA": assinaturas[chave]})
        else:
            assinaturas[chave] = imp["file_name"]
            mantidas.append(imp["id"])

    filtro = ",".join("?" * len(mantidas))
    brutos = conexao.execute(
        f"SELECT * FROM finance_rateios WHERE import_id IN ({filtro})", mantidas
    ).fetchall()

    # O mesmo lançamento aparece em vários relatórios P4X. A chave de negócio
    # é o pagador + a data + o valor + o tipo de movimento; o arquivo não entra.
    unicos, repetidos_entre_arquivos = {}, 0
    for linha in brutos:
        chave = (
            "".join(c for c in str(linha["payer_doc"] or "") if c.isdigit()),
            str(linha["rateio_date"] or "").strip(),
            round(dinheiro(linha["rateio"]), 2),
            str(linha["occurrence"] or "").strip(),
        )
        if chave in unicos:
            repetidos_entre_arquivos += 1
        else:
            unicos[chave] = linha
    rateios = list(unicos.values())

    recebedores = defaultdict(lambda: {"lancamentos": 0, "nominal": 0.0, "rateio": 0.0})
    for linha in rateios:
        nome = (linha["receiver_name"] or "").strip() or "(sem recebedor)"
        recebedores[nome]["lancamentos"] += 1
        recebedores[nome]["nominal"] += dinheiro(linha["nominal"])
        recebedores[nome]["rateio"] += dinheiro(linha["rateio"])

    por_dia = defaultdict(lambda: {"lancamentos": 0, "rateio": 0.0})
    for linha in rateios:
        dia = (linha["rateio_date"] or "").strip()
        if not dia:
            continue
        por_dia[dia]["lancamentos"] += 1
        por_dia[dia]["rateio"] += dinheiro(linha["rateio"])

    # ── 3b. Quanto de rateio o S4E registra por grupo ───────────────────
    # Liga o pagador do relatório P4X ao documento da empresa na apuração.
    por_documento = {}
    for linha in linhas:
        documento = "".join(c for c in str(linha["documento"] or "") if c.isdigit())
        if documento:
            por_documento[documento] = linha
    rateio_por_grupo, sem_casar = defaultdict(float), 0.0
    for linha in rateios:
        documento = "".join(c for c in str(linha["payer_doc"] or "") if c.isdigit())
        alvo = por_documento.get(documento)
        if alvo:
            rateio_por_grupo[(alvo["grupo_mae"] or "").strip() or "(sem grupo)"] += dinheiro(linha["rateio"])
        else:
            sem_casar += dinheiro(linha["rateio"])

    # ── 4. Regras de rateio: cobertura por grupo ────────────────────────
    por_grupo_regra = defaultdict(list)
    for regra in regras:
        por_grupo_regra[regra["grupo"]].append(regra)

    cobertura = []
    for grupo, dados in sorted(grupos.items(), key=lambda x: -x[1]["faturado"]):
        aplicaveis = por_grupo_regra.get(grupo)
        if not aplicaveis:
            # tenta casar por normalização
            for chave in por_grupo_regra:
                if norm(chave) == norm(grupo):
                    aplicaveis = por_grupo_regra[chave]
                    break
        if aplicaveis:
            por_vida = sum(dinheiro(r["valor"]) for r in aplicaveis if r["metodo"] == "por_vida")
            vidas_faturadas = dados["faturado"] / por_vida if por_vida > 0 else 0
            distribuicao = [
                {"recebedor": r["recebedor"],
                 "metodo": r["metodo"],
                 "valorUnitario": dinheiro(r["valor"]),
                 "total": round(vidas_faturadas * dinheiro(r["valor"]), 2)
                 if r["metodo"] == "por_vida" else 0.0}
                for r in aplicaveis
            ]
            total_distribuido = round(sum(d["total"] for d in distribuicao), 2)
            cobertura.append({
                "grupo": grupo,
                "temRegra": True,
                "faturado": round(dados["faturado"], 2),
                "recebido": round(dados["recebido"], 2),
                "rateioP4X": round(rateio_por_grupo.get(grupo, 0.0), 2),
                "vidasS4e": dados["vidas"],
                "vidasFaturadas": round(vidas_faturadas, 2),
                "totalDistribuido": total_distribuido,
                "saldo": round(dados["faturado"] - total_distribuido, 2),
                "regras": distribuicao,
            })
        else:
            cobertura.append({
                "grupo": grupo,
                "temRegra": False,
                "faturado": round(dados["faturado"], 2),
                "recebido": round(dados["recebido"], 2),
                "rateioP4X": round(rateio_por_grupo.get(grupo, 0.0), 2),
                "vidasS4e": dados["vidas"],
                "totalDistribuido": 0.0,
                "saldo": round(dados["faturado"], 2),
                "regras": [],
            })

    total_faturado = sum(g["faturado"] for g in grupos.values())
    total_recebido = sum(g["recebido"] for g in grupos.values())
    com_regra = [c for c in cobertura if c["temRegra"]]
    sem_regra = [c for c in cobertura if not c["temRegra"]]

    resultado = {
        "apuracao": {"id": run["id"], "competencia": run["competencia_label"],
                     "concluidaEm": run["finished_at"], "linhas": len(linhas)},
        "resumo": {
            "faturado": round(total_faturado, 2),
            "recebido": round(total_recebido, 2),
            "emAberto": round(total_faturado - total_recebido, 2),
            "taxaRecebimento": round(total_recebido / total_faturado * 100, 2) if total_faturado else 0,
            "grupos": len(grupos),
            "gruposComRegra": len(com_regra),
            "gruposSemRegra": len(sem_regra),
            "faturadoSemRegra": round(sum(c["faturado"] for c in sem_regra), 2),
            "faturadoComRegra": round(sum(c["faturado"] for c in com_regra), 2),
        },
        "grupos": [dict(grupo=g, **d) for g, d in
                   sorted(grupos.items(), key=lambda x: -x[1]["faturado"])],
        "formas": [dict(forma=f, grupos=dict(d["grupos"]), **{k: v for k, v in d.items() if k != "grupos"})
                   for f, d in sorted(formas.items(), key=lambda x: -x[1]["faturado"])],
        "rateioRecebido": {
            "recebedores": [dict(nome=n, **d) for n, d in
                            sorted(recebedores.items(), key=lambda x: -x[1]["rateio"])],
            "porDia": [dict(dia=d, **v) for d, v in sorted(por_dia.items())],
            "importacoesRepetidas": repetidas,
            "linhasBrutas": len(brutos),
            "linhasUnicas": len(rateios),
            "lancamentosRepetidosEntreArquivos": repetidos_entre_arquivos,
            "semEmpresaNaApuracao": round(sem_casar, 2),
            "totalNominal": round(sum(r["nominal"] for r in recebedores.values()), 2),
            "totalRateio": round(sum(r["rateio"] for r in recebedores.values()), 2),
        },
        "cobertura": cobertura,
    }

    SAIDA.parent.mkdir(exist_ok=True)
    SAIDA.write_text(json.dumps(resultado, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"apuração: {run['competencia_label']}  ({len(linhas)} títulos)")
    print(f"faturado: R$ {total_faturado:,.2f}")
    print(f"recebido: R$ {total_recebido:,.2f}  ({resultado['resumo']['taxaRecebimento']}%)")
    print(f"em aberto: R$ {resultado['resumo']['emAberto']:,.2f}")
    print(f"grupos: {len(grupos)}  com regra: {len(com_regra)}  sem regra: {len(sem_regra)}")
    print(f"faturado sem regra: R$ {resultado['resumo']['faturadoSemRegra']:,.2f}")
    print(f"rateio P4X (sem repetição): R$ {resultado['rateioRecebido']['totalRateio']:,.2f}")
    print(f"importações repetidas: {len(repetidas)}")
    print(f"\njson: {SAIDA}")


if __name__ == "__main__":
    main()
