"""Conferência automática de adesões — sem copiar e colar entre telas.

Percorre as mesmas telas que ela percorre, só que pelos arquivos que o portal já
guarda:

1. Entrada de Contratos (vendas_snapshots): o lote existe, com a mesma data, a
   mesma quantidade de vidas e o mesmo valor.
2. Movimentação de Vidas (vidas_usuarios): as vidas da empresa entraram no dia.
3. Faturamento (cópia do relatório do S4E): a primeira parcela da empresa vence
   na data de adesão e cobre as vidas e o valor da adesão.
4. Pagamento: a mesma parcela já aparece paga no faturamento.

Notas entram como informação. Regra de ouro: o que não pode ser
conferido fica PENDENTE com o motivo escrito.
"""

from __future__ import annotations

import json
import re
import unicodedata
import uuid
from pathlib import Path
from datetime import date, datetime, timedelta

import xlsx_simple

STATUS = ("conferido", "divergente", "pendente")
LABELS = {
    "conferido": "Conferido",
    "divergente": "Divergente",
    "pendente": "Pendente",
}
SOURCES = ("vendas", "vidas", "s4e", "pagamento", "notas")
ROOT = Path(__file__).resolve().parent
FATURAMENTO_CACHE = ROOT / ".s4e_faturamento_cache.json"
TIPOS_PARCELA = ("PLANO", "ADESAO")
AUTO_KEY = "adesoes_auto_last"
AUTO_HORARIOS = (10, 16)


def ensure_schema(db):
    """Garante a tabela `adesoes` e as colunas novas (origem, código, parcela)."""
    db.execute(
        """CREATE TABLE IF NOT EXISTS adesoes (
            id TEXT PRIMARY KEY,
            lote TEXT NOT NULL,
            empresa TEXT NOT NULL,
            data_entrada TEXT NOT NULL,
            data_adesao TEXT NOT NULL,
            vidas INTEGER NOT NULL,
            valor REAL NOT NULL,
            tipo TEXT NOT NULL CHECK(tipo IN ('WEB', 'CRM')),
            situacao TEXT,
            conferencia_status TEXT DEFAULT 'pendente'
                CHECK(conferencia_status IN ('pendente', 'conferido', 'divergente')),
            conferencia_resultado TEXT,
            notas_conferencia TEXT,
            conferido_em TEXT,
            conferido_por TEXT,
            criado_em TEXT DEFAULT CURRENT_TIMESTAMP,
            atualizado_em TEXT DEFAULT CURRENT_TIMESTAMP
        )"""
    )
    existing = {row[1] for row in db.execute("PRAGMA table_info(adesoes)")}
    for column, ddl in (
        ("origem", "TEXT NOT NULL DEFAULT 'planilha'"),
        ("codigo", "TEXT NOT NULL DEFAULT ''"),
        ("parcela", "TEXT NOT NULL DEFAULT ''"),
        ("empresa_venda", "TEXT NOT NULL DEFAULT ''"),
        ("equipe", "TEXT NOT NULL DEFAULT ''"),
    ):
        if column not in existing:
            db.execute(f"ALTER TABLE adesoes ADD COLUMN {column} {ddl}")
    db.execute("CREATE INDEX IF NOT EXISTS idx_adesoes_lote ON adesoes(lote)")
    db.execute("CREATE INDEX IF NOT EXISTS idx_adesoes_empresa ON adesoes(empresa)")
    db.execute("CREATE INDEX IF NOT EXISTS idx_adesoes_data_entrada ON adesoes(data_entrada)")
    db.commit()


# ── utilidades ──────────────────────────────────────────────────────────────
def norm(value) -> str:
    text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode().upper()
    text = re.sub(r"[^A-Z0-9 ]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def company_code(value) -> str:
    """Código da empresa no S4E: 'SERVAL SERVICOS E LIMPEZA LTDA - 2425 - PJ' → '2425'."""
    texto = str(value or "").strip()
    if re.fullmatch(r"\d+", texto):
        return texto
    achados = re.findall(r"-\s*(\d{1,6})\s*(?=-|$)", texto)
    if achados:
        return achados[-1]
    match = re.match(r"^\s*(\d+)\s*-", texto)
    return match.group(1) if match else ""


def company_name(value) -> str:
    """'EXEMPLAR SERVICOS E LIMPEZA - 2471 - PJ' → 'EXEMPLAR SERVICOS E LIMPEZA'."""
    text = str(value or "").strip()
    text = re.sub(r"\s*-\s*(PJ|PF)\s*$", "", text, flags=re.I)
    text = re.sub(r"\s*-\s*\d+\s*$", "", text)
    text = re.sub(r"^\s*\d+\s*-\s*", "", text)
    return text.strip()


def iso_date(value) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})", text)
    if match:
        return match.group(0)
    match = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2,4})$", text)
    if match:
        day, month, year = match.groups()
        year = year if len(year) == 4 else f"20{year}"
        return f"{year}-{int(month):02d}-{int(day):02d}"
    try:
        serial = float(text)
    except ValueError:
        return ""
    if serial < 20000:
        return ""
    return (date(1899, 12, 30) + timedelta(days=int(serial))).isoformat()


def br_date(value) -> str:
    iso = iso_date(value)
    if not iso:
        return ""
    year, month, day = iso.split("-")
    return f"{day}/{month}/{year}"


def month_label(iso: str) -> str:
    """2026-01-20 → 'Janeiro/2026' (formato usado pela Apuração)."""
    if not iso or len(iso) < 7:
        return ""
    months = ("Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho",
              "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro")
    try:
        return f"{months[int(iso[5:7]) - 1]}/{iso[:4]}"
    except (ValueError, IndexError):
        return ""


def money(value) -> float:
    if value in (None, ""):
        return 0.0
    if isinstance(value, (int, float)):
        return round(float(value), 2)
    text = str(value).strip().replace("R$", "").replace(" ", "")
    if "," in text and "." in text:
        text = text.replace(".", "").replace(",", ".")
    elif "," in text:
        text = text.replace(",", ".")
    try:
        return round(float(text), 2)
    except ValueError:
        return 0.0


def fmt_money(value) -> str:
    return f"R$ {money(value):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def cliente_codigo(value) -> str:
    """'4078 - SECRETARIA DE EDUCACAO' → '4078' (o código vem antes do nome no faturamento)."""
    match = re.match(r"^\s*(\d{1,6})\s*-\s*\S", str(value or ""))
    return match.group(1) if match else ""


_DIAS_MES = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)


def _dias_no_mes(ano: int, mes: int) -> int:
    if mes == 2 and ano % 4 == 0 and (ano % 100 != 0 or ano % 400 == 0):
        return 29
    return _DIAS_MES[mes - 1]


def add_month(iso: str, months: int = 1) -> str:
    """Soma meses a uma data ISO, mantendo o dia quando ele existir no mês de destino."""
    if not iso or len(iso) < 10:
        return ""
    total = int(iso[:4]) * 12 + (int(iso[5:7]) - 1) + months
    ano, mes = divmod(total, 12)
    mes += 1
    dia = min(int(iso[8:10]), _dias_no_mes(ano, mes))
    return f"{ano:04d}-{mes:02d}-{dia:02d}"


def name_similar(a: str, b: str) -> bool:
    """Compara razões sociais tolerando sufixos e abreviações comuns."""
    left, right = norm(a), norm(b)
    if not left or not right:
        return False
    if left == right:
        return True
    left = re.sub(r"\b(LTDA|EIRELI|SA|ME|EPP|PJ|PF)\b", "", left).strip()
    right = re.sub(r"\b(LTDA|EIRELI|SA|ME|EPP|PJ|PF)\b", "", right).strip()
    if left == right:
        return True
    if len(left) >= 12 and len(right) >= 12 and (left.startswith(right) or right.startswith(left)):
        return True
    return False


# ── fontes de conferência ───────────────────────────────────────────────────
_VENDAS_CACHE = None
_CLIENTES_CACHE = None


