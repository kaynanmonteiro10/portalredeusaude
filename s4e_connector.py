"""Conector de leitura do S4E.

Mantém uma sessão em memória (cookie do ASP.NET), baixa o relatório de
faturamento e devolve as linhas no formato aceito pela Cobrança do portal.
Nunca grava a senha e nunca faz POST de alteração no S4E.
"""

import http.cookiejar
import html as html_lib
import re
import ssl
import threading
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime
from html.parser import HTMLParser

S4E_BASE = "https://redesaude.s4e.com.br"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
REPORT_PATH = "/SYS/Faturamento/RelatorioFaturamentoPorTipoModal.aspx"
LOGIN_PATH = "/SYS/Login.aspx?TipoUsuario=&cellpadding=5&iframe=1"
CHECK_PATH = "/SYS/Faturamento/RelatorioFaturamento.aspx"
MAX_ROWS = 20000
MAX_CONTACT_CLIENTS = 3000
CONTACT_WORKERS = 4
CNPJ_RE = re.compile(r"^\d{2}\.\d{3}\.\d{3}/\d{4}-\d{2}$")
EMAIL_RE = re.compile(r"[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}", re.I)
PHONE_RE = re.compile(r"\(?(\d{2})\)?[\s.\-]?(9?\d{4})[\s.\-]?(\d{4})(?!\d)")
CONTACT_LABEL_RE = re.compile(r"^(e-?mail|whatsapp|whats|telefone|fone|celular)\s*:?\s*", re.I)


class ConnectorError(Exception):
    pass


# ── HTTP com cookie de sessão ────────────────────────────────────────────────
def _build_opener(jar):
    context = ssl.create_default_context()
    return urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(jar),
        urllib.request.HTTPSHandler(context=context),
    )


class S4EHttp:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.opener = _build_opener(self.jar)

    def clone(self):
        other = S4EHttp.__new__(S4EHttp)
        other.jar = self.jar
        other.opener = _build_opener(self.jar)
        return other

    def get(self, path, timeout=150):
        request = urllib.request.Request(
            S4E_BASE + path,
            headers={"User-Agent": USER_AGENT, "Accept": "*/*", "Accept-Language": "pt-BR,pt;q=0.9"},
            method="GET",
        )
        with self.opener.open(request, timeout=timeout) as response:
            return response.read(), response.headers

    def post(self, path, fields, timeout=120):
        data = urllib.parse.urlencode(fields).encode("utf-8")
        request = urllib.request.Request(
            S4E_BASE + path,
            data=data,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,*/*",
                "Content-Type": "application/x-www-form-urlencoded",
                "Referer": S4E_BASE + path,
            },
            method="POST",
        )
        with self.opener.open(request, timeout=timeout) as response:
            return response.read(), response.headers

    def post_ajax(self, path, fields, timeout=300):
        data = urllib.parse.urlencode(fields).encode("utf-8")
        request = urllib.request.Request(
            S4E_BASE + path,
            data=data,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "*/*",
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "Referer": S4E_BASE + path,
                "X-MicrosoftAjax": "Delta=true",
                "X-Requested-With": "XMLHttpRequest",
                "Cache-Control": "no-cache",
            },
            method="POST",
        )
        with self.opener.open(request, timeout=timeout) as response:
            return response.read(), response.headers


def _decode(raw, headers=None):
    charset = ""
    if headers is not None:
        match = re.search(r"charset=([\w-]+)", headers.get("Content-Type") or "", re.I)
        charset = match.group(1) if match else ""
    if not charset or re.search(r"8859|1252|latin", charset, re.I):
        return raw.decode("windows-1252", "replace")
    return raw.decode("utf-8", "replace")


def _parse_inputs(page):
    fields = {}
    for match in re.finditer(r"<input\b[^>]*>", page, re.I):
        tag = match.group(0)
        name = re.search(r'\bname\s*=\s*"([^"]*)"', tag, re.I) or re.search(r"\bname\s*=\s*'([^']*)'", tag, re.I)
        if not name:
            continue
        value = re.search(r'\bvalue\s*=\s*"([^"]*)"', tag, re.I) or re.search(r"\bvalue\s*=\s*'([^']*)'", tag, re.I)
        fields[name.group(1)] = html_lib.unescape(value.group(1)) if value else ""
    return fields


def _session_name(page):
    match = re.search(r"COLABORADOR\s*:\s*([^\[\]<]+)", page, re.I)
    return re.sub(r"\s+", " ", match.group(1)).strip() if match else ""


def _looks_logged_out(page):
    return bool(re.search(r'name\s*=\s*"TXT_Senha"', page, re.I))


# ── Sessão única em memória ──────────────────────────────────────────────────
_session = {"http": None, "name": "", "since": None}
_session_lock = threading.Lock()


