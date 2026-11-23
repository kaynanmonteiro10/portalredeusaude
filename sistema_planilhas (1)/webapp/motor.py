# -*- coding: utf-8 -*-
"""
Motor de processamento das planilhas.
Toda a lógica de negócio fica aqui (sem input()/print()) para ser usada pela
interface web (app.py). Cada função recebe dados e devolve dados/erros.
"""

import copy
import re
import unicodedata
from datetime import datetime
from collections import defaultdict

import openpyxl
from openpyxl.styles import Font


# =============================================================================
# Colunas fixas da PLANILHA 1 (export bruto)
# =============================================================================
COL = {
    "NOME_FANTASIA": 0,
    "CPF_CNPJ": 1,
    "GRUPO_EMPRESA": 2,
    "DATA_CREDITO": 9,
    "DATA": 10,          # coluna "Data": entre Data Credito e Valor Parcela
    "VALOR_PARCELA": 11,
    "TIPO_PARCELA": 23,
    "TIPO_PAGAMENTO": 25,
    "NF": 30,
    "QTD_VIDAS": 37,
}

DEPOSITO_BANCARIO = "DEPOSITO BANCARIO"


# =============================================================================
# Utilidades
# =============================================================================

def remove_acentos(txt):
    return "".join(
        c for c in unicodedata.normalize("NFKD", txt or "")
        if not unicodedata.combining(c)
    )


def normaliza(texto):
    return remove_acentos(str(texto or "")).strip().upper()


def so_digitos(texto):
    return re.sub(r"\D", "", str(texto) if texto is not None else "")


def separa_codigo_nome(nome_fantasia):
    """'35 - S4E INFORMATICA' -> (35, 'S4E INFORMATICA')."""
    if nome_fantasia is None:
        return None, ""
    texto = str(nome_fantasia).strip()
    m = re.match(r"^\s*(\d+)\s*-\s*(.+)$", texto)
    if m:
        return int(m.group(1)), m.group(2).strip()
    return None, texto


def limpa_valor_parcela(valor):
    """
    Remove 'R$' e mantém o valor no formato original (NÃO converte para número).
    Retorna None se a linha deve ser EXCLUÍDA (valor zero, 'R$ -', vazio).
    """
    if valor is None:
        return None

    if isinstance(valor, (int, float)):
        if valor == 0:
            return None
        # mantém como veio (é assim que a planilha de origem já guarda o valor)
        return valor

    texto = str(valor).strip()
    texto_sem_rs = texto.replace("R$", "").strip()
    texto_normalizado = texto_sem_rs.replace(".", "").replace(",", ".")

    if texto_sem_rs in ("", "-", "--"):
        return None
    try:
        if float(texto_normalizado) == 0:
            return None
    except ValueError:
        pass

    return texto_sem_rs


def shift_formula_linha(formula, linha_origem, linha_destino):
    """Copia fórmula tipo '=SE(I5>1;"PAGO";"")' trocando a referência de linha."""
    if not isinstance(formula, str) or not formula.startswith("="):
        return formula

    def repl(match):
        col, linha = match.group(1), int(match.group(2))
        if linha == linha_origem:
            return f"{col}{linha_destino}"
        return match.group(0)

    return re.sub(r"(\$?[A-Z]{1,3})(\d+)", repl, formula)


# =============================================================================
# ETAPA 1 — Carregar planilha 1
# =============================================================================