def vendas_do_s4e(db):
    """Entrada de Contratos do S4E agrupada por dia + lote + empresa.

    É a mesma conferência feita à mão: cada lote traz a empresa, a data de
    cadastro, quantas vidas entraram e o valor. O portal já guarda essas consultas
    em `vendas_snapshots`; aqui elas viram uma lista pronta para conferir.
    """
    global _VENDAS_CACHE
    try:
        marca = db.execute("SELECT COALESCE(MAX(id), 0), COUNT(*) FROM vendas_snapshots").fetchone()
        chave_cache = (marca[0], marca[1])
    except Exception:  # noqa: BLE001
        chave_cache = (0, 0)
    if _VENDAS_CACHE and _VENDAS_CACHE[0] == chave_cache:
        return _VENDAS_CACHE[1]

    registros = {}
    periodos = {}
    for row in db.execute("SELECT id, start_date, end_date, checked_at, payload FROM vendas_snapshots ORDER BY id"):
        try:
            payload = json.loads(row["payload"])
        except (TypeError, ValueError):
            continue
        periodos[(row["start_date"], row["end_date"])] = row["checked_at"]
        for item in payload.get("rows") or []:
            if item.get("kind") != "sale":
                continue
            dia = iso_date(item.get("registeredAt"))
            lote = str(item.get("batch") or "").strip()
            if not dia or not lote:
                continue
            chave = item.get("key") or "|".join(
                [dia, lote, str(item.get("company") or ""), str(item.get("client") or "")])
            registros[chave] = item

    grupos = {}
    for item in registros.values():
        dia = iso_date(item.get("registeredAt"))
        lote = str(item.get("batch") or "").strip()
        empresa = str(item.get("company") or "").strip()
        grupo = grupos.setdefault((dia, lote, norm(empresa)), {
            "dia": dia, "lote": lote, "empresa": empresa,
            "vidas": 0, "valor": 0.0, "cancelados": 0, "equipes": set(),
        })
        grupo["vidas"] += 1
        grupo["valor"] = round(grupo["valor"] + money(item.get("value")), 2)
        if norm(item.get("status")).startswith("CANCEL"):
            grupo["cancelados"] += 1
        grupo["equipes"].add(str(item.get("team") or "").strip())

    lista = []
    por_lote = {}
    for grupo in grupos.values():
        grupo["equipes"] = sorted(nome for nome in grupo["equipes"] if nome)
        # A Entrada de Contratos mostra a equipe na coluna própria; "APP" é o
        # mesmo canal que a tela dela chama de WEB.
        nomes = ["WEB" if norm(nome) == "APP" else nome for nome in grupo["equipes"]]
        grupo["equipe"] = " · ".join(dict.fromkeys(nomes))
        grupo["tipo"] = "WEB" if any(norm(nome) == "APP" for nome in grupo["equipes"]) else "CRM"
        lista.append(grupo)
        por_lote.setdefault(grupo["lote"], []).append(grupo)
    for itens in por_lote.values():
        itens.sort(key=lambda item: (item["dia"], item["empresa"]))
    lista.sort(key=lambda item: (item["dia"], item["lote"], item["empresa"]))

    resultado = {
        "grupos": lista,
        "por_lote": por_lote,
        "periodos": [{"inicio": inicio, "fim": fim, "em": em}
                     for (inicio, fim), em in sorted(periodos.items())],
        "registros": len(registros),
    }
    _VENDAS_CACHE = (chave_cache, resultado)
    return resultado


def clientes_faturamento():
    """Lista de clientes do faturamento do S4E (código, nome e as parcelas de cada um)."""
    global _CLIENTES_CACHE
    try:
        stat = FATURAMENTO_CACHE.stat()
        chave = (stat.st_mtime, stat.st_size)
    except OSError:
        return {"por_codigo": {}, "por_nome": {}, "info": {}}
    if _CLIENTES_CACHE and _CLIENTES_CACHE[0] == chave:
        return _CLIENTES_CACHE[1]
    try:
        dados = json.loads(FATURAMENTO_CACHE.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {"por_codigo": {}, "por_nome": {}, "info": {}}

    por_codigo, por_nome, por_parcela = {}, {}, {}
    linhas = dados.get("linhas") or []
    for linha in linhas:
        codigo = cliente_codigo(linha.get("cliente"))
        if not codigo:
            continue
        por_codigo.setdefault(codigo, []).append(linha)
        numero = str(linha.get("parcela") or "").strip()
        if numero:
            por_parcela[numero] = linha
        nome = re.sub(r"^\s*\d+\s*-\s*", "", str(linha.get("cliente") or "")).strip()
        if nome:
            por_nome.setdefault(norm(nome), set()).add(codigo)
    for itens in por_codigo.values():
        itens.sort(key=lambda item: (iso_date(item.get("vencimento")), iso_date(item.get("gerado"))))
    resultado = {
        "por_codigo": por_codigo,
        "por_nome": {nome: sorted(codigos) for nome, codigos in por_nome.items()},
        "por_parcela": por_parcela,
        "info": {"inicio": dados.get("inicio") or "", "fim": dados.get("fim") or "", "linhas": len(linhas)},
    }
    _CLIENTES_CACHE = (chave, resultado)
    return resultado


def resolver_codigo(nome, codigos_por_nome, nome_por_codigo):
    """Descobre o código S4E da empresa a partir do nome (faturamento + histórico)."""
    chave = norm(nome)
    if not chave:
        return ""
    codigos = codigos_por_nome.get(chave) or []
    if len(set(codigos)) == 1:
        return codigos[0]
    if len(set(codigos)) > 1:
        return max(set(codigos), key=lambda item: len(nome_por_codigo.get(item, [])))
    similares = sorted({
        codigo for outro, lista in codigos_por_nome.items()
        if name_similar(outro, chave) for codigo in lista
    })
    return similares[0] if len(similares) == 1 else ""


def escolher_parcela(por_codigo, codigo, entrada):
    """Primeira parcela que cobre a entrada: (linha, modo, vencimento projetado)."""
    linhas = [
        item for item in por_codigo.get(str(codigo or ""), [])
        if norm(item.get("tipoParcela")) in TIPOS_PARCELA and iso_date(item.get("vencimento"))
    ]
    if not linhas:
        return None, "", ""
    linhas.sort(key=lambda item: iso_date(item.get("vencimento")))
    if entrada:
        seguintes = [item for item in linhas if iso_date(item.get("vencimento")) >= entrada]
        if seguintes:
            return seguintes[0], "confirmada", ""
    dia_venc = iso_date(linhas[-1].get("vencimento"))[8:10]
    projetado = ""
    if entrada:
        projetado = f"{entrada[:8]}{dia_venc}"
        if projetado < entrada:
            projetado = add_month(projetado, 1)
    return None, "projetada" if projetado else "", projetado


class Fontes:
    """Carrega, de uma vez, o que o banco já sabe. Nada de N+1 por adesão."""

    def __init__(self, db):
        self.db = db
        self.nominais = []
        import_row = db.execute(
            "SELECT id, arquivo, importado_em, inicio, fim FROM vidas_importacoes "
            "WHERE origem = 's4e' ORDER BY importado_em DESC LIMIT 1"
        ).fetchone()
        if not import_row:
            import_row = db.execute(
                "SELECT id, arquivo, importado_em, inicio, fim FROM vidas_importacoes "
                "ORDER BY importado_em DESC LIMIT 1"
            ).fetchone()
        self.import_nominal = dict(import_row) if import_row else None
        if import_row:
            for row in db.execute(
                "SELECT nome, empresa, situacao, data, contrato, cpf FROM vidas_usuarios WHERE import_id = ?",
                (import_row["id"],),
            ):
                self.nominais.append(dict(row))
        # Índice por (empresa, dia): a conferência olha quantas vidas
        # entraram naquela empresa naquele dia.
        self.nominais_por_empresa_dia = {}
        self.nominais_por_empresa = {}
        for item in self.nominais:
            key = norm(company_name(item["empresa"]))
            self.nominais_por_empresa.setdefault(key, []).append(item)
            dia = iso_date(item.get("data"))
            if dia:
                self.nominais_por_empresa_dia.setdefault((key, dia), []).append(item)

        # Fica só com a apuração mais recente: comparar com run antiga gera ruído.
        self.apuracao_rows = []
        if self._has_table("apuracao_rows"):
            run = db.execute(
                "SELECT run_id FROM apuracao_rows ORDER BY rowid DESC LIMIT 1"
            ).fetchone()
            if run:
                for row in db.execute(
                    "SELECT competencia, empresa, documento, valor, vidas, parcela, gerado, situacao "
                    "FROM apuracao_rows WHERE run_id = ?",
                    (run["run_id"],),
                ):
                    self.apuracao_rows.append(dict(row))

        # Faturamento (a parcela de cada empresa) e Entrada de Contratos (o lote
        # de cada adesão): as duas telas conferidas. As cópias ficam
        # no servidor, então a conferência não depende de abrir o S4E de novo.
        cadastro = clientes_faturamento()
        self.faturamento_info = cadastro["info"]
        self.fat_por_codigo = cadastro["por_codigo"]
        self.codigos_por_nome = {nome: list(codigos) for nome, codigos in cadastro["por_nome"].items()}
        self.nome_por_codigo = {}
        self.adesoes_por_dia = {}
        try:
            linhas_ad = db.execute("SELECT empresa, codigo, data_entrada, vidas, lote FROM adesoes")
        except Exception:  # noqa: BLE001
            linhas_ad = db.execute("SELECT empresa, '' AS codigo, data_entrada, vidas, lote FROM adesoes")
        for row in linhas_ad:
            codigo = str(row["codigo"] or "") or company_code(row["empresa"])
            nome = company_name(row["empresa"])
            chave_nome = norm(nome)
            if codigo:
                self.nome_por_codigo.setdefault(codigo, []).append(nome)
            if chave_nome:
                self.codigos_por_nome.setdefault(chave_nome, [])
                if codigo and codigo not in self.codigos_por_nome[chave_nome]:
                    self.codigos_por_nome[chave_nome].append(codigo)
                if row["data_entrada"]:
                    self.adesoes_por_dia.setdefault((row["data_entrada"], codigo or chave_nome), []).append(row)
        self.vendas = vendas_do_s4e(db)
        self.cache = {}

    def _has_table(self, name):
        return bool(self.db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
        ).fetchone())

    def entradas_no_dia(self, nome_ad, data_iso):
        """Quantas vidas entraram nessa empresa nesse dia (ativas e canceladas)."""
        if not data_iso:
            return None
        key = norm(company_name(nome_ad))
        lista = self.nominais_por_empresa_dia.get((key, data_iso))
        if lista is None:
            for chave, dia in self.nominais_por_empresa_dia:
                if dia == data_iso and name_similar(chave, key):
                    lista = self.nominais_por_empresa_dia[(chave, dia)]
                    break
        if lista is None:
            return None
        ativos = [item for item in lista if str(item.get("situacao") or "").upper().startswith("ATIV")]
        return {"todos": len(lista), "ativos": len(ativos), "lista": lista}

    # vida nominal
    def nominal(self, nome_ad, data_iso=""):
        key = norm(company_name(nome_ad))
        lista = self.nominais_por_empresa.get(key)
        if not lista:
            lista = [
                item for chave, itens in self.nominais_por_empresa.items()
                if name_similar(chave, key) for item in itens
            ]
        if not lista:
            return None, 0
        if data_iso:
            no_dia = [item for item in lista if iso_date(item.get("data")) == data_iso]
            if no_dia:
                return no_dia[0], len(no_dia)
        return lista[0], 0

    # apuração / notas
    def titulo(self, nome_ad, data_iso, vidas=0, valor=0.0):
        if not data_iso:
            return None
        competencia = month_label(data_iso)
        if not competencia:
            return None
        candidatos = [
            row for row in self.apuracao_rows
            if norm(row.get("competencia")) == norm(competencia)
            and name_similar(row.get("empresa") or "", company_name(nome_ad))
        ]
        if not candidatos:
            return None
        if vidas:
            iguais = [row for row in candidatos if int(round(float(row.get("vidas") or 0))) == int(vidas)]
            if iguais:
                candidatos = iguais
        if valor:
            proximo = min(candidatos, key=lambda row: abs(money(row.get("valor")) - float(valor)))
            return proximo
        return candidatos[0]

    # Entrada de Contratos (o lote)
    def cobre(self, dia):
        return bool(dia) and any(item["inicio"] <= dia <= item["fim"] for item in self.vendas["periodos"])

    def resolver_codigo(self, nome):
        return resolver_codigo(nome, self.codigos_por_nome, self.nome_por_codigo)

    def empregadora(self, codigo, nome_ad=""):
        """Nome real da empregadora — o faturamento às vezes traz só o cliente pagador."""
        nomes = self.nome_por_codigo.get(str(codigo or ""))
        if nomes:
            return max(set(nomes), key=nomes.count)
        return company_name(nome_ad)

    def venda(self, lote, dia="", codigo="", nome_ad=""):
        lote = str(lote or "").strip()
        candidatos = self.vendas["por_lote"].get(lote) or []
        if not candidatos:
            return None
        if dia:
            # O lote volta a ser usado em outros meses: só vale a entrada do dia.
            candidatos = [item for item in candidatos if item["dia"] == dia]
            if not candidatos:
                return None
        if codigo:
            com_codigo = [item for item in candidatos
                          if self.resolver_codigo(item["empresa"]) == str(codigo)]
            if com_codigo:
                candidatos = com_codigo
        if nome_ad and len(candidatos) > 1:
            iguais = [item for item in candidatos
                      if name_similar(item["empresa"], company_name(nome_ad))]
            if len(iguais) == 1:
                return iguais[0]
        return candidatos[0] if candidatos else None

    def vidas_previstas_no_dia(self, codigo, nome_ad, dia):
        """Soma das adesões do mesmo dia/empresa: dois lotes no dia entram juntos.

        É assim que a conferência fecha: o dia da empresa tem que bater com as
        vidas que entraram, mesmo que a entrada tenha sido em mais de um lote.
        """
        total, achou = 0, False
        chave_nome = norm(nome_ad)
        for (data, chave), linhas in self.adesoes_por_dia.items():
            if data != dia:
                continue
            if codigo and chave == codigo:
                pass
            elif not (chave == chave_nome or name_similar(chave, chave_nome)):
                continue
            achou = True
            total += sum(int(item["vidas"] or 0) for item in linhas)
        return total if achou else 0

    def empresa_por_contagem(self, dia, vidas):
        """Nome da empresa que teve exatamente essa quantidade de vidas naquele dia."""
        achados = {}
        for (chave, data), linhas in self.nominais_por_empresa_dia.items():
            if data != dia:
                continue
            ativos = sum(1 for item in linhas
                         if str(item.get("situacao") or "").upper().startswith("ATIV"))
            if vidas and vidas in (len(linhas), ativos):
                achados[chave] = (linhas[0].get("empresa") or chave)
        return next(iter(achados.values())) if len(achados) == 1 else ""

    # Parcela do faturamento
    def parcela(self, codigo, entrada):
        return escolher_parcela(self.fat_por_codigo, codigo, entrada)