def connect(cpf, password):
    digits = re.sub(r"\D", "", str(cpf or ""))
    if len(digits) != 11:
        raise ConnectorError("Informe o CPF com 11 dígitos.")
    if not password:
        raise ConnectorError("Informe a senha do S4E.")

    http_session = S4EHttp()
    try:
        page_raw, headers = http_session.get(LOGIN_PATH, timeout=60)
    except Exception as exc:  # noqa: BLE001 - erro de rede vira mensagem para a tela
        raise ConnectorError(f"Não foi possível abrir o S4E: {exc}") from exc
    fields = _parse_inputs(_decode(page_raw, headers))
    if "TXT_CPF" not in fields:
        raise ConnectorError("A tela de login do S4E não foi reconhecida. Tente novamente em instantes.")
    fields["CMB_Tipo"] = "5"
    fields["TXT_CPF"] = digits
    fields["TXT_Senha"] = password
    fields["BTN_Avancar"] = fields.get("BTN_Avancar") or "Avançar"

    try:
        login_raw, login_headers = http_session.post("/SYS/Login.aspx", fields, timeout=90)
    except Exception as exc:  # noqa: BLE001
        raise ConnectorError(f"O S4E não respondeu ao login: {exc}") from exc
    login_page = _decode(login_raw, login_headers)

    try:
        check_raw, check_headers = http_session.get(CHECK_PATH, timeout=90)
    except Exception as exc:  # noqa: BLE001
        raise ConnectorError(f"Login feito, mas o S4E não abriu o Faturamento: {exc}") from exc
    check_page = _decode(check_raw, check_headers)
    if _looks_logged_out(check_page) or _looks_logged_out(login_page):
        raise ConnectorError("CPF ou senha não conferem no S4E. Confira os dados e tente de novo.")
    # A página do Faturamento abre sem login (só o cabeçalho); o nome do colaborador
    # é o sinal de que a sessão foi aceita de verdade.
    name = _session_name(check_page) or _session_name(login_page)
    if not name:
        raise ConnectorError(
            "O S4E não confirmou o login. Tente novamente; se continuar, use a extensão do Chrome."
        )

    with _session_lock:
        _session["http"] = http_session
        _session["name"] = name
        _session["since"] = datetime.now().isoformat(timespec="seconds")
    return status()


def disconnect():
    with _session_lock:
        _session["http"] = None
        _session["name"] = ""
        _session["since"] = None
    return status()


def status():
    with _session_lock:
        connected = _session["http"] is not None
        name = _session["name"]
        since = _session["since"]
    return {"connected": connected, "user": name, "since": since, "job": job_status()}


def _require_session():
    with _session_lock:
        http_session = _session["http"]
    if http_session is None:
        raise ConnectorError("Conecte ao S4E antes de importar.")
    return http_session


_credentials_provider = None


def set_credentials_provider(provider):
    """Callback que devolve (cpf, senha) da conta salva no portal, se houver."""
    global _credentials_provider
    _credentials_provider = provider


def _stored_credentials():
    provider = _credentials_provider
    if not provider:
        return None
    try:
        return provider()
    except Exception:  # noqa: BLE001 - conta ilegível vira "sem conta"
        return None


def ensure_session():
    """Usa a sessão aberta ou entra com a conta salva, sem pedir nada ao usuário."""
    with _session_lock:
        http_session = _session["http"]
    if http_session is not None:
        return http_session
    credentials = _stored_credentials()
    if not credentials:
        raise ConnectorError("Nenhuma conta do S4E configurada no portal.")
    connect(credentials[0], credentials[1])
    return _require_session()


# ── Leitura do relatório ────────────────────────────────────────────────────
class _TableParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables = []
        self._row = None
        self._cell = None

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.tables.append([])
        elif tag == "tr" and self.tables:
            self._row = []
            self.tables[-1].append(self._row)
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []
            self._row.append(self._cell)
        elif tag == "br" and self._cell is not None:
            self._cell.append(" ")

    def handle_endtag(self, tag):
        if tag in ("td", "th"):
            self._cell = None
        elif tag == "tr":
            self._row = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def _parse_tables(page):
    parser = _TableParser()
    try:
        parser.feed(page)
        parser.close()
    except Exception:  # noqa: BLE001 - HTML do S4E não é válido; usa o que já foi lido
        pass
    tables = []
    for table in parser.tables:
        rows = []
        for row in table:
            cells = [re.sub(r"\s+", " ", "".join(cell)).strip() for cell in row]
            rows.append(cells)
        tables.append(rows)
    return tables


def _strip_accents(value):
    return "".join(
        char for char in unicodedata.normalize("NFD", str(value or ""))
        if unicodedata.category(char) != "Mn"
    )


def _money(value):
    raw = re.sub(r"R\$|\s", "", str(value or ""), flags=re.I)
    if not raw:
        return 0.0
    if "," in raw:
        raw = raw.replace(".", "").replace(",", ".")
    try:
        return round(float(raw), 2)
    except ValueError:
        return 0.0


def _date_br(value):
    raw = str(value or "").strip()
    match = re.search(r"(\d{2})/(\d{2})/(\d{4})", raw)
    if match:
        return f"{match.group(1)}/{match.group(2)}/{match.group(3)}"
    iso = re.search(r"(\d{4})-(\d{2})-(\d{2})", raw)
    if iso:
        return f"{iso.group(3)}/{iso.group(2)}/{iso.group(1)}"
    return ""