def carrega_planilha1(caminho):
    wb = openpyxl.load_workbook(caminho, data_only=True)
    ws = wb.worksheets[0]

    linhas = []
    sem_codigo = 0
    for row in ws.iter_rows(min_row=2, values_only=True):
        if len(row) <= COL["QTD_VIDAS"]:
            continue
        if row[COL["NOME_FANTASIA"]] is None and row[COL["CPF_CNPJ"]] is None:
            continue
        codigo, nome = separa_codigo_nome(row[COL["NOME_FANTASIA"]])
        if codigo is None:
            sem_codigo += 1
        linhas.append({
            "codigo": codigo,
            "nome_empresa": nome,
            "cpf_cnpj": row[COL["CPF_CNPJ"]],
            "grupo_empresa": (row[COL["GRUPO_EMPRESA"]] or "").strip() if row[COL["GRUPO_EMPRESA"]] else "",
            "data_credito": row[COL["DATA_CREDITO"]],
            "data": row[COL["DATA"]],
            "valor_parcela": row[COL["VALOR_PARCELA"]],
            "tipo_parcela": row[COL["TIPO_PARCELA"]],
            "tipo_pagamento": row[COL["TIPO_PAGAMENTO"]],
            "nf": row[COL["NF"]],
            "qtd_vidas": row[COL["QTD_VIDAS"]] or 0,
        })
    return linhas, sem_codigo


# =============================================================================
# ETAPA 2 — Estatística e filtro CPF/CNPJ
# =============================================================================

def estatistica_cpf_cnpj(linhas):
    cpf = sum(1 for l in linhas if len(so_digitos(l["cpf_cnpj"])) == 11)
    cnpj = sum(1 for l in linhas if len(so_digitos(l["cpf_cnpj"])) == 14)
    outros = len(linhas) - cpf - cnpj
    return {"cpf": cpf, "cnpj": cnpj, "outros": outros, "total": len(linhas)}


def aplica_filtro_cpf_cnpj(linhas, opcao):
    """opcao: 'apenas_cnpj' | 'apenas_cpf' | 'ambos'"""
    if opcao == "apenas_cnpj":
        return [l for l in linhas if len(so_digitos(l["cpf_cnpj"])) != 11]
    if opcao == "apenas_cpf":
        return [l for l in linhas if len(so_digitos(l["cpf_cnpj"])) != 14]
    return list(linhas)


# =============================================================================
# ETAPA 3 — Limpeza Valor Parcela
# =============================================================================

def aplica_limpeza_valor_parcela(linhas):
    resultado = []
    for l in linhas:
        valor_limpo = limpa_valor_parcela(l["valor_parcela"])
        if valor_limpo is None:
            continue
        nova = dict(l)
        nova["valor_parcela"] = valor_limpo
        resultado.append(nova)
    return resultado


# =============================================================================
# ETAPA 4 — Tipo Parcela
# =============================================================================

def contagem_tipo_parcela(linhas):
    contagem = defaultdict(int)
    for l in linhas:
        chave = l["tipo_parcela"] if l["tipo_parcela"] not in (None, "") else "(vazio)"
        contagem[chave] += 1
    return sorted(contagem.items(), key=lambda x: -x[1])


def aplica_remocao_tipo_parcela(linhas, tipos_remover):
    remover_norm = {normaliza(t) for t in tipos_remover}
    return [
        l for l in linhas
        if normaliza(l["tipo_parcela"] if l["tipo_parcela"] not in (None, "") else "(vazio)") not in remover_norm
    ]


# =============================================================================
# ETAPA 5 — Agrupar por Grupo Empresa + ordenar por Data + detectar depósito
# =============================================================================

def agrupa_e_ordena(linhas):
    grupos = defaultdict(list)
    for l in linhas:
        chave = l["grupo_empresa"] if l["grupo_empresa"] else "(SEM GRUPO)"
        grupos[chave].append(l)

    def chave_ordenacao(l):
        d = l["data"]
        return d if isinstance(d, datetime) else datetime.max

    for chave in grupos:
        grupos[chave].sort(key=chave_ordenacao)

    return dict(grupos)


def detecta_deposito_bancario(grupos):
    """Retorna {grupo: True/False} indicando se há TIPO PAGAMENTO = DEPOSITO BANCARIO."""
    info = {}
    for chave, itens in grupos.items():
        info[chave] = any(normaliza(i["tipo_pagamento"]) == DEPOSITO_BANCARIO for i in itens)
    return info


# =============================================================================
# ETAPA 6/7 — Planilha 2: leitura de abas e colunas
# =============================================================================