# ── conferência de uma adesão ───────────────────────────────────────────────
def conferir(adesao, fontes: Fontes, s4e_cache=None):
    """Confere a adesão nas telas do S4E.

    1. Entrada de Contratos (S4E): o lote existe, com a mesma quantidade de
       vidas e o mesmo valor.
    2. Movimentação de Vidas (S4E): as vidas daquela empresa entraram no dia.
    3. Faturamento (S4E): a parcela da empresa cobre a adesão e vence na data
       de adesão anotada.
    4. Pagamento: essa parcela já aparece paga no faturamento.
    Notas entram como informação, sem travar a conferência.
    """
    checks = []
    fontes_result = {}
    erros = 0
    pendentes = 0

    def anotar(fonte, ok, detalhe, informativo=False):
        nonlocal erros, pendentes
        checks.append({"fonte": fonte, "ok": ok, "detalhe": detalhe, "informativo": informativo})
        if informativo:
            return
        if ok is False:
            erros += 1
        elif ok is None:
            pendentes += 1

    nome_ad = adesao.get("empresa") or ""
    codigo = str(_campo(adesao, "codigo") or "") or company_code(nome_ad)
    entrada = iso_date(adesao.get("data_entrada"))
    adesao_iso = iso_date(adesao.get("data_adesao"))
    vidas = int(adesao.get("vidas") or 0)
    valor = money(adesao.get("valor"))
    lote = str(adesao.get("lote") or "").strip()
    situacao = norm(adesao.get("situacao"))
    nome_venda = str(_campo(adesao, "empresa_venda") or "").strip()

    if not codigo:
        codigo = fontes.resolver_codigo(nome_venda or nome_ad)
    if codigo:
        fontes_result["empresaCodigo"] = codigo

    # 1. Entrada de Contratos — o lote, as vidas e o valor
    grupo = None
    if not entrada:
        anotar("vendas", None, "Adesão sem data de entrada para procurar o lote")
    elif not fontes.cobre(entrada):
        anotar("vendas", None,
               f"Sem consulta de vendas do S4E para {br_date(entrada)} — use Gerar do S4E para trazer este mês")
    elif not lote:
        anotar("vendas", None, "Adesão sem o número do lote — o lote vem da Entrada de Contratos do S4E")
    else:
        grupo = fontes.venda(lote, entrada, codigo, nome_ad)
        if not grupo:
            anotar("vendas", None,
                   f"Lote {lote} não aparece na Entrada de Contratos do S4E em {br_date(entrada)}")
        else:
            fontes_result["vendas"] = {
                "situacao": "ok", "lote": lote, "dia": br_date(grupo["dia"]),
                "empresa": grupo["empresa"], "vidas": grupo["vidas"], "valor": grupo["valor"],
            }
            bate_vidas = not vidas or grupo["vidas"] == vidas
            bate_valor = not valor or abs(grupo["valor"] - valor) <= 0.05
            if bate_vidas and bate_valor:
                anotar("vendas", True,
                       f"Lote {lote} confere: {grupo['vidas']} vida(s), {fmt_money(grupo['valor'])}, "
                       f"cadastro em {br_date(grupo['dia'])}")
            else:
                partes = []
                if not bate_vidas:
                    partes.append(f"{grupo['vidas']} vida(s) no S4E x {vidas} na adesão")
                if not bate_valor:
                    partes.append(f"{fmt_money(grupo['valor'])} no S4E x {fmt_money(valor)} na adesão")
                anotar("vendas", False, "Divergência no lote: " + "; ".join(partes))

    # 2. Movimentação de Vidas — quantas vidas entraram no dia (informação)
    # O relatório usa a razão social e datas de adesão (às vezes em bloco), então
    # ele não decide a conferência: serve para mostrar o que a ficha mostra na
    # ficha da empresa. O veredito fica no lote e na parcela.
    periodo = fontes.import_nominal or {}
    inicio_periodo = iso_date(periodo.get("inicio"))
    fim_periodo = iso_date(periodo.get("fim"))
    fora_do_periodo = bool(
        entrada and inicio_periodo and fim_periodo
        and not (inicio_periodo <= entrada <= fim_periodo)
    )
    empregadora = fontes.empregadora(codigo, nome_ad)
    if fora_do_periodo:
        fontes_result["vidas"] = {
            "situacao": "fora_do_periodo",
            "periodo": f"{br_date(inicio_periodo)} a {br_date(fim_periodo)}",
        }
        anotar("vidas", None,
               f"Movimentação de Vidas cobre {br_date(inicio_periodo)} a {br_date(fim_periodo)} — "
               f"a entrada é {br_date(entrada)}", informativo=True)
    elif not entrada:
        anotar("vidas", None, "Adesão sem data de entrada para comparar", informativo=True)
    else:
        entradas = fontes.entradas_no_dia(empregadora, entrada)
        if not entradas and nome_venda and norm(nome_venda) != norm(empregadora):
            entradas = fontes.entradas_no_dia(nome_venda, entrada)
            if entradas:
                empregadora = nome_venda
        previstas = fontes.vidas_previstas_no_dia(codigo, empregadora or nome_ad, entrada)
        if not previstas and grupo:
            previstas = grupo["vidas"]
        if not entradas:
            fontes_result["vidas"] = {"situacao": "ausente", "empresa": empregadora,
                                      "dia": br_date(entrada)}
            anotar("vidas", None,
                   f"Movimentação de Vidas sem {empregadora or 'empresa'} em {br_date(entrada)} "
                   f"(o relatório usa a razão social)", informativo=True)
        else:
            todos, ativos = entradas["todos"], entradas["ativos"]
            fontes_result["vidas"] = {
                "situacao": "ok" if previstas in (todos, ativos) else "divergente",
                "empresa": empregadora,
                "entradasNoDia": todos,
                "entradasAtivas": ativos,
                # Quem entrou naquele dia, com a situação da ficha — é o que a
                # conferência abre na Movimentação de Vidas para bater nome por nome.
                "pessoas": [
                    {"nome": item.get("nome") or "", "situacao": item.get("situacao") or ""}
                    for item in entradas["lista"]
                ][:500],
                "fonte": periodo.get("arquivo") or "",
            }
            if previstas in (todos, ativos):
                anotar("vidas", True,
                       f"{ativos} vida(s) ativa(s) de {empregadora} entraram em {br_date(entrada)} "
                       f"— fecha com as adesões do dia ({previstas})", informativo=True)
            else:
                anotar("vidas", None,
                       f"{empregadora} tem {todos} entrada(s) ({ativos} ativa(s)) em {br_date(entrada)}; "
                       f"as adesões do dia somam {previstas} — confira na ficha da empresa",
                       informativo=True)

    # 3. Faturamento — a parcela da empresa
    linha = None
    if not codigo:
        fontes_result["s4e"] = {"situacao": "sem_codigo",
                                "detalhe": "Código da empresa não identificado no S4E"}
        anotar("s4e", None,
               "Código da empresa não identificado no S4E — sem ele não dá para abrir a parcela")
    elif not entrada:
        anotar("s4e", None, "Adesão sem data de entrada para localizar a parcela")
    else:
        linha, modo, venc_projetado = fontes.parcela(codigo, entrada)
        if linha:
            venc = iso_date(linha.get("vencimento"))
            valor_p = money(linha.get("valor"))
            vidas_p = int(money(linha.get("vidas")))
            partes = []
            if vidas and vidas_p and vidas_p < vidas:
                partes.append(f"parcela com {vidas_p} vida(s), a adesão tem {vidas}")
            if valor and valor_p + 0.05 < valor:
                partes.append(f"parcela de {fmt_money(valor_p)} é menor que a adesão de {fmt_money(valor)}")
            if adesao_iso and venc and adesao_iso != venc:
                partes.append(f"a adesão informa {br_date(adesao_iso)}, o S4E vence em {br_date(venc)}")
            detalhe = (f"Parcela {linha.get('parcela') or '—'} · {linha.get('competencia') or '—'} · "
                       f"{vidas_p} vida(s) · {fmt_money(valor_p)} · venc. {br_date(venc)}"
                       + (f" · NF {linha.get('nf')}" if linha.get("nf") else "")
                       + (f" · lote NFSe {linha.get('nfLote')}" if linha.get("nfLote") else ""))
            fontes_result["s4e"] = {
                "situacao": "ok" if not partes else "divergente",
                "cliente": linha.get("cliente") or "",
                "vidas": vidas_p,
                "valor": valor_p,
                "gerado": linha.get("gerado") or "",
                "vencimento": venc,
                "parcela": linha.get("parcela") or "",
                "nf": linha.get("nf") or "",
                "nfLote": linha.get("nfLote") or "",
                "situacaoTitulo": linha.get("situacao") or "",
            }
            if partes:
                anotar("s4e", False, detalhe + " — " + "; ".join(partes))
            else:
                anotar("s4e", True, detalhe)
        elif modo == "projetada":
            fontes_result["s4e"] = {"situacao": "projetada", "vencimento": venc_projetado}
            anotar("s4e", None,
                   f"A parcela desta empresa ainda não aparece no faturamento do S4E; a data de adesão "
                   f"foi projetada pelo vencimento habitual ({br_date(venc_projetado)}). "
                   f"Confira de novo depois da geração da fatura.")
        else:
            fontes_result["s4e"] = {"situacao": "ausente", "detalhe": f"Sem parcela para o código {codigo}"}
            anotar("s4e", None,
                   f"Nenhuma parcela da empresa {codigo} foi encontrada no faturamento do S4E")

    # 4. Pagamento — a parcela já foi recebida?
    if not linha:
        fontes_result["pagamento"] = {"situacao": "sem_parcela"}
        anotar("pagamento", None,
               "Sem parcela no faturamento para conferir o pagamento")
    else:
        numero = str(linha.get("parcela") or "—")
        venc_parcela = iso_date(linha.get("vencimento"))
        pago_em = iso_date(linha.get("dataPagamento"))
        recebido = money(linha.get("valorRecebido"))
        credito = iso_date(linha.get("dataCredito"))
        situacao_titulo = norm(linha.get("situacao"))
        fontes_result["pagamento"] = {
            "situacao": "pago" if pago_em else "em_aberto",
            "numero": numero,
            "vencimento": venc_parcela,
            "pagoEm": pago_em,
            "recebido": recebido,
            "credito": credito,
            "situacaoTitulo": linha.get("situacao") or "",
        }
        if pago_em:
            detalhe = f"Parcela {numero} paga em {br_date(pago_em)}"
            if recebido:
                detalhe += f" · recebido {fmt_money(recebido)}"
            if credito and credito != pago_em:
                detalhe += f" · crédito em {br_date(credito)}"
            anotar("pagamento", True, detalhe)
        elif situacao_titulo.startswith(("CANCELAD", "BAIXAD")):
            fontes_result["pagamento"]["situacao"] = "cancelado"
            anotar("pagamento", False,
                   f"Parcela {numero} está {linha.get('situacao')} no faturamento, sem pagamento")
        else:
            valor_p = money(linha.get("valor"))
            if venc_parcela and venc_parcela < date.today().isoformat():
                anotar("pagamento", None,
                       f"Parcela {numero} de {fmt_money(valor_p)} venceu em {br_date(venc_parcela)} "
                       f"e o faturamento ainda não mostra pagamento")
            else:
                anotar("pagamento", None,
                       f"Parcela {numero} de {fmt_money(valor_p)} em aberto"
                       + (f", vence em {br_date(venc_parcela)}" if venc_parcela else ""))

    # 5. Notas/Apuração — informação
    titulo = fontes.titulo(nome_ad, adesao_iso or entrada, vidas, valor)
    if titulo:
        fontes_result["notas"] = {
            "competencia": titulo.get("competencia") or "",
            "vidas": int(money(titulo.get("vidas"))),
            "valor": money(titulo.get("valor")),
        }
        anotar("notas", True,
               f"Título de {titulo.get('competencia')}: {int(money(titulo.get('vidas')))} vida(s), "
               f"{fmt_money(titulo.get('valor'))}", informativo=True)
    else:
        anotar("notas", None, "Mês ainda sem títulos apurados no portal", informativo=True)

    if situacao and situacao != "PAGO":
        anotar("vendas", None, f"Situação na planilha: {adesao.get('situacao')}", informativo=True)

    if erros:
        status = "divergente"
    elif pendentes:
        status = "pendente"
    else:
        status = "conferido"

    motivo = ""
    if status != "conferido":
        motivos = [item["detalhe"] for item in checks
                   if not item.get("informativo") and item["ok"] is not True]
        motivo = " | ".join(dict.fromkeys(motivos))[:600]

    resultado = {
        "status": status,
        "fontes": fontes_result,
        "checks": checks,
        "motivo": motivo,
        "conferidoEm": datetime.now().astimezone().isoformat(timespec="seconds"),
        "versao": 3,
    }
    return status, resultado