def parse_report(page, today=None):
    """Lê o detalhe por empresa (colunas do relatório "Tipo: Empresa")."""
    today = today or date.today().isoformat()
    rows = []
    seen = set()
    for table in _parse_tables(page):
        for cells in table:
            # Nome | CNPJ | Grupo | Empresa | Depto | Situação | Gerado | Crédito |
            # Vencimento | Valor Parcela | ... | Tipo Parcela | Recebimento |
            # Pagamento | Competência | Parcela | ... | Qdt. Vidas
            if len(cells) < 36:
                continue
            cliente = cells[0]
            documento = cells[1]
            if not CNPJ_RE.match(documento or ""):
                continue
            code = re.match(r"^\s*(\d+)\s*-", cliente)
            if not code:
                continue
            if _money(cells[19]) > 0:
                continue  # já tem pagamento lançado
            vencimento = _date_br(cells[8])
            if not vencimento:
                continue
            day, month, year = vencimento.split("/")
            if f"{year}-{month}-{day}" > today:
                continue
            valor = _money(cells[9])
            if valor <= 0:
                continue
            item = {
                "cliente": cliente,
                "documento": documento,
                "grupo": cells[2],
                "empresa": cells[3],
                "departamento": cells[4],
                "cdAssociado": code.group(1),
                "situacao": _strip_accents(cells[5]).upper(),
                "vencimento": vencimento,
                "valor": valor,
                "tipoParcela": _strip_accents(cells[21]).upper(),
                "tipoRecebimento": _strip_accents(cells[22]).upper(),
                "tipoPagamento": cells[23],
                "competencia": cells[24],
                "parcela": cells[25],
            }
            key = "|".join((
                item["documento"], item["competencia"], item["vencimento"],
                item["parcela"], item["tipoParcela"], f"{valor:.2f}",
            ))
            if key in seen:
                continue
            seen.add(key)
            rows.append(item)
    return rows


_JS_QUOTE = chr(92) + "u0027"


def _js_text(value):
    for code, char in (("u0027", "'"), ("u0026", "&"), ("u0023", "#")):
        value = value.replace(chr(92) + code, char)
    return value


def _search_modal(http_session, start, end):
    """Repete a busca da tela do Faturamento e devolve o caminho do resumo."""
    raw, headers = http_session.get(CHECK_PATH, timeout=180)
    page = _decode(raw, headers)
    if _looks_logged_out(page) or not re.search(r"(?is)<select\b", page):
        raise ConnectorError("A sessão do S4E expirou. Conecte novamente e repita a importação.")
    fields = _parse_inputs(page)
    for match in re.finditer(r"<select\b[^>]*name=\"([^\"]+)\"[^>]*>(.*?)</select>", page, re.I | re.S):
        options = re.findall(r"<option\b[^>]*selected[^>]*value=\"([^\"]*)\"", match.group(2))
        options = options or re.findall(r"<option\b[^>]*value=\"([^\"]*)\"", match.group(2))
        fields[match.group(1)] = options[0] if options else ""
    fields.pop("BTN_GerarExcel", None)
    fields.update({
        "TXT_DataInicial": start,
        "TXT_DataFinal": end,
        "TXT_BuscaperiodoInicial": start,
        "TXT_BuscaperiodoFinal": end,
        "__ASYNCPOST": "true",
        "ScriptManager1": "UpdatePanel1|BTN_Buscar",
        "BTN_Buscar": "Buscar",
    })
    raw, headers = http_session.post_ajax(CHECK_PATH, fields, timeout=300)
    delta = _decode(raw, headers)
    start_at = delta.find("FF_ModalIframe(" + _JS_QUOTE)
    if start_at >= 0:
        rest = delta[start_at + len("FF_ModalIframe(") + len(_JS_QUOTE):]
        end_at = rest.find(_JS_QUOTE)
        if end_at > 0:
            return _js_text(rest[:end_at])
    match = re.search(r"FF_ModalIframe\('([^']+)'", delta)
    if match:
        return match.group(1)
    raise ConnectorError(
        "O S4E não abriu o resumo do faturamento. Confira a data inicial e final e tente novamente."
    )


def _summary_groups(http_session, modal_path, start, end):
    """Grupos (parcela, forma de pagamento) com títulos em atraso."""
    raw, headers = http_session.get(modal_path, timeout=300)
    page = _decode(raw, headers)
    if _looks_logged_out(page):
        raise ConnectorError("A sessão do S4E expirou. Conecte novamente e repita a importação.")
    groups = []
    seen = set()
    for row in re.finditer(r"<tr\b[\s\S]*?</tr>", page, re.I):
        html = row.group(0)
        if not re.search(r">\s*EMPRESA\s*<", html, re.I):
            continue
        for match in re.finditer(
            r"ff_FaturamentoPorTipo\((\d+),\s*(\d+),\s*(\d+),\s*(\d+)\)[^>]*>(\d+)<", html
        ):
            tp, parcela, pagamento, tipo, qtd = match.groups()
            if tp != "2" or tipo != "5" or int(qtd) <= 0:
                continue
            key = (parcela, pagamento)
            if key in seen:
                continue
            seen.add(key)
            groups.append(key)
    return groups