PADROES_COLUNA = {
    "codigo": ["codigo"],
    "empresa": ["empresa"],
    "cnpj": ["cnpj"],
    "vidas": ["vidas"],
    "vencimento": ["vencimento"],
    "nf": ["nf"],
    "mensalidade": ["mensalidade"],
    "pagamento": ["pagamento"],
    "situacao": ["situa"],
    "valor_assoc": ["assoc"],
    "grupo_ou_responsavel": ["grupo", "responsavel"],
}


def carrega_planilha2(caminho):
    return openpyxl.load_workbook(caminho, data_only=False)


def encontra_linha_cabecalho(ws):
    for r in range(1, 6):
        valor = ws.cell(row=r, column=1).value
        if valor and remove_acentos(str(valor)).lower().startswith("cod"):
            return r
    return 2


def identifica_colunas(ws, linha_cabecalho):
    mapa = {}
    for c in range(1, ws.max_column + 1):
        valor = ws.cell(row=linha_cabecalho, column=c).value
        if not valor:
            continue
        texto = remove_acentos(str(valor)).lower()
        for papel, padroes in PADROES_COLUNA.items():
            if papel in mapa:
                continue
            if any(p in texto for p in padroes):
                mapa[papel] = c
                break
    return mapa


# =============================================================================
# ETAPA 8 — Escrever na planilha 2
# =============================================================================

def _mes_ano(valor_data):
    if isinstance(valor_data, datetime):
        return (valor_data.year, valor_data.month)
    return None


def escreve_na_planilha2(wb2, mapeamento, grupos):
    """
    mapeamento: {grupo_empresa: nome_aba}
    Regra de duplicidade: mesma empresa (CNPJ) + mesmo mês/ano de vencimento já
    lançados na aba -> SOBRESCREVE a linha existente com os dados novos.
    Se não achar CNPJ+mês, lança em uma linha nova (não sobrescreve outros meses).
    Retorna lista de dicts (uma por empresa processada) para o relatório final.
    """
    resultado = []
    por_aba = defaultdict(list)
    for chave_grupo, aba in mapeamento.items():
        if chave_grupo in grupos:
            por_aba[aba].extend((chave_grupo, item) for item in grupos[chave_grupo])

    resumo_por_aba = {}

    for aba, itens_com_grupo in por_aba.items():
        ws = wb2[aba]
        linha_cab = encontra_linha_cabecalho(ws)
        colmap = identifica_colunas(ws, linha_cab)
        col_cnpj = colmap.get("cnpj")
        col_codigo = colmap.get("codigo", 1)
        col_vencimento = colmap.get("vencimento")

        linha_modelo = linha_cab + 1
        ws.delete_rows(idx=linha_modelo + 1, amount=max(0, ws.max_row - linha_modelo))

        # índice (cnpj, ano, mes) -> linha, para saber o que já existe NAQUELE mês
        indice_existente = {}
        for r in range(linha_cab + 1, ws.max_row + 1):
            if col_cnpj and col_vencimento:
                cnpj_r = so_digitos(ws.cell(row=r, column=col_cnpj).value)
                mes_r = _mes_ano(ws.cell(row=r, column=col_vencimento).value)
                if cnpj_r and mes_r:
                    indice_existente[(cnpj_r, mes_r)] = r

        proxima_linha = linha_modelo + 1
        adicionadas, atualizadas = 0, 0

        for chave_grupo, item in itens_com_grupo:
            cnpj_digits = so_digitos(item["cpf_cnpj"])
            situacao = "PAGO" if item["data_credito"] else "NAO PAGO"
            mes_item = _mes_ano(item["data"])
            chave_indice = (cnpj_digits, mes_item) if (cnpj_digits and mes_item) else None

            linha_existente = indice_existente.get(chave_indice) if chave_indice else None
            eh_nova = linha_existente is None
            r = proxima_linha if eh_nova else linha_existente

            if "codigo" in colmap:
                ws.cell(row=r, column=colmap["codigo"], value=item["codigo"])
            if "empresa" in colmap:
                ws.cell(row=r, column=colmap["empresa"], value=item["nome_empresa"])
            if "cnpj" in colmap:
                ws.cell(row=r, column=colmap["cnpj"], value=item["cpf_cnpj"])
            if "vidas" in colmap:
                ws.cell(row=r, column=colmap["vidas"], value=item["qtd_vidas"])
            if "vencimento" in colmap:
                ws.cell(row=r, column=colmap["vencimento"], value=item["data"])
            if "nf" in colmap:
                ws.cell(row=r, column=colmap["nf"], value=item["nf"])
            if "mensalidade" in colmap:
                ws.cell(row=r, column=colmap["mensalidade"], value=item["valor_parcela"])
            if "pagamento" in colmap:
                ws.cell(row=r, column=colmap["pagamento"], value=item["data_credito"])
            if "grupo_ou_responsavel" in colmap:
                ws.cell(row=r, column=colmap["grupo_ou_responsavel"], value=item["grupo_empresa"])
            if "situacao" in colmap:
                formula_modelo = ws.cell(row=linha_modelo, column=colmap["situacao"]).value
                ws.cell(row=r, column=colmap["situacao"],
                        value=shift_formula_linha(formula_modelo, linha_modelo, r))

            if eh_nova:
                for c in range(1, ws.max_column + 1):
                    origem = ws.cell(row=linha_modelo, column=c)
                    destino = ws.cell(row=r, column=c)
                    destino.font = copy.copy(origem.font)
                    destino.number_format = copy.copy(origem.number_format)
                    destino.fill = copy.copy(origem.fill)
                    destino.border = copy.copy(origem.border)
                    destino.alignment = copy.copy(origem.alignment)

                if chave_indice:
                    indice_existente[chave_indice] = r
                proxima_linha += 1
                adicionadas += 1
            else:
                atualizadas += 1

            resultado.append({**item, "aba": aba, "situacao": situacao, "sobrescrita": not eh_nova})

        resumo_por_aba[aba] = {"adicionadas": adicionadas, "atualizadas": atualizadas}

    return resultado, resumo_por_aba


