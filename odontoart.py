"""Controle ODONTOART — a planilha que a Juliana monta à mão todo mês.

COMO O TRABALHO DELA FUNCIONA (conferido linha a linha no arquivo
"ODONTOART Outubro.2026.xlsx"):

  - ela está em novembro e fecha OUTUBRO (o mês anterior);
  - só entram as vidas do plano PJ TOP INDIVIDUAL COM ODONTOLOGIA;
  - cada vida recebe uma faixa de pagamento:
        1º PAGAMENTO           -> o mês da competência é o mês da adesão
        2º PAGAMENTO           -> um mês depois da adesão
        3º OU MAIS PAGAMENTOS  -> dois meses depois da adesão, ou mais
    É a mesma conta da coluna PAGAMENTO da planilha dela.
  - o número de parcelas que ela anota em [PARC: n] é o mesmo cálculo,
    contado a partir do mês da adesão:
        parcela = (ano da competência - ano da adesão) * 12
                + (mês da competência - mês da adesão) + 1
  - os grupos do arquivo:
        ODONTO                  -> vidas ATIVAS
        ATRASO                  -> vidas ATIVAS cujo título da competência
                                   não foi pago (ou que ela marcou como
                                   "NÃO FATUROU")
        CANCELAMENTOS           -> vidas CANCELADAS no S4E
        RESUMO DE VIDAS ATIVAS  -> contagem de vidas ativas por empresa
        RESUMO                  -> quantidade por faixa x valor unitário:
                                   Odontoart emite NF e boleto  = qtd * 8,98
                                   Rede Saúde emite NF e boleto = qtd * 0,18

  Tudo é derivado do que já está no banco:
        vidas_usuarios -> quem é vida do plano, empresa, situação, adesão
        apuracao_rows  -> o que foi faturado na competência (fonte S4E)

  Nada aqui grava: é leitura e conferência.
"""
import re
import sqlite3
import unicodedata
from collections import defaultdict
from datetime import date

PLANO = "PJ TOP INDIVIDUAL COM ODONTOLOGIA"
PLANO_ALIASES = ("PJ TOP INDIVIDUAL COM ODONTOLOGIA", "PJ TOP INDIVIDUAL COM ODONTOLO")

# Valores que a planilha dela usa no RESUMO.
VALOR_ODONTOART = 8.98
VALOR_REDE_SAUDE = 0.18
VALOR_PLANO_VIDA = 29.90  # preço de UMA vida do plano, para achar o título no S4E

MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho",
         "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"]

FAIXAS = ["1º PAGAMENTO", "2º PAGAMENTO", "3º OU MAIS PAGAMENTOS", "SEM DATA DE ADESÃO"]


def _sem_acento(texto):
    texto = unicodedata.normalize("NFKD", str(texto or ""))
    return "".join(c for c in texto if not unicodedata.combining(c)).upper().strip()


def _venc(linha):
    """Data de vencimento do título, se a apuração guardou."""
    try:
        return str(linha["vencimento"] or "")
    except (IndexError, KeyError):
        return ""


def _chave_empresa(nome):
    """Compara empresa ignorando o código S4E na frente ("5305 - NOME")."""
    nome = _sem_acento(nome)
    nome = re.sub(r"^\d+\s*-\s*", "", nome)
    nome = re.sub(r"[^A-Z0-9 ]", " ", nome)
    return re.sub(r"\s+", " ", nome).strip()


def competencia_padrao(hoje=None):
    """A competência que a tela abre: o mês anterior ao atual.

    Em novembro, outubro. Nunca o mês corrente, que ainda está faturando.
    """
    hoje = hoje or date.today()
    nome = MESES[hoje.month - 1]
    return competencia_anterior(f"{nome}/{hoje.year}")


def competencia_anterior(competencia):
    """'Novembro/2026' -> 'Outubro/2026'."""
    texto = str(competencia or "").strip()
    if "/" not in texto:
        return ""
    nome, ano = texto.split("/", 1)
    try:
        indice = [m.lower() for m in MESES].index(nome.strip().lower())
        ano = int(ano)
    except (ValueError, TypeError):
        return ""
    if indice == 0:
        return f"Dezembro/{ano - 1}"
    return f"{MESES[indice - 1]}/{ano}"


def _data(valor):
    texto = str(valor or "").strip()[:10]
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", texto):
        try:
            return date.fromisoformat(texto)
        except ValueError:
            return None
    return None


def _indice_competencia(competencia):
    """('Outubro/2026') -> (ano, mês 1..12) ou None."""
    nome, ano = (str(competencia or "").split("/") + [""])[:2]
    try:
        return int(ano), [m.lower() for m in MESES].index(nome.strip().lower()) + 1
    except (ValueError, TypeError):
        return None