def _detail_path(parcela, pagamento, start, end):
    params = {
        "operacao": "4",
        "tp_associado_empresa": "2",
        "cd_tipo_parcela": parcela,
        "tipoFatura": "5",
        "TXT_BuscaperiodoInicial": start,
        "TXT_BuscaperiodoFinal": end,
        "centro_custo": "-1",
        "tipo_pagamento": pagamento,
        "TP_EMPRESA": "-1",
        "CD_GRUPOAnalise": "-1",
        "cd_grupo": "-1",
        "depid": "-1",
        "cd_equipe": "0",
        "ds_equipe": "",
        "cd_vendedor": "-1",
    }
    return REPORT_PATH + "?" + urllib.parse.urlencode(params)


def fetch_overdue_rows(http_session, start, end, progress=None):
    modal = _search_modal(http_session, start, end)
    groups = _summary_groups(http_session, modal, start, end)
    if not groups:
        return []
    rows = []
    seen = set()
    total = len(groups)
    for index, (parcela, pagamento) in enumerate(groups):
        if progress:
            progress(index, total, f"Lendo os títulos em atraso ({index + 1} de {total})...")
        raw, headers = http_session.get(_detail_path(parcela, pagamento, start, end), timeout=600)
        page = _decode(raw, headers)
        if _looks_logged_out(page):
            raise ConnectorError("A sessão do S4E expirou. Conecte novamente e repita a importação.")
        for row in parse_report(page):
            key = "|".join((
                row["documento"], row["competencia"], row["vencimento"],
                row["parcela"], row["tipoParcela"], f"{row['valor']:.2f}",
            ))
            if key in seen:
                continue
            seen.add(key)
            rows.append(row)
        if progress:
            progress(index + 1, total, f"Lendo os títulos em atraso ({index + 1} de {total})...")
    return rows


def _faturamento_detail_path(start, end):
    params = {
        "operacao": "4",
        "tp_associado_empresa": "2",
        "cd_tipo_parcela": "-1",
        "tipoFatura": "1",
        "TXT_BuscaperiodoInicial": start,
        "TXT_BuscaperiodoFinal": end,
        "centro_custo": "-1",
        "tipo_pagamento": "-1",
        "TP_EMPRESA": "-1",
        "CD_GRUPOAnalise": "-1",
        "cd_grupo": "-1",
        "depid": "-1",
        "cd_equipe": "0",
        "ds_equipe": "",
        "cd_vendedor": "-1",
    }
    return REPORT_PATH + "?" + urllib.parse.urlencode(params)


def parse_faturamento_rows(page, include_zero=False):
    rows = []
    seen = set()
    tables = _parse_tables(page)
    if not any(any('Nome Fantasia' in cell for cell in row) and any('CNPJ' in cell for cell in row) for table in tables for row in table):
        raise ConnectorError("O S4E não retornou o relatório esperado. A apuração anterior foi preservada.")
    for table in tables:
        for cells in table:
            if len(cells) < 36:
                continue
            cliente = cells[0]
            documento = cells[1]
            if not CNPJ_RE.match(documento or ""):
                continue
            code = re.match(r"^\s*(\d+)\s*-", cliente)
            if not code:
                continue
            valor = _money(cells[9])
            if valor <= 0 and not include_zero:
                continue
            vencimento = _date_br(cells[8])
            item = {
                "cliente": cliente,
                "documento": documento,
                "grupo": cells[2],
                "empresa": cells[3],
                "departamento": cells[4],
                "situacao": cells[5],
                "gerado": _date_br(cells[6]),
                "cdAssociado": code.group(1),
                "vencimento": vencimento,
                "valor": valor,
                "acrescimo": _money(cells[10]),
                "desconto": _money(cells[11]),
                "imposto": _money(cells[12]),
                "titulo": _money(cells[13]),
                "taxa": _money(cells[14]),
                "dataCredito": _date_br(cells[7]),
                "dataPagamento": _date_br(cells[15]),
                "multa": _money(cells[16]),
                "acrescimoAvulso": _money(cells[17]),
                "descontoPagamento": _money(cells[18]),
                "valorRecebido": _money(cells[19]),
                "tarifa": _money(cells[20]),
                "tipoParcela": _strip_accents(cells[21]).upper(),
                "tipoRecebimento": cells[22],
                "tipoPagamento": cells[23],
                "competencia": cells[24],
                "parcela": cells[25],
                "nfLote": cells[27],
                "nf": cells[28],
                "emissao": _date_br(cells[29]),
                "vlPlano": _money(cells[30]),
                "vlOrto": _money(cells[31]),
                "vlProRata": _money(cells[32]),
                "vendedor": cells[33],
                "vidas": cells[35],
            }
            key = "|".join((
                item["cdAssociado"], item["documento"], item["grupo"], item["parcela"],
                item["competencia"], item["vencimento"], item["tipoParcela"], f"{valor:.2f}",
            ))
            if key in seen:
                continue
            seen.add(key)
            rows.append(item)
    return rows