# =============================================================================
# ETAPA 9 — Relatório de pagos x não pagos
# =============================================================================

def valor_como_float(valor):
    if valor is None:
        return 0.0
    if isinstance(valor, (int, float)):
        return float(valor)
    txt = re.sub(r"[^\d,.\-]", "", str(valor))
    txt = txt.replace(".", "").replace(",", ".")
    try:
        return float(txt)
    except ValueError:
        return 0.0


def _resumo_por_grupo_mae(resultado):
    por_aba = defaultdict(lambda: {
        "empresas": {},
        "total_empresas": 0,
        "pagaram": 0,
        "nao_pagaram": 0,
        "total_vidas": 0,
        "valor_total": 0.0,
        "valor_recebido": 0.0,
        "valor_pendente": 0.0,
    })

    for item in resultado:
        aba = str(item.get("aba") or "(SEM GRUPO MÃE)")
        dados_aba = por_aba[aba]
        chave_empresa = (
            so_digitos(item.get("cpf_cnpj") or ""),
            str(item.get("nome_empresa") or ""),
        )
        empresa = dados_aba["empresas"].setdefault(chave_empresa, {
            "nome_empresa": item.get("nome_empresa") or "",
            "cpf_cnpj": item.get("cpf_cnpj") or "",
            "qtd_vidas": 0,
            "valor_total": 0.0,
            "valor_recebido": 0.0,
            "valor_pendente": 0.0,
        })

        dados_aba["total_empresas"] += 1
        dados_aba["total_vidas"] += int(item.get("qtd_vidas") or 0)
        valor = valor_como_float(item.get("valor_parcela"))
        empresa["qtd_vidas"] += int(item.get("qtd_vidas") or 0)
        empresa["valor_total"] += valor
        dados_aba["valor_total"] += valor

        if item.get("situacao") == "PAGO":
            dados_aba["pagaram"] += 1
            dados_aba["valor_recebido"] += valor
            empresa["valor_recebido"] += valor
        else:
            dados_aba["nao_pagaram"] += 1
            dados_aba["valor_pendente"] += valor
            empresa["valor_pendente"] += valor

    resumo = {}
    for aba, dados_aba in por_aba.items():
        empresas = list(dados_aba["empresas"].values())
        empresas_mais = sorted(empresas, key=lambda e: (-e["qtd_vidas"], e["nome_empresa"]))[:1]
        empresas_menos = sorted(empresas, key=lambda e: (e["qtd_vidas"], e["nome_empresa"]))[:1]
        resumo[aba] = {
            "total_empresas": dados_aba["total_empresas"],
            "pagaram": dados_aba["pagaram"],
            "nao_pagaram": dados_aba["nao_pagaram"],
            "total_vidas": dados_aba["total_vidas"],
            "valor_total": round(dados_aba["valor_total"], 2),
            "valor_recebido": round(dados_aba["valor_recebido"], 2),
            "valor_pendente": round(dados_aba["valor_pendente"], 2),
            "top_mais_vidas": empresas_mais,
            "top_menos_vidas": empresas_menos,
        }

    return resumo