# ── leitura para a tela ─────────────────────────────────────────────────────
MESES = ("Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho",
         "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro")


def _meses(inicio, fim):
    """[(ano, mês, primeiro dia, último dia)] entre duas datas ISO."""
    if not inicio or not fim or inicio > fim:
        return []
    ano, mes = int(inicio[:4]), int(inicio[5:7])
    lista = []
    while f"{ano:04d}-{mes:02d}-01" <= fim:
        ultimo = f"{ano:04d}-{mes:02d}-{_dias_no_mes(ano, mes):02d}"
        lista.append((ano, mes, f"{ano:04d}-{mes:02d}-01", ultimo))
        mes += 1
        if mes > 12:
            ano, mes = ano + 1, 1
    return lista


def _meses_faltando(vendas, inicio, fim):
    """Meses sem consulta de vendas do S4E cobrindo o período."""
    limite_geral = min(fim, date.today().isoformat())
    faltando = []
    for ano, mes, primeiro, ultimo in _meses(inicio, limite_geral):
        limite = min(ultimo, limite_geral)
        if limite < primeiro:
            continue
        coberto = any(
            item["inicio"] <= primeiro and item["fim"] >= limite
            for item in vendas["periodos"]
        )
        if not coberto:
            faltando.append({"mes": f"{MESES[mes - 1]}/{ano}", "inicio": primeiro,
                             "fim": ultimo if ultimo <= date.today().isoformat() else limite})
    return faltando