class _NFSeRowsParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.depth = 0
        self.stack = []
        self.rows = []

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.depth += 1
        elif tag == "tr":
            self.stack.append({"depth": self.depth, "cells": [], "cell": None})
        elif tag in ("td", "th") and self.stack and self.stack[-1]["depth"] == self.depth:
            cell = {"text": "", "links": []}
            self.stack[-1]["cells"].append(cell)
            self.stack[-1]["cell"] = cell
        elif tag == "a":
            href = dict(attrs).get("href", "")
            for row in self.stack:
                if row["cell"] is not None:
                    row["cell"]["links"].append(href)

    def handle_data(self, data):
        for row in self.stack:
            if row["cell"] is not None:
                row["cell"]["text"] += data

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.stack and self.stack[-1]["depth"] == self.depth:
            self.stack[-1]["cell"] = None
        elif tag == "tr" and self.stack:
            self.rows.append(self.stack.pop()["cells"])
        elif tag == "table":
            self.depth -= 1


def _nf_number(value):
    text = str(value or "").strip()
    return str(int(text)) if re.fullmatch(r"[0-9]+", text) and int(text) > 0 else ""


def _public_nf_url(value):
    url = urllib.parse.urlsplit(value)
    query = urllib.parse.parse_qs(url.query)
    if (
        url.scheme == "https" and url.netloc == "www.nfse.gov.br"
        and url.path == "/ConsultaPublica/" and not url.fragment
        and query.get("tpc") == ["1"] and len(query.get("chave", [])) == 1
        and re.fullmatch(r"[0-9]+", query["chave"][0])
    ):
        return value
    return ""


def parse_nfse_links(page):
    parser = _NFSeRowsParser()
    parser.feed(page)
    links = {}
    client_index = None
    nf_index = None
    parcela_index = None
    width = None
    for cells in parser.rows:
        texts = [cell["text"].strip() for cell in cells]
        if "Cliente" in texts and "NF" in texts and "Mensalidade" in texts:
            client_index = texts.index("Cliente")
            nf_index = texts.index("NF")
            parcela_index = texts.index("Mensalidade")
            width = len(cells)
            continue
        if client_index is None or len(cells) != width:
            continue
        code = re.match(r"^\s*([0-9]+)\s*-", texts[client_index])
        nf = _nf_number(texts[nf_index])
        if not code or not nf:
            continue
        for cell in (cells[nf_index], cells[parcela_index]):
            for href in cell["links"]:
                url = _public_nf_url(href)
                if url:
                    links.setdefault((code.group(1), nf), set()).add(url)
    return {key: next(iter(urls)) for key, urls in links.items() if len(urls) == 1}


NF_LOT_WORKERS = 4
NF_LOT_TIMEOUT = 15
NF_LOT_BUDGET = 90


def _fetch_nf_lot(http_session, lot):
    raw, headers = http_session.get(f"/SYS/NFSe/Lote.aspx?ID={lot}&Modal=1", timeout=NF_LOT_TIMEOUT)
    page = _decode(raw, headers)
    if _looks_logged_out(page):
        raise ConnectorError("A sessão do S4E expirou durante a conferência das notas.")
    return parse_nfse_links(page)


NFSE_LOTES_PATH = "/SYS/NFSe/Lotes.aspx"


def fetch_nfse_lot_ids(http_session, start, end, timeout=120):
    raw, headers = http_session.get(NFSE_LOTES_PATH, timeout=timeout)
    page = _decode(raw, headers)
    if _looks_logged_out(page):
        raise ConnectorError("A sessão do S4E expirou durante a consulta dos lotes de notas fiscais.")
    fields = _parse_inputs(page)
    if "TXT_DataInicial" not in fields:
        raise ConnectorError("O S4E não exibiu a consulta dos lotes de notas fiscais.")
    fields.update({
        "TXT_CodigoLote": "",
        "TXT_DataInicial": start.strftime("%d/%m/%Y"),
        "TXT_DataFinal": end.strftime("%d/%m/%Y"),
        "TXT_RPS": "",
        "TXT_GrupoEmpresas": "",
        "TXT_GrupoAssociados": "",
        "CMB_TipoBusca": "1",
        "CMB_CentroCusto": "-1",
        "CMB_TipoCliente": "-1",
        "CMB_TipoPagamento": "-1",
        "TXT_Acao": "",
        "BTN_Avancar": "Buscar",
    })
    for button in ("BTN_Acao", "BTN_GerarExcel", "BTN_GerarXML", "BTN_ChecarLoteEmMassa", "BTN_EnviaLoteEmMassa"):
        fields.pop(button, None)
    raw, headers = http_session.post(NFSE_LOTES_PATH, fields, timeout=timeout)
    page = _decode(raw, headers)
    if _looks_logged_out(page):
        raise ConnectorError("A sessão do S4E expirou durante a consulta dos lotes de notas fiscais.")
    ids = []
    for match in re.finditer(r"Lote\.aspx\?ID=([0-9]+)", page, re.I):
        value = match.group(1)
        if value not in ids:
            ids.append(value)
    return ids