def _resumo_por_vencimento(resultado):
    dados = defaultdict(lambda: {
        "total_recebido": 0.0,
        "total_pendente": 0.0,
        "pagos": 0,
        "nao_pagos": 0,
    })

    for item in resultado:
        vencimento = item.get("data")
        if vencimento is None:
            continue
        valor = valor_como_float(item.get("valor_parcela"))
        if item.get("situacao") == "PAGO":
            dados[vencimento]["total_recebido"] += valor
            dados[vencimento]["pagos"] += 1
        else:
            dados[vencimento]["total_pendente"] += valor
            dados[vencimento]["nao_pagos"] += 1

    return sorted(dados.items(), key=lambda kv: (kv[0] if isinstance(kv[0], datetime) else datetime.max, kv[0]))


def _escreve_tabela(ws, linha_inicio, cabecalho, linhas):
    for i, titulo in enumerate(cabecalho, start=1):
        ws.cell(row=linha_inicio, column=i, value=titulo).font = Font(bold=True)

    for r, linha in enumerate(linhas, start=linha_inicio + 1):
        for c, valor in enumerate(linha, start=1):
            ws.cell(row=r, column=c, value=valor)

    return linha_inicio + len(linhas) + 1


def gera_relatorio_resumo(resultado, caminho_saida):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Resumo"

    pagos = [r for r in resultado if r["situacao"] == "PAGO"]
    nao_pagos = [r for r in resultado if r["situacao"] == "NAO PAGO"]
    total_vidas = sum(int(r.get("qtd_vidas") or 0) for r in resultado)
    valor_total = sum(valor_como_float(r.get("valor_parcela")) for r in resultado)
    valor_recebido = sum(valor_como_float(r.get("valor_parcela")) for r in pagos)
    valor_pendente = sum(valor_como_float(r.get("valor_parcela")) for r in nao_pagos)

    resumo_por_aba = _resumo_por_grupo_mae(resultado)
    resumo_por_vencimento = _resumo_por_vencimento(resultado)

    empresas = []
    for item in resultado:
        empresas.append({
            "nome_empresa": item.get("nome_empresa") or "",
            "cpf_cnpj": item.get("cpf_cnpj") or "",
            "valor_recebido": valor_como_float(item.get("valor_parcela")) if item.get("situacao") == "PAGO" else 0.0,
            "valor_pendente": valor_como_float(item.get("valor_parcela")) if item.get("situacao") == "NAO PAGO" else 0.0,
        })

    melhores_pagantes = sorted(empresas, key=lambda e: (-e["valor_recebido"], e["nome_empresa"]))[:5]
    maiores_devedores = sorted(empresas, key=lambda e: (-e["valor_pendente"], e["nome_empresa"]))[:5]

    grupo_mais_dinheiro = max(resumo_por_aba.items(), key=lambda kv: kv[1]["valor_total"], default=("-", {"valor_total": 0}))
    grupo_menos_dinheiro = min(resumo_por_aba.items(), key=lambda kv: kv[1]["valor_total"], default=("-", {"valor_total": 0}))
    grupo_mais_vidas = max(resumo_por_aba.items(), key=lambda kv: kv[1]["total_vidas"], default=("-", {"total_vidas": 0}))
    grupo_menos_vidas = min(resumo_por_aba.items(), key=lambda kv: kv[1]["total_vidas"], default=("-", {"total_vidas": 0}))

    vencimento_mais_pagamento = max(resumo_por_vencimento, key=lambda kv: kv[1]["total_recebido"], default=("-", {"total_recebido": 0.0}))
    vencimento_menos_pagamento = min(resumo_por_vencimento, key=lambda kv: kv[1]["total_recebido"], default=("-", {"total_recebido": 0.0}))

    ws["A1"] = "RESUMO GERAL"
    ws["A1"].font = Font(bold=True, size=14)
    linhas_resumo = [
        ("Total de empresas processadas:", len(resultado)),
        ("Empresas PAGAS:", len(pagos)),
        ("Empresas NÃO PAGAS:", len(nao_pagos)),
        ("Total de vidas:", total_vidas),
        ("Valor total importado (R$):", round(valor_total, 2)),
        ("Valor recebido (R$):", round(valor_recebido, 2)),
        ("Valor pendente (R$):", round(valor_pendente, 2)),
        ("Data de vencimento com mais pagamento:", vencimento_mais_pagamento[0]),
        ("Data de vencimento com menos pagamento:", vencimento_menos_pagamento[0]),
        ("Grupo mãe que mais traz dinheiro:", grupo_mais_dinheiro[0]),
        ("Grupo mãe que menos traz dinheiro:", grupo_menos_dinheiro[0]),
        ("Grupo mãe com mais vidas:", grupo_mais_vidas[0]),
        ("Grupo mãe com menos vidas:", grupo_menos_vidas[0]),
        ("Melhor pagante:", melhores_pagantes[0]["nome_empresa"] if melhores_pagantes else "-"),
        ("Maior devedor:", maiores_devedores[0]["nome_empresa"] if maiores_devedores else "-"),
    ]
    for i, (rotulo, valor) in enumerate(linhas_resumo, start=3):
        ws.cell(row=i, column=1, value=rotulo)
        ws.cell(row=i, column=2, value=valor)

    linha = 22
    ws.cell(row=linha, column=1, value="RESUMO POR GRUPO MÃE").font = Font(bold=True)
    linha += 1
    cabecalho_grupos = ["Grupo Mãe", "Empresas", "Pagaram", "Não Pagaram", "Total de Vidas", "Valor Total", "Recebido", "Pendente"]
    linhas_grupos = []
    for aba, info in sorted(resumo_por_aba.items(), key=lambda kv: (-kv[1]["valor_total"], kv[0])):
        linhas_grupos.append([
            aba,
            info["total_empresas"],
            info["pagaram"],
            info["nao_pagaram"],
            info["total_vidas"],
            info["valor_total"],
            info["valor_recebido"],
            info["valor_pendente"],
        ])
    linha = _escreve_tabela(ws, linha + 1, cabecalho_grupos, linhas_grupos)

    ws.cell(row=linha, column=1, value="TOP 1 EMPRESA COM MAIS VIDAS POR GRUPO MÃE").font = Font(bold=True)
    linha += 1
    cabecalho_top = ["Grupo Mãe", "Empresa", "CNPJ/CPF", "Vidas"]
    linhas_top = []
    for aba, info in sorted(resumo_por_aba.items(), key=lambda kv: kv[0]):
        for empresa in info["top_mais_vidas"]:
            linhas_top.append([aba, empresa["nome_empresa"], empresa["cpf_cnpj"], empresa["qtd_vidas"]])
    linha = _escreve_tabela(ws, linha + 1, cabecalho_top, linhas_top)

    ws.cell(row=linha, column=1, value="TOP 1 EMPRESA COM MENOS VIDAS POR GRUPO MÃE").font = Font(bold=True)
    linha += 1
    cabecalho_low = ["Grupo Mãe", "Empresa", "CNPJ/CPF", "Vidas"]
    linhas_low = []
    for aba, info in sorted(resumo_por_aba.items(), key=lambda kv: kv[0]):
        for empresa in info["top_menos_vidas"]:
            linhas_low.append([aba, empresa["nome_empresa"], empresa["cpf_cnpj"], empresa["qtd_vidas"]])
    linha = _escreve_tabela(ws, linha + 1, cabecalho_low, linhas_low)

    ws.cell(row=linha, column=1, value="TOTAL POR VENCIMENTO (MENOR → MAIOR)").font = Font(bold=True)
    linha += 1
    cabecalho_venc = ["Vencimento", "Recebido", "Pendente", "Pagos", "Não Pagos"]
    linhas_venc = []
    for data, info in resumo_por_vencimento:
        linhas_venc.append([
            data,
            round(info["total_recebido"], 2),
            round(info["total_pendente"], 2),
            info["pagos"],
            info["nao_pagos"],
        ])
    _escreve_tabela(ws, linha + 1, cabecalho_venc, linhas_venc)

    for col, largura in zip("ABCDEFGHJKLMN", (18, 34, 18, 18, 12, 12, 12, 12, 12, 10, 20, 16, 14, 10)):
        ws.column_dimensions[col].width = largura

    ws2 = wb.create_sheet("Pagantes")
    ws2.append(["Código", "Empresa", "Grupo Empresa", "Aba", "CNPJ/CPF", "Valor Mensalidade", "Dt Vencimento", "Dt Pagamento", "Vidas"])
    for item in pagos:
        ws2.append([
            item.get("codigo"), item.get("nome_empresa"), item.get("grupo_empresa"), item.get("aba"),
            item.get("cpf_cnpj"), item.get("valor_parcela"), item.get("data"), item.get("data_credito"), item.get("qtd_vidas"),
        ])

    ws3 = wb.create_sheet("Nao Pagantes")
    ws3.append(["Código", "Empresa", "Grupo Empresa", "Aba", "CNPJ/CPF", "Valor Mensalidade", "Dt Vencimento", "Dt Pagamento", "Vidas"])
    for item in nao_pagos:
        ws3.append([
            item.get("codigo"), item.get("nome_empresa"), item.get("grupo_empresa"), item.get("aba"),
            item.get("cpf_cnpj"), item.get("valor_parcela"), item.get("data"), item.get("data_credito"), item.get("qtd_vidas"),
        ])

    for col, largura in zip("ABCDEFGHI", (10, 35, 22, 18, 20, 16, 14, 14, 8)):
        ws2.column_dimensions[col].width = largura
        ws3.column_dimensions[col].width = largura

    wb.save(caminho_saida)
    resumo_grupos = []
    for grupo, info in sorted(resumo_por_aba.items(), key=lambda kv: (-kv[1]["valor_total"], kv[0])):
        resumo_grupos.append({
            "grupo_mae": grupo,
            "empresas": info["total_empresas"],
            "pagaram": info["pagaram"],
            "nao_pagaram": info["nao_pagaram"],
            "total_vidas": info["total_vidas"],
            "valor_total": info["valor_total"],
            "valor_recebido": info["valor_recebido"],
            "valor_pendente": info["valor_pendente"],
        })

    resumo_vencimentos = []
    for data, info in resumo_por_vencimento:
        resumo_vencimentos.append({
            "vencimento": data,
            "recebido": round(info["total_recebido"], 2),
            "pendente": round(info["total_pendente"], 2),
            "pagos": info["pagos"],
            "nao_pagos": info["nao_pagos"],
        })

    return {
        "pagos": len(pagos),
        "nao_pagos": len(nao_pagos),
        "total_vidas": total_vidas,
        "valor_total": round(valor_total, 2),
        "valor_recebido": round(valor_recebido, 2),
        "valor_pendente": round(valor_pendente, 2),
        "resumo_grupos": resumo_grupos,
        "resumo_vencimentos": resumo_vencimentos,
    }