def _achar_adesao(db, dia, lote, codigo, nome, vidas, usados):
    """Procura a adesão que já existe para esse lote nesse dia.

    O número do lote é reaproveitado: a mesma empresa volta a usar o lote em
    outro mês quando entram vidas novas. Por isso o dia faz parte da chave —
    nunca se move uma linha histórica para o mês da consulta.
    """
    def mesmo_empresa(row):
        return (codigo and (str(row["codigo"] or "") == codigo
                            or company_code(row["empresa"]) == codigo)) \
            or name_similar(company_name(row["empresa"]), company_name(nome))

    # 1) mesmo lote, mesmo dia
    candidatos = [row for row in db.execute(
        "SELECT * FROM adesoes WHERE lote = ? AND data_entrada = ?", (lote, dia))
        if row["id"] not in usados]
    for row in candidatos:
        if mesmo_empresa(row):
            return row
    # Um lote pode trazer várias empresas no mesmo dia: sem nome parecido, a
    # linha única pode ser de outra empresa — só serve se veio da planilha.
    if len(candidatos) == 1 and _campo(candidatos[0], "origem") != "s4e":
        return candidatos[0]

    # 2) linha da planilha no mesmo dia com lote inventado (17001–17999) ou vazio
    for row in db.execute("SELECT * FROM adesoes WHERE data_entrada = ?", (dia,)):
        if row["id"] in usados or not mesmo_empresa(row):
            continue
        atual = str(row["lote"] or "")
        inventado = bool(atual) and atual.isdigit() and 17000 <= int(atual) <= 17999
        if not atual or inventado:
            return row

    # 3) mesma empresa e mesmo dia, ainda sem lote
    for row in db.execute(
        "SELECT * FROM adesoes WHERE data_entrada = ? AND vidas = ?", (dia, vidas)
    ):
        if row["id"] not in usados and not str(row["lote"] or "") and mesmo_empresa(row):
            return row
    return None


def montar_do_s4e(db, inicio="", fim="", usuario=""):
    """Cria/atualiza as adesões a partir da Entrada de Contratos do S4E.

    Cada lote vira uma linha com o dia, a empresa (nome + código), as vidas, o
    valor e a primeira parcela do faturamento (que é a data de adesão). O que já foi
    digitado é preservado e completado — nada é apagado e nada é
    escrito em Contratos.
    """
    ensure_schema(db)
    vendas = vendas_do_s4e(db)
    if not vendas["grupos"]:
        raise ValueError("Nenhuma consulta de vendas do S4E guardada. Consulte as vendas no S4E primeiro.")

    cadastro = clientes_faturamento()
    fat_por_codigo = cadastro["por_codigo"]
    codigos_por_nome = {nome: list(codigos) for nome, codigos in cadastro["por_nome"].items()}
    nome_por_codigo = {}
    historico = db.execute("SELECT id, empresa, codigo, data_entrada, vidas, lote FROM adesoes").fetchall()
    for row in historico:
        code = str(row["codigo"] or "") or company_code(row["empresa"])
        nome = company_name(row["empresa"])
        if code:
            nome_por_codigo.setdefault(code, []).append(nome)
        if nome:
            chave = norm(nome)
            codigos_por_nome.setdefault(chave, [])
            if code and code not in codigos_por_nome[chave]:
                codigos_por_nome[chave].append(code)

    inicio = iso_date(inicio) or min(item["dia"] for item in vendas["grupos"])
    fim = iso_date(fim) or max(item["dia"] for item in vendas["grupos"])
    agora = datetime.now().astimezone().isoformat(timespec="seconds")
    resumo = {"geradas": 0, "atualizadas": 0, "semCodigo": 0, "semParcela": 0,
              "lotesCorrigidos": 0, "lotesMantidos": 0, "meses": [], "faltando": [],
              "periodos": vendas["periodos"], "faturamento": cadastro["info"],
              "inicio": inicio, "fim": fim}
    usados = set()
    meses = set()

    for grupo in vendas["grupos"]:
        dia, lote, vidas = grupo["dia"], grupo["lote"], grupo["vidas"]
        if not (inicio <= dia <= fim):
            continue
        nome_venda = grupo["empresa"]
        codigo = resolver_codigo(nome_venda, codigos_por_nome, nome_por_codigo)
        if codigo:
            nomes = nome_por_codigo.get(codigo) or []
            nome = max(set(nomes), key=nomes.count) if nomes else nome_venda
        else:
            nome = nome_venda
            resumo["semCodigo"] += 1
        empresa = f"{nome} - {codigo} - PJ" if codigo else nome

        linha, _, projetado = escolher_parcela(fat_por_codigo, codigo, dia) if codigo else (None, "", "")
        parcela = str(linha.get("parcela") or "") if linha else ""
        data_adesao = iso_date(linha.get("vencimento")) if linha else (projetado or dia)
        if not linha:
            resumo["semParcela"] += 1
        situacao = "CANCELADO" if vidas and grupo["cancelados"] == vidas else ""
        meses.add(f"{MESES[int(dia[5:7]) - 1]}/{dia[:4]}")

        existente = _achar_adesao(db, dia, lote, codigo, nome, vidas, usados)
        if existente:
            usados.add(existente["id"])
            lote_atual = str(existente["lote"] or "")
            inventado = bool(lote_atual) and lote_atual.isdigit() and 17000 <= int(lote_atual) <= 17999
            trocar_lote = lote_atual != lote and (not lote_atual or inventado)
            if trocar_lote:
                resumo["lotesCorrigidos"] += 1
            elif lote_atual != lote:
                resumo["lotesMantidos"] += 1
            nome_atual = str(existente["empresa"] or "")
            manter_nome = bool(company_code(nome_atual)) and not inventado
            dia_atual = str(existente["data_entrada"] or "") or dia
            mudou = trocar_lote or dia_atual != dia or int(existente["vidas"] or 0) != vidas \
                or abs(money(existente["valor"]) - grupo["valor"]) > 0.05
            origem_s4e = str(_campo(existente, "origem") or "") == "s4e" or trocar_lote
            campos = {
                "lote": lote if trocar_lote else lote_atual,
                "empresa": nome_atual if manter_nome else empresa,
                "codigo": codigo or str(existente["codigo"] or ""),
                "empresa_venda": nome_venda,
                "equipe": grupo.get("equipe") or str(_campo(existente, "equipe") or ""),
                "data_entrada": dia_atual,
                "vidas": vidas,
                "valor": grupo["valor"],
                "situacao": situacao or str(existente["situacao"] or ""),
                "parcela": parcela or str(_campo(existente, "parcela") or ""),
                "atualizado_em": agora,
            }
            if trocar_lote:
                campos["origem"] = "s4e"
            if origem_s4e:
                # CRM/WEB sai da equipe do lote no S4E; linha digitada à mão mantém o que ela escreveu.
                campos["tipo"] = grupo["tipo"]
            if origem_s4e or not iso_date(existente["data_adesao"]):
                campos["data_adesao"] = data_adesao
            if mudou:
                campos["conferencia_status"] = "pendente"
                campos["conferencia_resultado"] = None
                campos["conferido_em"] = None
            db.execute(
                "UPDATE adesoes SET " + ", ".join(f"{chave} = ?" for chave in campos) + " WHERE id = ?",
                (*campos.values(), existente["id"]),
            )
            resumo["atualizadas"] += 1
        else:
            novo_id = str(uuid.uuid4())
            db.execute(
                "INSERT INTO adesoes(id, lote, empresa, data_entrada, data_adesao, vidas, valor, tipo, "
                "situacao, conferencia_status, notas_conferencia, criado_em, atualizado_em, origem, "
                "codigo, parcela, empresa_venda, equipe) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', '', ?, ?, 's4e', ?, ?, ?, ?)",
                (novo_id, lote, empresa, dia, data_adesao, vidas, grupo["valor"],
                 grupo["tipo"], situacao, agora, agora, codigo, parcela, nome_venda,
                 grupo.get("equipe") or ""),
            )
            usados.add(novo_id)
            resumo["geradas"] += 1

    menor = db.execute(
        "SELECT MIN(data_entrada) FROM adesoes WHERE data_entrada <> ''"
    ).fetchone()[0]
    inicio_cobranca = min(filter(None, [inicio, menor])) if (inicio or menor) else inicio
    fim_cobranca = max(fim, date.today().isoformat())
    resumo["faltando"] = _meses_faltando(vendas, inicio_cobranca, fim_cobranca)
    resumo["meses"] = sorted(meses, key=lambda item: (int(item.split("/")[1]), MESES.index(item.split("/")[0])))
    resumo["total"] = db.execute("SELECT COUNT(*) FROM adesoes").fetchone()[0]
    db.commit()
    return resumo