def _meses_desde_adesao(adesao, competencia):
    """Quantos meses separam o mês da adesão do mês da competência (0 = mesmo mês)."""
    alvo = _indice_competencia(competencia)
    if not adesao or not alvo:
        return None
    ano, mes = alvo
    return (ano - adesao.year) * 12 + (mes - adesao.month)


def parcela(adesao, competencia):
    """O [PARC: n] da planilha: o mês da adesão já é a parcela 1."""
    diferenca = _meses_desde_adesao(adesao, competencia)
    if diferenca is None:
        return None
    return diferenca + 1


def primeiro_pagamento(adesao):
    """O [1º PGTO: aaaa/mm] da planilha."""
    if not adesao:
        return ""
    return f"{adesao.year}/{adesao.month:02d}"


def _faixa(adesao, competencia):
    """1º, 2º ou 3º pagamento — mesma conta da coluna PAGAMENTO da planilha."""
    diferenca = _meses_desde_adesao(adesao, competencia)
    if diferenca is None:
        return ""
    if diferenca <= 0:
        return "1º PAGAMENTO"
    if diferenca == 1:
        return "2º PAGAMENTO"
    return "3º OU MAIS PAGAMENTOS"


def _rotulo_plano(adesao, competencia):
    """A célula "Plano" exatamente como a Juliana escreve.

    PJ TOP INDIVIDUAL COM ODONTOLOGIA [1º PGTO: 2026/04] [PARC: 7]
    """
    n = parcela(adesao, competencia)
    if not adesao or n is None:
        return PLANO
    return f"{PLANO} [1º PGTO: {primeiro_pagamento(adesao)}] [PARC: {n}]"


def _plano(texto):
    return _sem_acento(texto).startswith("PJ TOP INDIVIDUAL COM ODONTOL")