def attach_faturamento_nf_links(http_session, rows, progress=None, cached=None, on_lot=None):
    lots = {}
    for row in rows:
        row["nfUrl"] = ""
        lot, nf = _nf_number(row.get("nfLote")), _nf_number(row.get("nf"))
        if lot and nf:
            lots.setdefault(lot, []).append(row)
    cached = cached or {}
    links_by_lot = {}
    pending = []
    for lot in lots:
        links = cached.get(lot)
        if links is None:
            pending.append(lot)
        else:
            links_by_lot[lot] = links
    total = len(lots)
    done = total - len(pending)
    if progress and done:
        progress(done, total, f"Links das notas já conferidos ({done} de {total}).")
    if pending:
        completed = 0
        pool = ThreadPoolExecutor(max_workers=NF_LOT_WORKERS)
        futures = {pool.submit(_fetch_nf_lot, http_session.clone(), lot): lot for lot in pending}
        try:
            for future in as_completed(futures, timeout=NF_LOT_BUDGET):
                lot = futures[future]
                completed += 1
                try:
                    links = future.result()
                except Exception:  # noqa: BLE001 - lote ilegível não impede a apuração
                    links = None
                if links is not None:
                    links_by_lot[lot] = links
                    if on_lot:
                        on_lot(lot, links)
                if progress:
                    progress(done + completed, total, f"Conferindo links das notas fiscais no S4E ({done + completed} de {total})...")
        except TimeoutError:
            pass
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
    for lot, items in lots.items():
        links = links_by_lot.get(lot) or {}
        for row in items:
            row["nfUrl"] = links.get((row["cdAssociado"], _nf_number(row["nf"])), "")


# ── Recibos de recebimento (empresas que pagaram) ───────────────────────────
RECEIPT_PATH = "/SYS/Financeiro/Movimentacao/Recibos/ReciboRecebimento.aspx"
RECEIPT_TIPO = "9"


def _receipt_label(page, label):
    match = re.search(r'id="' + label + r'"[^>]*>(.*?)</span>', page, re.I | re.S)
    if not match:
        return ""
    text = html_lib.unescape(re.sub(r"<[^>]+>", " ", match.group(1)))
    return re.sub(r"\s+", " ", text).strip()


def parse_receipt(page):
    numero = _receipt_label(page, "LBL_Numero1")
    if not re.fullmatch(r"[0-9]+", numero):
        raise ConnectorError("O S4E não devolveu o recibo desta parcela.")
    inputs = _parse_inputs(page)
    logo = re.search(r'id="LBL_Logo"[^>]*>.*?<img\b[^>]*\bsrc="([^"]+)"', page, re.I | re.S)
    return {
        "numero": numero,
        "valor": _receipt_label(page, "LBL_Valor1"),
        "nome": _receipt_label(page, "LBL_Nome1"),
        "extenso": _receipt_label(page, "LBL_ValorExtenso1"),
        "historico": _receipt_label(page, "LBL_Historico1"),
        "data": str(inputs.get("lbl_data1") or "").strip(),
        "hora": _receipt_label(page, "LBL_hora1"),
        "logo": html_lib.unescape(logo.group(1)) if logo else "",
    }


def fetch_receipt(http_session, parcela):
    parcela = str(parcela or "").strip()
    if not re.fullmatch(r"[0-9]+", parcela):
        raise ConnectorError("Parcela inválida para buscar o recibo.")
    raw, headers = http_session.get(
        f"{RECEIPT_PATH}?Tipo={RECEIPT_TIPO}&cd_parcela={parcela}", timeout=45
    )
    page = _decode(raw, headers)
    if _looks_logged_out(page):
        raise ConnectorError("A sessão do S4E expirou durante a busca dos recibos.")
    fields = parse_receipt(page)
    if fields["numero"] != parcela:
        raise ConnectorError("O S4E devolveu um recibo de outra parcela.")
    return fields


def fetch_receipt_logo(http_session, path):
    if not str(path or "").startswith("/SYS/"):
        raise ConnectorError("Endereço do logo do recibo inválido.")
    raw, _ = http_session.get(path, timeout=45)
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise ConnectorError("O S4E não devolveu o logo do recibo.")
    return raw


def fetch_faturamento_rows(http_session, start, end, progress=None, include_zero=False):
    for attempt in range(2):
        if progress:
            message = (
                "Abrindo o relatório de faturamento no S4E..."
                if attempt == 0 else
                "O S4E demorou para responder. Tentando ler o relatório novamente..."
            )
            progress(0, 1, message)
        try:
            raw, headers = http_session.get(_faturamento_detail_path(start, end), timeout=600)
            break
        except (TimeoutError, urllib.error.URLError) as exc:
            if not isinstance(exc, TimeoutError) and not isinstance(exc.reason, TimeoutError):
                raise
            if attempt == 1:
                raise ConnectorError(
                    "O S4E excedeu o tempo de resposta nas duas tentativas de leitura do relatório. "
                    "Tente atualizar novamente em alguns minutos"
                ) from exc
    page = _decode(raw, headers)
    if _looks_logged_out(page):
        raise ConnectorError("A sessão do S4E expirou. Conecte novamente e repita a apuração.")
    rows = parse_faturamento_rows(page, include_zero=include_zero)
    if progress:
        progress(1, 1, f"{len(rows)} título(s) lidos no S4E.")
    return rows