def filtro(query, prefixo="data_entrada"):
    """Monta o WHERE a partir do que a tela manda (período, dia, tipo, status...)."""
    def value(name):
        return (query.get(name) or [""])[0].strip()

    where, params = [], []
    mes, ano, dia = value("mes"), value("ano"), value("dia")
    inicio, fim = iso_date(value("inicio")), iso_date(value("fim"))
    if dia:
        where.append(f"{prefixo} = ?")
        params.append(iso_date(dia))
    elif inicio or fim:
        if inicio and fim and inicio > fim:
            raise ValueError("A data inicial do período não pode ser depois da data final.")
        if inicio:
            where.append(f"{prefixo} >= ?")
            params.append(inicio)
        if fim:
            where.append(f"{prefixo} <= ?")
            params.append(fim)
    else:
        if mes:
            try:
                mes_int = int(mes)
            except (TypeError, ValueError):
                mes_int = 0
            if not 1 <= mes_int <= 12:
                raise ValueError("Mês inválido.")
            if ano:
                try:
                    ano_int = int(ano)
                except (TypeError, ValueError):
                    raise ValueError("Ano inválido.")
                where.append(f"substr({prefixo}, 1, 7) = ?")
                params.append(f"{ano_int:04d}-{mes_int:02d}")
            else:
                where.append(f"substr({prefixo}, 6, 2) = ?")
                params.append(f"{mes_int:02d}")
        elif ano:
            try:
                ano_int = int(ano)
            except (TypeError, ValueError):
                raise ValueError("Ano inválido.")
            where.append(f"substr({prefixo}, 1, 4) = ?")
            params.append(f"{ano_int:04d}")
    tipo = value("tipo").upper()
    if tipo in ("WEB", "CRM"):
        where.append("tipo = ?")
        params.append(tipo)
    status = value("status")
    if status in STATUS:
        where.append("conferencia_status = ?")
        params.append(status)
    equipes = query.get("equipe") or []
    if isinstance(equipes, str):
        equipes = [equipes]
    equipes = [str(item).strip() for item in equipes if str(item).strip()]
    if equipes:
        where.append(f"equipe IN ({', '.join('?' * len(equipes))})")
        params.extend(equipes)
    busca = value("busca") or value("search")
    if busca:
        where.append("(UPPER(empresa) LIKE UPPER(?) OR UPPER(lote) LIKE UPPER(?))")
        params.extend([f"%{busca}%", f"%{busca}%"])
    return (" WHERE " + " AND ".join(where)) if where else "", params


def pagamento_da_parcela(indice, parcela):
    """Situação de pagamento da parcela, direto do faturamento do S4E."""
    linha = (indice or {}).get(str(parcela or "").strip())
    if not linha:
        return {}
    pago_em = iso_date(linha.get("dataPagamento"))
    if pago_em:
        situacao = "pago"
    elif norm(linha.get("situacao")).startswith(("CANCELAD", "BAIXAD")):
        situacao = "cancelado"
    else:
        situacao = "em_aberto"
    recebido = money(linha.get("valorRecebido"))
    return {
        "situacao": situacao,
        "pagoEm": br_date(pago_em),
        "vencimento": br_date(linha.get("vencimento")),
        "recebido": recebido,
        "recebidoTexto": fmt_money(recebido) if recebido else "",
    }


def _payload(row, parcelas=None):
    def col(nome, padrao=""):
        try:
            valor = row[nome]
        except (IndexError, KeyError):
            return padrao
        return padrao if valor is None else valor

    try:
        resultado = json.loads(col("conferencia_resultado") or "{}")
    except (TypeError, ValueError):
        resultado = {}
    codigo = str(col("codigo")) or company_code(col("empresa"))
    parcela = str(col("parcela"))
    return {
        "id": row["id"],
        "lote": row["lote"],
        "empresa": row["empresa"],
        "empregadora": company_name(col("empresa")),
        "codigo": codigo,
        "empresaVenda": str(col("empresa_venda")),
        "equipe": str(col("equipe")),
        "parcela": parcela,
        "origem": str(col("origem") or "planilha"),
        "dataEntrada": br_date(row["data_entrada"]),
        "dataAdesao": br_date(row["data_adesao"]),
        "dia": br_date(row["data_entrada"]),
        "vidas": int(row["vidas"] or 0),
        "valor": money(row["valor"]),
        "tipo": row["tipo"] or "",
        "situacao": row["situacao"] or "",
        "status": row["conferencia_status"] or "pendente",
        "statusLabel": LABELS.get(row["conferencia_status"], "Pendente"),
        "resultado": resultado,
        "motivo": resultado.get("motivo") or "",
        "notas": row["notas_conferencia"] or "",
        "conferidoEm": row["conferido_em"] or "",
        "pagamento": pagamento_da_parcela(parcelas, parcela),
    }


def listar(db, query, paginar=True):
    where, params = filtro(query)
    rows = db.execute(f"SELECT * FROM adesoes{where} ORDER BY data_entrada, lote", params).fetchall()
    parcelas = clientes_faturamento().get("por_parcela") or {}
    registros = [_payload(row, parcelas) for row in rows]

    # Dias com adesão — é assim que a conferência é feita hoje: dia por dia.
    dias = {}
    for item in registros:
        chave = item["dia"]
        if not chave:
            continue
        info = dias.setdefault(chave, {
            "dia": chave, "total": 0, "conferido": 0, "divergente": 0, "pendente": 0,
            "web": 0, "crm": 0, "lotes": [],
        })
        info["total"] += 1
        info[item["status"]] += 1
        info["web" if item["tipo"] == "WEB" else "crm"] += 1
        info["lotes"].append(item["lote"])
    lista_dias = sorted(dias.values(), key=lambda item: item["dia"])
    # A lista de equipes é a mesma em qualquer filtro: é o combo da Entrada de Contratos.
    try:
        equipes = [row[0] for row in db.execute(
            "SELECT DISTINCT equipe FROM adesoes WHERE equipe <> '' ORDER BY equipe")]
    except Exception:  # noqa: BLE001
        equipes = []

    resumo = {chave: sum(1 for item in registros if item["status"] == chave) for chave in STATUS}
    resumo.update({
        "total": len(registros),
        "web": sum(1 for item in registros if item["tipo"] == "WEB"),
        "crm": sum(1 for item in registros if item["tipo"] == "CRM"),
        "valor": round(sum(item["valor"] for item in registros), 2),
        "vidas": sum(item["vidas"] for item in registros),
        "dias": lista_dias,
        "equipes": equipes,
    })
    fontes = situacao_fontes(db)
    try:
        dias_adesao = [iso_date(item["data_entrada"]) for item in registros]
        dias_adesao = [dia for dia in dias_adesao if dia]
        faltando = _meses_faltando(vendas_do_s4e(db), min(dias_adesao), date.today().isoformat()) \
            if dias_adesao else []
    except Exception:  # noqa: BLE001
        faltando = []
    cobertura = {"faltando": faltando, **fontes}

    resultado = {"resumo": resumo, "fontes": fontes, "cobertura": cobertura,
                 "dias": lista_dias, "registros": registros}
    if paginar:
        try:
            page = max(1, int((query.get("page") or ["1"])[0]))
        except (TypeError, ValueError):
            page = 1
        try:
            size = int((query.get("pageSize") or ["60"])[0])
        except (TypeError, ValueError):
            size = 60
        size = max(1, min(200, size))
        inicio = (page - 1) * size
        resultado.update({
            "registros": registros[inicio:inicio + size],
            "page": page, "pageSize": size,
            "pages": max(1, (len(registros) + size - 1) // size),
        })
    return resultado


def auto_estado(db):
    """Última atualização automática do S4E, como a tela mostra."""
    try:
        row = db.execute("SELECT value FROM meta WHERE key = ?", (AUTO_KEY,)).fetchone()
    except Exception:  # noqa: BLE001
        return {}
    if not row:
        return {}
    try:
        dados = json.loads(row["value"])
    except (TypeError, ValueError):
        return {}
    if not isinstance(dados, dict):
        return {}
    return {**dados, "horarios": list(AUTO_HORARIOS)}


def auto_registrar(db, estado):
    db.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (AUTO_KEY, json.dumps(estado, ensure_ascii=False)),
    )
    db.commit()


def situacao_fontes(db):
    """Diz, em uma linha, se as fontes de conferência estão disponíveis."""
    def uma(sql, *params):
        try:
            row = db.execute(sql, params).fetchone()
            return row[0] if row else None
        except Exception:
            return None

    contratos = uma("SELECT COUNT(*) FROM contract_companies") or 0
    nomes = uma("SELECT COUNT(*) FROM vidas_usuarios") or 0
    importacao = db.execute(
        "SELECT arquivo, importado_em FROM vidas_importacoes ORDER BY importado_em DESC LIMIT 1"
    ).fetchone() if _tem_tabela(db, "vidas_importacoes") else None
    apuracao = db.execute(
        "SELECT competencia FROM apuracao_rows ORDER BY rowid DESC LIMIT 1"
    ).fetchone() if _tem_tabela(db, "apuracao_rows") else None
    try:
        vendas = vendas_do_s4e(db)
    except Exception:  # noqa: BLE001
        vendas = {"periodos": [], "grupos": []}
    periodos = vendas["periodos"]
    faturamento = clientes_faturamento()["info"]
    return {
        "contratos": {"ok": contratos > 0, "empresas": contratos},
        "vidas": {
            "ok": nomes > 0, "registros": nomes,
            "arquivo": (importacao["arquivo"] if importacao else ""),
            "em": (importacao["importado_em"] if importacao else ""),
        },
        "notas": {"ok": bool(apuracao), "competencia": (apuracao["competencia"] if apuracao else "")},
        "vendas": {
            "ok": bool(periodos),
            "periodos": len(periodos),
            "lotes": len(vendas["grupos"]),
            "de": periodos[0]["inicio"] if periodos else "",
            "ate": max(item["fim"] for item in periodos) if periodos else "",
        },
        "faturamento": {
            "ok": bool(faturamento.get("linhas")),
            "linhas": int(faturamento.get("linhas") or 0),
            "de": faturamento.get("inicio") or "",
            "ate": faturamento.get("fim") or "",
        },
        "auto": auto_estado(db),
    }