def montar_controle(db, competencia):
    """Monta o controle ODONTOART da competência informada."""
    db.row_factory = sqlite3.Row
    vidas = [r for r in db.execute(
        "SELECT nome, cpf, empresa, parentesco, centro, valor, situacao, data, contrato "
        "FROM vidas_usuarios"
    ) if _plano(r["centro"])]

    run = db.execute(
        "SELECT id FROM apuracao_runs WHERE competencia_label = ? AND status = 'done' "
        "ORDER BY finished_at DESC LIMIT 1", (competencia,)
    ).fetchone()
    titulos = []
    if run:
        titulos = db.execute(
            "SELECT empresa, valor, vidas, situacao, data_pagamento, valor_recebido, vencimento "
            "FROM apuracao_rows WHERE run_id = ?", (run["id"],)
        ).fetchall()

    por_empresa = defaultdict(list)
    for linha in titulos:
        por_empresa[_chave_empresa(linha["empresa"])].append(linha)

    def titulo_da(empresa):
        """Títulos da empresa na competência — só com casamento EXATO de nome.

        Antes havia um casamento frouxo por 18 caracteres, e ele grudava
        "TKR COMERCIO DE SUCOS E ALIMENTOS LTDA" em "TK COMERCIO DE SUCOS...":
        as 16 vidas da TKR apareciam como pagas pelo título da TK. Nome de
        empresa é dado de negócio, não se adivinha por prefixo.
        """
        return por_empresa.get(_chave_empresa(empresa)) or []

    ativos, atraso, cancelados = [], [], []
    for vida in vidas:
        adesao = _data(vida["data"])
        titulos_empresa = titulo_da(vida["empresa"])
        faturado = round(sum(float(t["valor"] or 0) for t in titulos_empresa), 2)
        pago = round(sum(float(t["valor_recebido"] or 0) for t in titulos_empresa), 2)
        datas = [t["data_pagamento"] for t in titulos_empresa if t["data_pagamento"]]
        item = {
            "nome": vida["nome"],
            "cpf": vida["cpf"],
            "empresa": vida["empresa"],
            "parentesco": vida["parentesco"],
            "plano": _rotulo_plano(adesao, competencia),
            "valor": float(vida["valor"] or 0),
            "situacao": vida["situacao"],
            "adesao": vida["data"],
            "parcela": parcela(adesao, competencia),
            "primeiroPagamento": primeiro_pagamento(adesao),
            "faixa": _faixa(adesao, competencia),
            "contrato": vida["contrato"],
            "faturado": faturado,
            "recebido": pago,
            "pagamento": datas[0] if datas else "",
            "titulos": len(titulos_empresa),
        }
        if vida["situacao"] == "ATIVO":
            # Atraso é a vida ativa que NÃO teve o mês pago, e vale nas duas
            # pontas, como na planilha da Juliana:
            #   1) a EMPRESA não foi faturada na competência ("NÃO FATUROU"), ou
            #   2) a empresa foi faturada, mas o título dela ficou em aberto.
            if not titulos_empresa:
                item["motivo"] = "Empresa não faturada na competência"
                atraso.append(item)
            elif faturado > 0 and pago + 0.005 < faturado:
                item["motivo"] = "Título da empresa em aberto"
                atraso.append(item)
            else:
                ativos.append(item)
        elif vida["situacao"] == "CANCELADO":
            item["motivo"] = "Cancelada no S4E"
            cancelados.append(item)

    def resumo(lista):
        por_faixa = defaultdict(int)
        for item in lista:
            por_faixa[item["faixa"] or "SEM DATA DE ADESÃO"] += 1
        return {
            "total": len(lista),
            "valor": round(sum(i["valor"] for i in lista), 2),
            "faixas": {f: por_faixa.get(f, 0) for f in FAIXAS if por_faixa.get(f)},
        }

    # Quadro por empresa: o que ela tem, o que foi faturado e o que foi pago.
    # É o que mostra POR QUE a vida caiu em atraso — sem isso a tela não explica.
    quadro = {}
    for item in ativos + atraso + cancelados:
        chave = item["empresa"]
        linha = quadro.setdefault(chave, {
            "empresa": chave, "vidas": 0, "ativas": 0, "atraso": 0, "canceladas": 0,
            "faturado": 0.0, "recebido": 0.0, "titulos": 0, "motivo": "", "vencimento": "",
        })
        linha["vidas"] += 1
        if item in ativos:
            linha["ativas"] += 1
        elif item in atraso:
            linha["atraso"] += 1
            linha["motivo"] = linha["motivo"] or item.get("motivo", "")
        else:
            linha["canceladas"] += 1
        # faturado/recebido são do título da empresa: conta uma vez só
        if item["titulos"] and not linha["faturado"]:
            linha["faturado"] = item["faturado"]
            linha["recebido"] = item["recebido"]
            linha["titulos"] = item["titulos"]

    por_empresa_ativo = sorted(quadro.values(), key=lambda x: (-x["ativas"], -x["atraso"], x["empresa"]))

    empresas = sorted({v["empresa"] for v in vidas})

    # Conferência com o S4E: os títulos da competência cujo valor por vida é o
    # preço do plano. Serve para provar que a conta olhou a fonte certa.
    conferencia = []
    if run:
        for linha in titulos:
            try:
                qtd = int(linha["vidas"] or 0)
                total = float(linha["valor"] or 0)
            except (TypeError, ValueError):
                continue
            if qtd <= 0 or abs(total / qtd - VALOR_PLANO_VIDA) > 0.02:
                continue
            pago = float(linha["valor_recebido"] or 0)
            conferencia.append({
                "empresa": re.sub(r"^\d+\s*-\s*", "", str(linha["empresa"] or "")),
                "vidas": qtd,
                "valor": round(total, 2),
                "recebido": round(pago, 2),
                "pago": pago + 0.005 >= total,
                "vencimento": _venc(linha),
            })
        conferencia.sort(key=lambda x: (not x["pago"], x["empresa"]))

    return {
        "competencia": competencia,
        "temTitulos": bool(run),
        "plano": PLANO,
        "valores": {"odontoart": VALOR_ODONTOART, "redeSaude": VALOR_REDE_SAUDE},
        "empresas": len(empresas),
        "vidas": len(vidas),
        "ativos": ativos,
        "atraso": atraso,
        "cancelados": cancelados,
        "resumoAtivos": resumo(ativos),
        "resumoAtraso": resumo(atraso),
        "resumoCancelados": resumo(cancelados),
        "porEmpresa": por_empresa_ativo,
        "conferencia": conferencia,
        "resumoFinanceiro": _resumo_financeiro(ativos),
    }