# ── Contatos da ficha (e-mail e WhatsApp) ───────────────────────────────────
def _company_url(code):
    return (
        "/SYS/Consultas/ConsultaGeralEmpresa.aspx?operacao=4&tipo=3&origem_info=3"
        f"&codigo={urllib.parse.quote(code)}&TXT_BuscaNome=&CMB_grupo=&TXT_BuscaCodigo=&TXT_NRCGC="
    )


def _associate_url(code):
    return (
        "/SYS/Consultas/ConsultaGeralAssociado.aspx?operacao=4&tipo=1&origem_info=1"
        f"&cdassociado={urllib.parse.quote(code)}"
    )


def _add_email(found, value):
    email = str(value or "").strip().replace("mailto:", "").split("?")[0]
    email = CONTACT_LABEL_RE.sub("", email)
    if not EMAIL_RE.fullmatch(email):
        return
    if email.lower().endswith("@s4e.com.br"):
        return
    if all(item.lower() != email.lower() for item in found):
        found.append(email)


def _add_phone(found, value):
    digits = re.sub(r"\D", "", str(value or ""))
    if len(digits) < 10 or len(digits) > 13:
        return
    if digits not in found:
        found.append(digits)


def parse_contacts(page):
    emails = []
    phones = []
    body = re.sub(r"(?is)<script\b.*?</script>|<style\b.*?</style>", " ", page)
    unescaped = html_lib.unescape(body)

    for match in re.finditer(r'mailto:\s*([^"\'<>\s?]+)', unescaped, re.I):
        _add_email(emails, match.group(1))
    for match in re.finditer(r'(?:wa\.me/|whatsapp[^"\']*?=|tel:)\+?([\d\s().\-]{10,20})', unescaped, re.I):
        _add_phone(phones, match.group(1))
    for match in re.finditer(r'<input\b[^>]*\bvalue\s*=\s*"([^"]*)"[^>]*>', body, re.I):
        value = html_lib.unescape(match.group(1))
        if "@" in value:
            _add_email(emails, value)

    for row in re.finditer(r"(?is)<tr\b.*?</tr>", body):
        text = html_lib.unescape(re.sub(r"<[^>]+>", " ", row.group(0)))
        if not re.search(r"e-?mail|whats|fone|telefone|celular", text, re.I):
            continue
        if re.search(r"function\s|__doPostBack|CDATA", text, re.I):
            continue
        for match in EMAIL_RE.finditer(text):
            _add_email(emails, match.group(0))
        for match in PHONE_RE.finditer(text):
            _add_phone(phones, f"{match.group(1)}{match.group(2)}{match.group(3)}")

    if not emails:
        for match in EMAIL_RE.finditer(unescaped):
            _add_email(emails, match.group(0))
    return {"emails": emails[:6], "phones": phones[:6]}


def fetch_contacts(http_session, code, documento):
    path = _company_url(code) if CNPJ_RE.match(documento or "") else _associate_url(code)
    raw, headers = http_session.get(path, timeout=90)
    page = _decode(raw, headers)
    if _looks_logged_out(page):
        raise ConnectorError("A sessão do S4E expirou durante a busca de contatos.")
    return parse_contacts(page)


# ── Job de importação ───────────────────────────────────────────────────────
_job_lock = threading.Lock()
_job = {
    "id": None,
    "running": False,
    "phase": "",
    "message": "",
    "done": 0,
    "total": 0,
    "percent": 0,
    "startedAt": None,
    "finishedAt": None,
    "result": None,
    "error": None,
}


def job_status():
    with _job_lock:
        return dict(_job)


def _job_update(**fields):
    with _job_lock:
        _job.update(fields)


def _today_br():
    now = date.today()
    return now.strftime("%d/%m/%Y")


def _period_br(value, fallback):
    raw = str(value or "").strip()
    iso = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", raw)
    if iso:
        return f"{iso.group(3)}/{iso.group(2)}/{iso.group(1)}"
    if re.match(r"^\d{2}/\d{2}/\d{4}$", raw):
        return raw
    return fallback


def start_import(options, importer):
    ensure_session()
    with _job_lock:
        if _job["running"]:
            raise ConnectorError("Já existe uma importação do S4E em andamento.")
        _job.update({
            "id": uuid.uuid4().hex,
            "running": True,
            "phase": "inicio",
            "message": "Iniciando a importação...",
            "done": 0,
            "total": 0,
            "percent": 0,
            "startedAt": datetime.now().isoformat(timespec="seconds"),
            "finishedAt": None,
            "result": None,
            "error": None,
        })
        job_id = _job["id"]
    worker = threading.Thread(
        target=_import_worker, args=(dict(options), importer), name="s4e-import", daemon=True
    )
    worker.start()
    return job_id