def _tem_tabela(db, name):
    return bool(db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone())


# ── conferência pela tela ───────────────────────────────────────────────────
def conferir_agora(db, payload, usuario=""):
    """Confere o que a tela pediu: um dia, um lote, uma adesão ou o filtro inteiro.

    A conferência usa as cópias locais do S4E (vendas, faturamento e vidas), por
    isso responde na hora e não abre o S4E a cada clique.
    """
    query = {}
    for chave in ("inicio", "fim", "mes", "ano", "dia", "tipo", "equipe", "status", "busca"):
        valor = payload.get(chave)
        if isinstance(valor, (list, tuple)):
            valores = [str(item).strip() for item in valor if str(item).strip()]
            if valores:
                query[chave] = valores
        elif valor not in (None, ""):
            query[chave] = [str(valor)]
    alvo_id = str(payload.get("id") or "").strip()
    alvo_lote = str(payload.get("lote") or "").strip()

    where, params = filtro(query)
    sql = f"SELECT * FROM adesoes{where}"
    if alvo_id:
        sql += (" AND " if where else " WHERE ") + "id = ?"
        params.append(alvo_id)
    if alvo_lote:
        sql += (" AND " if where or alvo_id else " WHERE ") + "lote = ?"
        params.append(alvo_lote)
    adesoes = [dict(row) for row in db.execute(sql + " ORDER BY data_entrada, lote", params)]
    if not adesoes:
        raise ValueError("Nenhuma adesão encontrada com esse filtro.")

    resumo = conferir_lote(db, adesoes, usar_s4e=False)
    resumo["usuario"] = usuario
    return resumo


def job_status(db):
    total = db.execute("SELECT COUNT(*) FROM adesoes").fetchone()[0]
    pendentes = db.execute(
        "SELECT COUNT(*) FROM adesoes WHERE conferencia_status = 'pendente'"
    ).fetchone()[0]
    return {"total": total, "pendentes": pendentes, "fontes": situacao_fontes(db)}


# ── conferência em lote ─────────────────────────────────────────────────────
def conferir_lote(db, adesoes, usar_s4e=True, progress=None):
    """Confere várias adesões e grava o resultado. Devolve o resumo."""
    fontes = Fontes(db)
    aviso = ""
    if not fontes.faturamento_info.get("linhas"):
        aviso = ("A cópia do faturamento do S4E ainda não está neste servidor; a parcela "
                 "entra depois que ela for baixada em Cobrança → Importar do S4E.")
    elif fontes.faturamento_info.get("fim") and fontes.faturamento_info["fim"] < date.today().isoformat():
        aviso = f"A cópia do faturamento do S4E vai até {br_date(fontes.faturamento_info['fim'])}."

    resumo = {"total": 0, "conferido": 0, "divergente": 0, "pendente": 0, "avisoS4e": aviso}
    agora = datetime.now().astimezone().isoformat(timespec="seconds")
    for index, adesao in enumerate(adesoes, start=1):
        status, resultado = conferir(adesao, fontes)
        db.execute(
            "UPDATE adesoes SET conferencia_status = ?, conferencia_resultado = ?, conferido_em = ?, "
            "atualizado_em = ? WHERE id = ?",
            (status, json.dumps(resultado, ensure_ascii=False), agora, agora, adesao["id"]),
        )
        resumo[status] += 1
        resumo["total"] += 1
        if progress and index % 25 == 0:
            progress(index, len(adesoes))
    db.commit()
    return resumo


def _ler_xlsx(caminho):
    """Devolve [(nome_da_aba, [ {coluna: valor} ... ])] de um .xlsx, sem dependências."""
    import zipfile
    import xml.etree.ElementTree as ET

    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    rel_ns = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
    with zipfile.ZipFile(caminho) as package:
        shared = []
        if "xl/sharedStrings.xml" in package.namelist():
            root = ET.fromstring(package.read("xl/sharedStrings.xml"))
            for item in root.findall(f"{ns}si"):
                shared.append("".join(node.text or "" for node in item.iter(f"{ns}t")))

        # nomes das abas + arquivo de cada uma
        workbook = ET.fromstring(package.read("xl/workbook.xml"))
        rels = ET.fromstring(package.read("xl/_rels/workbook.xml.rels"))
        alvo = {}
        for rel in rels:
            alvo[rel.get("Id")] = rel.get("Target") or ""
        abas = []
        for sheet in workbook.iter(f"{ns}sheet"):
            target = alvo.get(sheet.get(f"{rel_ns}id"), "")
            if not target:
                continue
            if not target.startswith("xl/"):
                target = "xl/" + target.lstrip("/")
            abas.append((sheet.get("name") or "", target))

        resultado = []
        for nome, arquivo in abas:
            if arquivo not in package.namelist():
                continue
            root = ET.fromstring(package.read(arquivo))
            rows = []
            for row in root.iter(f"{ns}row"):
                cells = {}
                for cell in row.findall(f"{ns}c"):
                    ref = re.match(r"([A-Z]+)", cell.get("r") or "")
                    if not ref:
                        continue
                    column = 0
                    for char in ref.group(1):
                        column = column * 26 + (ord(char) - 64)
                    kind = cell.get("t")
                    value = cell.find(f"{ns}v")
                    inline = cell.find(f"{ns}is")
                    if kind == "s" and value is not None:
                        idx = int(value.text) if value.text and value.text.isdigit() else -1
                        content = shared[idx] if 0 <= idx < len(shared) else ""
                    elif kind == "inlineStr" and inline is not None:
                        content = "".join(node.text or "" for node in inline.iter(f"{ns}t"))
                    else:
                        content = value.text if value is not None else ""
                    cells[column - 1] = (content or "").strip()
                rows.append(cells)
            resultado.append((nome, rows))
        return resultado


# A planilha tem uma aba por mês. Algumas abas vêm sem a coluna LOTE.
ALIASES = {
    "lote": ("LOTE", "LOTE DE ADESAO", "NUMERO DO LOTE", "LOTE ADESAO"),
    "lote_pgto": ("LOTE DE PGTO", "LOTE PGTO", "LOTE DE PAGAMENTO"),
    "empresa": ("EMPRESA", "RAZAO SOCIAL", "NOME", "CLIENTE", "EMPRESA/RAZAO SOCIAL"),
    "vidas": ("QUANTIDADE VIDAS", "QTD VIDAS", "VIDAS", "QTD", "QUANTIDADE"),
    "valor": ("TOTAL VIDAS", "VALOR", "VALOR TOTAL", "TOTAL"),
    "tipo": ("CRM/WEB", "TIPO", "CANAL"),
    "data_entrada": ("DATA", "DATA ENTRADA", "DATA DE ENTRADA", "ENTRADA"),
    "data_adesao": ("ADESAO", "DATA DE ADESAO", "DATA ADESAO"),
    "situacao": ("SITUACAO", "STATUS"),
    "observacao": ("OBS", "OBSERVACAO", "OBSERVACOES"),
}

MES_ABA = {
    "JANEIRO": 1, "FEVEREIRO": 2, "MARCO": 3, "ABRIL": 4, "MAIO": 5, "JUNHO": 6,
    "JULHO": 7, "AGOSTO": 8, "SETEMBRO": 9, "OUTUBRO": 10, "NOVEMBRO": 11, "DEZEMBRO": 12,
}


def _mes_da_aba(nome, linha_iso=""):
    """'Outubro-2026' → (10, 2026). Sem nome reconhecível, usa a data da linha."""
    chave = norm(nome)
    ano = None
    achado = re.search(r"(20\d{2})", chave)
    if achado:
        ano = int(achado.group(1))
    for nome_mes, numero in MES_ABA.items():
        if nome_mes in chave:
            if not ano and linha_iso:
                ano = int(linha_iso[:4])
            return numero, ano
    return None, ano


def _mapear(cabecalho):
    mapa = {}
    for coluna, titulo in cabecalho.items():
        chave = norm(titulo)
        for campo, nomes in ALIASES.items():
            if chave in nomes and campo not in mapa:
                mapa[campo] = coluna
                break
    return mapa