def _resumo_financeiro(ativos):
    """O quadro RESUMO da planilha: quantidade por faixa e os dois valores.

    Regra do arquivo da Juliana:
      1º e 2º pagamento -> R$ 8,98 na coluna Odontoart E R$ 8,98 na Rede Saúde
      3º pagamento ou mais -> R$ 8,98 na Odontoart e R$ 0,18 na Rede Saúde
    """
    por_faixa = defaultdict(int)
    for item in ativos:
        por_faixa[item["faixa"] or "SEM DATA DE ADESÃO"] += 1
    linhas = []
    for faixa in FAIXAS:
        if faixa == "SEM DATA DE ADESÃO":
            continue
        qtd = por_faixa.get(faixa, 0)
        # Até o 2º pagamento a Rede Saúde cobra o mesmo valor cheio.
        rede = VALOR_ODONTOART if faixa in ("1º PAGAMENTO", "2º PAGAMENTO") else VALOR_REDE_SAUDE
        linhas.append({
            "faixa": faixa,
            "quantidade": qtd,
            "odontoart": round(qtd * VALOR_ODONTOART, 2),
            "redeSaude": round(qtd * rede, 2),
            "valorRede": rede,
        })
    total = sum(l["quantidade"] for l in linhas)
    return {
        "linhas": linhas,
        "total": {
            "quantidade": total,
            "odontoart": round(sum(l["odontoart"] for l in linhas), 2),
            "redeSaude": round(sum(l["redeSaude"] for l in linhas), 2),
        },
    }


def competencias_disponiveis(db):
    linhas = db.execute(
        "SELECT DISTINCT competencia_label FROM apuracao_runs WHERE status = 'done' "
        "ORDER BY finished_at DESC"
    ).fetchall()
    vistas, saida = set(), []
    for (rotulo,) in linhas:
        if rotulo and rotulo not in vistas:
            vistas.add(rotulo)
            saida.append(rotulo)
    return saida


def _celulas(lista, com_faixa=True):
    """Linhas de vida no formato da planilha dela."""
    saida = []
    for i in lista:
        linha = [i["nome"], i["cpf"], i["empresa"], i["parentesco"], i["plano"], i["valor"]]
        if com_faixa:
            linha.append(i["faixa"])
        saida.append(linha)
    return saida


def exportar_xlsx(dados):
    """Gera o Excel no mesmo modelo do arquivo que a Juliana monta à mão."""
    import xlsx_simple

    cabecalho = ["Nome", "CPF", "EMPRESA", "Parentesco", "Plano", "Valor"]

    # ODONTO — vidas ativas, com a coluna PAGAMENTO no fim
    odonto = [cabecalho + ["PAGAMENTO"]] + _celulas(dados["ativos"])
    odonto.append([])
    odonto.append(["TOTAL DE VIDAS ATIVAS COM ODONTO", dados["resumoAtivos"]["total"]])

    # RESUMO DE VIDAS ATIVAS — contagem por empresa
    empresas = [["Rótulos de Linha", "Contagem de EMPRESA"]]
    # No Excel vale o modelo dela: só as vidas ATIVAS por empresa.
    empresas += [[e["empresa"], e["ativas"]] for e in dados["porEmpresa"] if e["ativas"]]
    empresas.append(["Total Geral", dados["resumoAtivos"]["total"]])

    # ATRASO — sem a coluna PAGAMENTO; a observação vai na última coluna
    atraso = [cabecalho + ["OBS"]] + [
        [i["nome"], i["cpf"], i["empresa"], i["parentesco"], i["plano"], i["valor"],
         i.get("motivo", "")] for i in dados["atraso"]]
    atraso.append([])
    atraso.append(["TOTAL USUÁRIOS EM ATRASO", dados["resumoAtraso"]["total"]])

    # CANCELAMENTOS — Plano, Valor, CONF, ULT. PGTO
    cancelados = [cabecalho + ["CONF", "ULT. PGTO"]]
    for i in dados["cancelados"]:
        cancelados.append([i["nome"], i["cpf"], i["empresa"], i["parentesco"], i["plano"],
                           i["valor"], i["faixa"], i["pagamento"]])
    cancelados.append([])
    cancelados.append(["TOTAL DE CANCELAMENTOS", dados["resumoCancelados"]["total"]])

    # RESUMO — quantidade por faixa e os dois valores
    financeiro = dados["resumoFinanceiro"]
    resumo = [["RESUMO", "QUANT.", "ODONTOART EMITE NF E BOLETO", "REDE SAÚDE EMITE NF E BOLETO"]]
    for linha in financeiro["linhas"]:
        resumo.append([linha["faixa"], linha["quantidade"], linha["odontoart"], linha["redeSaude"]])
    total = financeiro["total"]
    resumo.append(["TOTAL", total["quantidade"], total["odontoart"], total["redeSaude"]])

    return xlsx_simple.build([
        ("ODONTO", odonto),
        ("RESUMO DE VIDAS ATIVAS", empresas),
        ("ATRASO", atraso),
        ("CANCELAMENTOS", cancelados),
        ("RESUMO", resumo),
    ])
