import re
from html.parser import HTMLParser
from urllib.parse import quote

import s4e_connector as s4e
import vidas

REPORT_PATH = "/SYS/Faturamento/RelatorioUsuarioXPeriodoXSituacao.aspx?TipoUsuario=1"
COMPANY_USERS_PATH = "/SYS/Contratos/RelatorioAssociadosPorEmpresa.aspx"
MAX_ROWS = 60000
STATUS_CODES = {"ATIVO": "1", "CANCELADO": "2"}


class _ExportTable(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows = []
        self._row = None
        self._cell = None
        self._depth = 0

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self._depth += 1
        elif tag == "tr" and self._depth:
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []
        elif tag == "br" and self._cell is not None:
            self._cell.append(" ")

    def handle_endtag(self, tag):
        if tag == "table":
            self._depth = max(0, self._depth - 1)
        elif tag in ("td", "th") and self._cell is not None and self._row is not None:
            self._row.append(re.sub(r"\s+", " ", "".join(self._cell)).replace("\xa0", " ").strip())
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if self._row:
                self.rows.append(self._row)
            self._row = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def open_session(credentials):
    if not credentials:
        raise s4e.ConnectorError("Configure a conta do S4E antes de consultar os usuários.")
    session = s4e.S4EHttp()
    raw, headers = session.get(s4e.LOGIN_PATH, timeout=45)
    inputs = s4e._parse_inputs(s4e._decode(raw, headers))
    if "TXT_CPF" not in inputs:
        raise s4e.ConnectorError("A tela de login do S4E não foi reconhecida.")
    inputs.update(CMB_Tipo="5", TXT_CPF=re.sub(r"\D", "", credentials[0]), TXT_Senha=credentials[1],
                  BTN_Avancar=inputs.get("BTN_Avancar") or "Avançar")
    raw, headers = session.post("/SYS/Login.aspx", inputs, timeout=60)
    _checked(s4e._decode(raw, headers))
    return session


def _checked(page):
    if s4e._looks_logged_out(page) or "TXT_CPF" in s4e._parse_inputs(page):
        raise s4e.ConnectorError("A sessão do S4E expirou durante a consulta de usuários.")
    return page


def _hidden_fields(delta):
    return {
        match.group(1): match.group(2)
        for match in re.finditer(r"\|\d+\|hiddenField\|([^|]+)\|([^|]*)\|", delta)
    }


def _grid(page):
    parser = _ExportTable()
    parser.feed(page)
    rows = [row for row in parser.rows if row]
    if not rows:
        return [], []
    header_index = max(range(min(len(rows), 6)), key=lambda index: len(rows[index]))
    return rows[header_index], rows[header_index + 1:]


def parse_export(page):
    """Converte a grade HTML devolvida pelo S4E na estrutura lida por vidas.parse_relatorio."""
    header, rows = _grid(page)
    if not header or not any(vidas._norm(label) == "USUARIO" for label in header):
        raise s4e.ConnectorError("O S4E não retornou a grade de usuários. Tente novamente em instantes.")
    if not any(vidas._norm(label) in ("CPF", "CONTRATO") for label in header):
        raise s4e.ConnectorError("A grade de usuários do S4E veio sem CPF e sem contrato.")
    width = len(header)
    cells = {(0, column): label for column, label in enumerate(header)}
    used = 0
    for offset, row in enumerate(rows, start=1):
        values = (row + [""] * width)[:width]
        if not values[1]:
            continue
        for column, value in enumerate(values):
            cells[(offset, column)] = value
        used = offset
    return [("Relatório de usuários do S4E", cells, used + 1, width)]


def fetch_company_associates(session, company_code):
    """Lista nominal atual de associados de uma empresa, em modo somente leitura."""
    code = re.sub(r"\D", "", str(company_code or ""))
    if not code:
        raise ValueError("Código da empresa inválido.")
    raw, headers = session.get(COMPANY_USERS_PATH, timeout=60)
    page = _checked(s4e._decode(raw, headers))
    fields = s4e._parse_inputs(page)
    if "TXT_Empresa" not in fields or "BTN_Avancar" not in fields:
        raise s4e.ConnectorError("O relatório de associados por empresa mudou no S4E.")
    fields.update(TXT_Empresa=code, CMB_Situacao="1", CMB_SituacaoAvancado="-1", BTN_Avancar="Buscar")
    # O faturamento conta titulares e dependentes; o relatório vem marcado como
    # "apenas titulares" por padrão, por isso retiramos o filtro.
    fields.pop("CHK_Titulares", None)
    fields.pop("CHK_ApenasCarencia", None)
    raw, headers = session.post(COMPANY_USERS_PATH, fields, timeout=180)
    page = _checked(s4e._decode(raw, headers))
    header, rows = _grid(page)
    normalized = {vidas._norm(label): index for index, label in enumerate(header)}
    # O centro de custo é o que identifica o plano (ex.: PJ TOP INDIVIDUAL COM
    # ODONTOLOGIA). O S4E ora chama de "CENTRO DE CUSTO", ora de "PLANO".
    for alias in ("CENTRO DE CUSTO", "CENTRO CUSTO", "PLANO"):
        if alias in normalized and "CENTRO DE CUSTO" not in normalized:
            normalized["CENTRO DE CUSTO"] = normalized[alias]
    required = {"ASSOCIADO", "NOME", "CPF", "EMPRESA", "DATA DE ADESAO", "SITUACAO"}
    if not required <= set(normalized):
        if not rows:
            return []
        raise s4e.ConnectorError("O S4E devolveu a lista nominal em um formato não reconhecido.")

    def value(row, label):
        index = normalized.get(label)
        return str(row[index] if index is not None and index < len(row) else "").strip()

    result = []
    seen = set()
    for row in rows:
        holder = value(row, "NOME")
        user_name = value(row, "USUARIO") or holder
        if not user_name:
            continue
        associate = value(row, "ASSOCIADO")
        cpf = re.sub(r"\D", "", value(row, "CPF"))
        key = f"{associate}|{vidas._norm(user_name)}|{cpf}|{value(row, 'DATA DE ADESAO')}"
        if key in seen:
            continue
        seen.add(key)
        result.append({
            "associado": associate,
            "nome": user_name,
            "titular": holder,
            "cpf": value(row, "CPF"),
            "usuario": value(row, "USUARIO"),
            "valor": vidas._money(value(row, "VALOR")),
            "empresaCodigo": value(row, "EMPRESA"),
            "empresa": value(row, "RAZAO SOCIAL"),
            "tipoPagamento": value(row, "TIPO DE PAGAMENTO"),
            "matricula": value(row, "MATRICULA"),
            "grupo": value(row, "GRUPO DE FATURAMENTO"),
            "adesao": value(row, "DATA DE ADESAO"),
            "situacao": value(row, "SITUACAO"),
            "centro": value(row, "CENTRO DE CUSTO"),
        })
    return result


def fetch_users(session, start, end, escopo="all", progress=lambda message, done, total: None):
    """Consulta o relatório de usuários por período/situação; somente leitura."""
    if escopo not in ("all", *STATUS_CODES):
        raise ValueError("Escolha uma situação válida para a consulta.")
    progress("Abrindo o relatório de usuários do S4E...", 0, 0)
    raw, headers = session.get(quote(REPORT_PATH, safe="/?=&%"), timeout=60)
    page = _checked(s4e._decode(raw, headers))
    inputs = s4e._parse_inputs(page)
    if "TXT_DataInicial" not in inputs or "BTN_Buscar" not in inputs:
        raise s4e.ConnectorError("A tela de usuários do S4E mudou; a consulta foi interrompida.")
    codes = list(STATUS_CODES.values()) if escopo == "all" else [STATUS_CODES[escopo]]
    items = {}
    for index, code in enumerate(codes):
        progress(f"Consultando usuários {'ativos' if code == '1' else 'cancelados'} no S4E...", index, len(codes))
        fields = dict(inputs)
        fields.update(__EVENTTARGET="", __EVENTARGUMENT="", __ASYNCPOST="true",
                      ScriptManager1="UpdatePanelGeral|BTN_Buscar",
                      TXT_DataInicial=start.strftime("%d/%m/%Y"), TXT_DataFinal=end.strftime("%d/%m/%Y"),
                      CMB_Situacao=code, CMB_TipoUsuario="1", CMB_GrupoFaturamento="-1",
                      BTN_Buscar="Buscar")
        raw, headers = session.post_ajax(quote(REPORT_PATH, safe="/?=&%"), fields, timeout=300)
        text = _checked(s4e._decode(raw, headers))
        inputs.update(_hidden_fields(text))
        parsed = vidas.parse_relatorio(parse_export(text))
        for item in parsed["rows"]:
            if escopo != "all" and item["situacao"] != escopo:
                continue
            items[item["chave"]] = item
            if len(items) > MAX_ROWS:
                raise s4e.ConnectorError("O relatório excedeu o limite de registros. Selecione um período menor.")
        progress(f"Consultados {len(items)} usuário(s) até aqui.", index + 1, len(codes))
    if not items:
        raise s4e.ConnectorError("O S4E não retornou usuários no período selecionado.")
    rows = list(items.values())
    ativos = sum(1 for item in rows if item["situacao"] == "ATIVO")
    return {"aba": "Relatório de usuários do S4E", "rows": rows, "ativos": ativos, "cancelados": len(rows) - ativos}