def importar_planilha(db, caminho, usuario="", tipo_padrao=""):
    """Lê a planilha real de adesões (uma aba por mês) e grava em `adesoes`.

    Regras:
    - O lote é o que se preenche; quando a aba não tem coluna LOTE, ele
      fica vazio e a conferência avisa (nunca inventa número).
    - A data de entrada vem em número de série do Excel (ex.: 46024).
    - O tipo vem da coluna CRM/WEB; quando falta, entra a regra do usuário:
      o que não é WEB é CRM.
    Devolve {importadas, atualizadas, ignoradas, lotes_vazios, meses}.
    """
    total = {"importadas": 0, "atualizadas": 0, "ignoradas": 0,
             "lotesVazios": 0, "meses": [], "abas": []}
    agora = datetime.now().astimezone().isoformat(timespec="seconds")

    for nome_aba, rows in _ler_xlsx(caminho):
        # acha a linha de cabeçalho (primeira que tem EMPRESA)
        header_index, mapa = None, {}
        for index, cells in enumerate(rows[:15]):
            if not cells:
                continue
            mapa = _mapear(cells)
            if "empresa" in mapa:
                header_index = index
                break
        if header_index is None:
            continue

        linhas_aba = 0
        for cells in rows[header_index + 1:]:
            if not cells:
                continue
            empresa = str(cells.get(mapa.get("empresa", -1), "") or "").strip()
            if not empresa or norm(empresa) in ("EMPRESA", "TOTAL", "TOTAIS"):
                continue

            def pegar(campo):
                coluna = mapa.get(campo)
                return str(cells.get(coluna, "") or "").strip() if coluna is not None else ""

            entrada = iso_date(pegar("data_entrada"))
            adesao_data = iso_date(pegar("data_adesao"))
            lote = re.sub(r"\D", "", pegar("lote")) or ""
            vidas = int(money(pegar("vidas")))
            valor = money(pegar("valor"))
            tipo = norm(pegar("tipo"))
            situacao = pegar("situacao").upper()
            # Regra do setor: o que veio de lote e está pago é WEB; o resto é CRM.
            if tipo == "WEB" or (lote and situacao == "PAGO"):
                tipo = "WEB"
            else:
                tipo = "CRM"
            observacao = pegar("observacao")

            if not entrada and not adesao_data:
                total["ignoradas"] += 1
                continue
            if not entrada:
                entrada = adesao_data

            mes, ano = _mes_da_aba(nome_aba, entrada)
            if not mes and entrada:
                mes, ano = int(entrada[5:7]), int(entrada[:4])
            if not ano:
                ano = int(entrada[:4]) if entrada else date.today().year
            if not mes:
                total["ignoradas"] += 1
                continue
            # O dia da planilha é o dia do mês; a aba manda no mês/ano.
            dia = int(entrada[8:10]) if entrada else 1
            data_entrada = f"{ano:04d}-{mes:02d}-{dia:02d}"

            if not lote:
                total["lotesVazios"] += 1

            # uma adesão = um lote; sem lote, a chave é empresa+dia+vidas
            chave = lote or f"{norm(empresa)}|{data_entrada}|{vidas}"
            existente = None
            if lote:
                existente = db.execute(
                    "SELECT id FROM adesoes WHERE lote = ? AND UPPER(empresa) = UPPER(?)",
                    (lote, empresa),
                ).fetchone()
            if not existente:
                existente = db.execute(
                    "SELECT id FROM adesoes WHERE UPPER(empresa) = UPPER(?) AND data_entrada = ? AND vidas = ?",
                    (empresa, data_entrada, vidas),
                ).fetchone()

            if existente:
                # A planilha manda no resto, mas o tipo WEB/CRM já classificado não é
                # sobrescrito por um "CRM" genérico: no portal vale a regra
                # "tem lote e está pago = WEB; o que não for WEB é CRM".
                atual = db.execute("SELECT tipo, lote FROM adesoes WHERE id = ?", (existente["id"],)).fetchone()
                tipo_final = tipo
                if atual and atual["tipo"] == "WEB" and tipo != "WEB":
                    tipo_final = "WEB"
                db.execute(
                    "UPDATE adesoes SET empresa = ?, data_entrada = ?, data_adesao = ?, vidas = ?, "
                    "valor = ?, tipo = ?, situacao = ?, notas_conferencia = ?, atualizado_em = ? WHERE id = ?",
                    (empresa, data_entrada, adesao_data or data_entrada, vidas, valor, tipo_final,
                     situacao, observacao, agora, existente["id"]),
                )
                total["atualizadas"] += 1
            else:
                db.execute(
                    "INSERT INTO adesoes(id, lote, empresa, data_entrada, data_adesao, vidas, valor, tipo, "
                    "situacao, conferencia_status, notas_conferencia, criado_em, atualizado_em) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?, ?, ?)",
                    (str(uuid.uuid4()), lote, empresa, data_entrada, adesao_data or data_entrada,
                     vidas, valor, tipo, situacao, observacao, agora, agora),
                )
                total["importadas"] += 1
            linhas_aba += 1

        if linhas_aba:
            total["abas"].append({"aba": nome_aba, "linhas": linhas_aba})
            mes, ano = _mes_da_aba(nome_aba)
            if mes and ano:
                total["meses"].append(f"{MESES[mes - 1]}/{ano}")

    db.commit()
    return total



# ── planilha ────────────────────────────────────────────────────────────────
# Mesmo desenho da planilha usada hoje, com a conferência ao lado de cada linha.
CABECALHO = [
    "LOTE", "EMPRESA", "QUANTIDADE VIDAS", "TOTAL VIDAS", "CRM/WEB", "EQUIPE", "DATA", "ADESÃO",
    "PARCELA", "SITUAÇÃO", "STATUS", "O QUE CONFERIU", "O QUE PRECISA DE OLHO", "CONFERIDO EM",
]


def _campo(adesao, nome, padrao=""):
    """Aceita a linha do banco (snake_case) e o payload da tela (camelCase)."""
    try:
        valor = adesao[nome]
    except (KeyError, IndexError, TypeError):
        return padrao
    return padrao if valor is None else valor


def _resultado(adesao):
    bruto = _campo(adesao, "conferencia_resultado")
    if isinstance(bruto, dict):
        return bruto
    if bruto:
        try:
            return json.loads(bruto)
        except (TypeError, ValueError):
            return {}
    payload = _campo(adesao, "resultado")
    return payload if isinstance(payload, dict) else {}


def _total_vidas(adesao, resultado):
    """A coluna TOTAL VIDAS da planilha é o valor do lote (7 vidas × 60 = 420)."""
    valor = money(_campo(adesao, "valor"))
    if valor:
        return round(valor, 2)
    vendas = (resultado.get("fontes") or {}).get("vendas") or {}
    if vendas.get("valor"):
        return round(money(vendas["valor"]), 2)
    return ""


def _nome_aba(adesao):
    entrada = iso_date(_campo(adesao, "data_entrada") or _campo(adesao, "dataEntrada")
                       or _campo(adesao, "data_adesao") or _campo(adesao, "dataAdesao"))
    if not entrada:
        return "Sem data"
    return f"{MESES[int(entrada[5:7]) - 1]}-{entrada[:4]}"


def _linha_planilha(adesao):
    resultado = _resultado(adesao)
    checks = resultado.get("checks") or []
    status = _campo(adesao, "conferencia_status") or _campo(adesao, "status", "pendente")
    entrada = _campo(adesao, "data_entrada") or _campo(adesao, "dataEntrada")
    adesao_data = _campo(adesao, "data_adesao") or _campo(adesao, "dataAdesao")
    empresa = str(_campo(adesao, "empresa"))
    conferido = str(_campo(adesao, "conferido_em") or _campo(adesao, "conferidoEm") or "")
    ok = "; ".join(item["detalhe"] for item in checks
                   if item.get("ok") is True and not item.get("informativo"))
    olho = "; ".join(item["detalhe"] for item in checks
                     if item.get("ok") is not True and not item.get("informativo"))
    return [
        str(_campo(adesao, "lote")),
        empresa,
        int(_campo(adesao, "vidas", 0) or 0),
        _total_vidas(adesao, resultado),
        str(_campo(adesao, "tipo")),
        str(_campo(adesao, "equipe")),
        br_date(entrada),
        br_date(adesao_data),
        str(_campo(adesao, "parcela")),
        str(_campo(adesao, "situacao")),
        LABELS.get(status, status),
        ok,
        olho,
        br_date(conferido[:10]),
    ]


def linhas_planilha(adesoes, nomes_por_id=None):
    nomes_por_id = nomes_por_id or {}
    return [CABECALHO] + [_linha_planilha(adesao) for adesao in adesoes]


def por_mes(adesoes):
    """Separa as adesões nas abas do mês, como na planilha original."""
    abas = {}
    for adesao in adesoes:
        abas.setdefault(_nome_aba(adesao), []).append(adesao)
    return abas


def resumo_planilha(adesoes, fontes=None):
    linhas = [["Conferência de Adesões"], ["Adesões", len(adesoes)]]
    for chave in STATUS:
        linhas.append([LABELS[chave], sum(
            1 for item in adesoes
            if (_campo(item, "conferencia_status") or _campo(item, "status")) == chave
        )])
    web = sum(1 for item in adesoes if str(_campo(item, "tipo")).upper() == "WEB")
    linhas.append(["WEB", web])
    linhas.append(["CRM", len(adesoes) - web])
    linhas.append(["Vidas", sum(int(_campo(item, "vidas", 0) or 0) for item in adesoes)])
    if fontes:
        vendas = fontes.get("vendas") or {}
        if vendas.get("ok"):
            linhas.append(["Entrada de Contratos do S4E",
                           f"{vendas.get('lotes', 0)} lote(s) de {br_date(vendas.get('de'))} a {br_date(vendas.get('ate'))}"])
        faturamento = fontes.get("faturamento") or {}
        if faturamento.get("ok"):
            linhas.append(["Faturamento do S4E",
                           f"{faturamento.get('linhas', 0)} título(s) até {br_date(faturamento.get('ate'))}"])
    return linhas


def planilha(adesoes, fontes=None):
    """Uma aba por mês + Resumo, no layout da planilha em uso."""
    abas = por_mes(adesoes)
    ordem = sorted(
        abas,
        key=lambda item: (
            item.split("-")[-1] if "-" in item else "",
            MESES.index(item.split("-")[0]) + 1 if item.split("-")[0] in MESES else 0,
        ),
    )
    sheets = [(nome, [CABECALHO] + [_linha_planilha(item) for item in abas[nome]])
              for nome in ordem]
    sheets.append(("Resumo", resumo_planilha(adesoes, fontes)))
    return xlsx_simple.build(sheets)