def _collect_rows(start, end):
    def progress(done, total, message):
        _job_update(
            phase="relatorio",
            message=message,
            done=done,
            total=total,
            percent=max(2, round(68 * done / max(total, 1))),
        )

    try:
        return fetch_overdue_rows(_require_session(), start, end, progress)
    except ConnectorError as exc:
        if "expirou" not in str(exc):
            raise
        disconnect()
        _job_update(message="Sessão do S4E expirada. Entrando novamente com a conta salva...", percent=0)
        return fetch_overdue_rows(ensure_session(), start, end, progress)


def _import_worker(options, importer):
    try:
        http_session = ensure_session()
        start = _period_br(options.get("periodStart"), "01/01/2020")
        end = _period_br(options.get("periodEnd"), _today_br())
        dry_run = bool(options.get("dryRun"))
        with_contacts = bool(options.get("withContacts"))
        source = str(options.get("source") or "s4e-portal")
        existing_contacts = options.get("existingContacts") or {}

        _job_update(
            phase="relatorio",
            message="Abrindo o relatório de faturamento no S4E...",
            done=0,
            total=0,
            percent=1,
        )
        rows = _collect_rows(start, end)

        if not rows:
            raise ConnectorError(
                "O S4E não retornou títulos de empresas em atraso. Confira se a conta tem acesso "
                "ao Faturamento e tente novamente."
            )
        if len(rows) > MAX_ROWS:
            raise ConnectorError(
                f"O relatório tem {len(rows)} títulos, acima do limite de {MAX_ROWS}. "
                "Reduza o período e importe em partes."
            )

        unique = {}
        for row in rows:
            unique.setdefault(row["cdAssociado"], row["documento"])
        clients = list(unique.items())
        warning = ""
        targets = clients
        if existing_contacts:
            for row in rows:
                known = existing_contacts.get(row["cdAssociado"]) or {}
                row["emails"] = list(known.get("emails") or [])
                row["phones"] = list(known.get("phones") or [])
            targets = [
                (code, documento) for code, documento in clients
                if not (
                    (existing_contacts.get(code) or {}).get("emails")
                    and (existing_contacts.get(code) or {}).get("phones")
                )
            ]
        if with_contacts and len(targets) > MAX_CONTACT_CLIENTS:
            warning = f"contatos lidos só para {MAX_CONTACT_CLIENTS} de {len(targets)} empresas sem contato salvo"
            targets = targets[:MAX_CONTACT_CLIENTS]

        if with_contacts and targets:
            _job_update(phase="contatos", done=0, total=len(targets), percent=70,
                        message=f"Buscando e-mail e WhatsApp em {len(targets)} ficha(s)...")
            contacts = {}
            done = 0
            with ThreadPoolExecutor(max_workers=CONTACT_WORKERS) as pool:
                futures = {
                    pool.submit(fetch_contacts, http_session.clone(), code, documento): code
                    for code, documento in targets
                }
                for future in as_completed(futures):
                    code = futures[future]
                    try:
                        contacts[code] = future.result()
                    except Exception:  # noqa: BLE001 - ficha sem contato não impede a importação
                        contacts[code] = {"emails": [], "phones": []}
                    done += 1
                    if done % 10 == 0 or done == len(targets):
                        _job_update(done=done,
                                    percent=70 + round(27 * done / len(targets)),
                                    message=f"Buscando contatos: {done} de {len(targets)}...")
            for row in rows:
                contact = contacts.get(row["cdAssociado"])
                if not contact:
                    continue
                row["emails"] = list(dict.fromkeys([*(row.get("emails") or []), *(contact.get("emails") or [])]))
                row["phones"] = list(dict.fromkeys([*(row.get("phones") or []), *(contact.get("phones") or [])]))

        if dry_run:
            sem_email = len({row["cdAssociado"] for row in rows if not row.get("emails")})
            sem_whats = len({row["cdAssociado"] for row in rows if not row.get("phones")})
            result = {
                "dryRun": True,
                "titulos": len(rows),
                "empresas": len(clients),
                "valor": round(sum(row["valor"] for row in rows), 2),
                "contacts": with_contacts,
                "semEmail": sem_email if with_contacts else None,
                "semWhatsapp": sem_whats if with_contacts else None,
                "aviso": warning,
            }
        else:
            _job_update(phase="gravando", percent=97, message="Gravando a fila de cobrança...")
            # Com período escolhido, um caso ausente pode estar só fora do recorte:
            # não pode ser baixado automaticamente.
            full_scope = not (options.get("periodStart") or options.get("periodEnd"))
            result = importer(
                rows,
                source=source,
                period_start=start,
                period_end=end,
                full_scope=full_scope,
            )
            if warning:
                result["aviso"] = warning

        _job_update(
            running=False,
            phase="concluido",
            percent=100,
            message="Importação concluída.",
            result=result,
            finishedAt=datetime.now().isoformat(timespec="seconds"),
        )
    except ConnectorError as exc:
        _job_update(running=False, phase="erro", message=str(exc), error=str(exc),
                    finishedAt=datetime.now().isoformat(timespec="seconds"))
    except Exception as exc:  # noqa: BLE001
        _job_update(running=False, phase="erro",
                    message="A importação do S4E falhou. Tente novamente.",
                    error=str(exc), finishedAt=datetime.now().isoformat(timespec="seconds"))
