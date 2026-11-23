"""Cadastros do S4E para o Relatório Semanal, somente leitura.

Empresas: grade de ContratosEMPRESA (todas as situações, filtro local pela
data de início do contrato).
Estabelecimentos: RelatorioCredenciamentos com TipoBusca = Cadastro.
"""

import html
import json
import re
import threading
import unicodedata
from datetime import date, datetime, timezone

import s4e_connector as s4e
import s4e_vendas
from s4e_retornos import ReturnTableParser

COMPANIES_PATH = "/SYS/Contratos/ContratosEMPRESA.aspx"
ESTABLISHMENTS_PATH = "/SYS/Cadastro/RelatorioCredenciamentos.aspx"
COMPANY_SITUATIONS = ("1", "24", "25", "4", "2", "21", "20", "22", "6", "16", "5", "17", "3")
COMPANY_LABELS = {
    "1": "ativas", "24": "ativas sem acesso ao app", "25": "ativas sem fatura e sem app",
    "4": "atrasadas", "2": "canceladas", "21": "canceladas por inadimplência",
    "20": "com cancelamento programado", "22": "importadas", "6": "inadimplentes",
    "16": "pré-cadastro", "5": "SPC", "17": "suspensas para ativação",
    "3": "suspensas para cancelamento",
}
PROFESSIONAL_PREFIX = re.compile(r"^PROFISSIONAL(?:\s+DE\s+LIVRE\s+ESCOLHA)?\s*[-–]?\s*", re.I)
MAX_PAGES = 120
REGISTRY_TTL = 24 * 60 * 60
WEEK_TTL = 30 * 60

_lock = threading.Lock()
_job = {"running": False, "start": "", "end": "", "force": False, "message": "", "done": 0,
        "total": 0, "error": "", "startedAt": None, "finishedAt": None}
_connection = None
_credentials = None
_busy = None


def configure(connection, credentials, busy):
    global _connection, _credentials, _busy
    _connection, _credentials, _busy = connection, credentials, busy


def _stamp():
    return datetime.now(timezone.utc).isoformat()


def _update(**values):
    with _lock:
        _job.update(values)


def job_status():
    with _lock:
        return dict(_job)


def period(payload):
    if not isinstance(payload, dict):
        raise ValueError("Informe o período em um objeto JSON.")
    end = date.fromisoformat(payload.get("end") or date.today().isoformat())
    start = date.fromisoformat(payload.get("start") or end.replace(day=1).isoformat())
    if start > end or (end - start).days > 30 or end > date.today():
        raise ValueError("Escolha até 31 dias, sem datas futuras.")
    return start, end


def ensure_schema(db):
    db.execute(
        """CREATE TABLE IF NOT EXISTS semanal_empresas (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            payload TEXT NOT NULL,
            checked_at TEXT NOT NULL
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS semanal_semanas (
            inicio TEXT NOT NULL,
            fim TEXT NOT NULL,
            payload TEXT NOT NULL,
            checked_at TEXT NOT NULL,
            PRIMARY KEY (inicio, fim)
        )"""
    )


# ── HTTP ────────────────────────────────────────────────────────────────────
def _checked(raw, headers):
    page = s4e._decode(raw, headers)
    if s4e._looks_logged_out(page) or "TXT_CPF" in s4e._parse_inputs(page):
        raise s4e.ConnectorError("A sessão do S4E expirou durante a consulta dos cadastros.")
    return page


def _attr(tag, name):
    match = re.search(r"\b" + name + r'\s*=\s*"([^"]*)"', tag, re.I) or re.search(
        r"\b" + name + r"\s*=\s*'([^']*)'", tag, re.I
    )
    return html.unescape(match.group(1)) if match else ""


def _form_fields(page):
    fields = {}
    for match in re.finditer(r"<input\b[^>]*>", page, re.I):
        tag = match.group(0)
        name = _attr(tag, "name")
        kind = (_attr(tag, "type") or "text").lower()
        if not name or kind in ("submit", "image", "button", "reset"):
            continue
        if kind in ("checkbox", "radio") and not re.search(r"\bchecked\b", tag, re.I):
            continue
        fields[name] = _attr(tag, "value")
    for match in re.finditer(r"<select\b[^>]*>(.*?)</select>", page, re.I | re.S):
        tag = match.group(0)[: match.group(0).find(">") + 1]
        name = _attr(tag, "name")
        if not name:
            continue
        options = re.findall(r"<option\b([^>]*)>(.*?)</option>", match.group(1), re.I | re.S)
        chosen = ""
        for attrs, label in options:
            if re.search(r"\bselected\b", attrs, re.I):
                chosen = _attr(attrs, "value") or html.unescape(re.sub(r"<[^>]+>", "", label)).strip()
                break
        if not chosen and options:
            attrs, label = options[0]
            chosen = _attr(attrs, "value") or html.unescape(re.sub(r"<[^>]+>", "", label)).strip()
        fields[name] = chosen
    for match in re.finditer(r'<textarea\b[^>]*\bname="([^"]*)"[^>]*>(.*?)</textarea>', page, re.I | re.S):
        fields[match.group(1)] = html.unescape(match.group(2))
    return fields


def _pager_links(page):
    links = []
    pattern = re.compile(
        r"<a\b[^>]*__doPostBack\((?:&#39;|'|\")([^'\"&]+)[^>]*>(.*?)</a>", re.I | re.S
    )
    for match in pattern.finditer(page):
        target = match.group(1).strip()
        label = re.sub(r"<[^>]+>", " ", match.group(2))
        label = html.unescape(re.sub(r"\s+", " ", label)).strip()
        if target.startswith("GRD_Resultado$"):
            links.append((target, label))
    return links


def _row_key(item):
    return (str(item.get("id") or ""), str(item.get("nome") or ""), str(item.get("data") or ""))


def _current_page(page):
    """Descobre a página aberta pela janela do pager (a página atual não aparece como link)."""
    numbers = sorted({int(label) for _, label in _pager_links(page) if label.isdigit()})
    if not numbers:
        return 0
    for left, right in zip(numbers, numbers[1:]):
        if right - left > 1:
            return left + 1
    if numbers[0] > 1:
        return numbers[0] - 1
    return numbers[-1] + 1


def _page_choice(page, visited):
    """Escolhe a próxima ação do pager: ('page', número, alvo) ou ('jump', None, alvo).

    A grade mostra uma janela de 10 botões. À esquerda e à direita podem existir
    setas "...": a da esquerda volta um bloco, a da direita avança um bloco.
    Só a seta da frente interessa; e ela precisa poder ser usada mais de uma vez,
    porque a lista de empresas tem vários blocos (o antigo limite parava no 1º).
    """
    numbers, ellipses = {}, []
    last_number_pos = -1
    for pos, (target, label) in enumerate(_pager_links(page)):
        if label.isdigit():
            numbers.setdefault(int(label), target)
            last_number_pos = pos
        elif label in ("...", "…"):
            ellipses.append((pos, target))
    for number in sorted(numbers):
        if number not in visited:
            return "page", number, numbers[number]
    for pos, target in reversed(ellipses):
        if pos > last_number_pos:
            return "jump", None, target
    return "", None, ""


def _walk(session, path, page, parse, progress=None):
    rows = parse(page)
    known = {_row_key(item) for item in rows}
    visited = {1}
    pages = 1
    stalls = 0
    while pages < MAX_PAGES:
        kind, number, target = _page_choice(page, visited)
        if not target:
            break
        fields = _form_fields(page)
        fields.update(__EVENTTARGET=target, __EVENTARGUMENT="")
        page = _checked(*session.post(path, fields, timeout=120))
        # A janela do pager diz em que página caímos: sem isso, o salto de bloco
        # faria a rotina voltar um passo e achar que a grade repetiu.
        visited.add(_current_page(page))
        fresh = [item for item in parse(page) if _row_key(item) not in known]
        if not fresh:
            # Página já lida (ou resposta repetida): segue do estado atual e
            # só desiste se duas tentativas seguidas não trouxerem nada novo.
            stalls += 1
            if stalls > 1:
                break
            continue
        stalls = 0
        known.update(_row_key(item) for item in fresh)
        rows.extend(fresh)
        pages += 1
        if progress and pages % 5 == 0:
            progress(pages, len(rows))
    return rows


# ── Leitura das grades ──────────────────────────────────────────────────────
def _iso(value):
    match = re.match(r"^(\d{2})/(\d{2})/(\d{4})", str(value or "").strip())
    return f"{match.group(3)}-{match.group(2)}-{match.group(1)}" if match else ""


def _key(value):
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", re.sub(r"[^0-9A-Za-z]+", " ", text)).strip().casefold()


def _columns(cells, expected):
    labels = [_key(cell["text"]) for cell in cells]
    positions = {}
    for name in expected:
        key = _key(name)
        if key not in labels:
            return {}
        positions[name] = labels.index(key)
    return positions


def parse_companies(page):
    parser = ReturnTableParser("GRD_Resultado")
    parser.feed(page)
    expected = ("razão social", "nome fantasia", "tipo empresa", "início contrato", "situação", "centro de custo")
    positions = None
    result = []
    for cells in parser.rows:
        if positions is None:
            positions = _columns(cells, expected) or None
            continue
        if len(cells) <= max(positions.values(), default=0):
            continue
        values = [re.sub(r"\s+", " ", cell["text"]).strip() for cell in cells]
        raw_name = values[positions["razão social"]]
        match = re.match(r"^\s*(\d+)\s*-\s*(.+?)\s*$", raw_name)
        code, name = (match.group(1), match.group(2)) if match else ("", raw_name)
        start = _iso(values[positions["início contrato"]])
        if not name or not start:
            continue
        result.append({
            "id": code,
            "nome": name,
            "tipo": values[positions["tipo empresa"]],
            "data": start,
            "situacao": values[positions["situação"]],
            "centro": values[positions["centro de custo"]],
        })
    if positions is None and parser.rows:
        raise s4e.ConnectorError("As colunas da lista de empresas do S4E não foram reconhecidas.")
    return result


def parse_establishments(page):
    parser = ReturnTableParser("GRD_Resultado")
    parser.feed(page)
    expected = ("código", "dentista", "cro", "credenciamento", "descredenciamento", "cadastro")
    positions = None
    result = []
    for cells in parser.rows:
        if positions is None:
            positions = _columns(cells, expected) or None
            continue
        if len(cells) <= max(positions.values(), default=0):
            continue
        values = [re.sub(r"\s+", " ", cell["text"]).strip() for cell in cells]
        raw_name = values[positions["dentista"]]
        name = PROFESSIONAL_PREFIX.sub("", raw_name).strip()
        registered = _iso(values[positions["cadastro"]])
        if not name or not registered:
            continue
        result.append({
            "id": values[positions["código"]],
            "nome": name,
            "cro": values[positions["cro"]],
            "credenciamento": _iso(values[positions["credenciamento"]]),
            "descredenciamento": _iso(values[positions["descredenciamento"]]),
            "data": registered,
        })
    if positions is None and parser.rows:
        raise s4e.ConnectorError("As colunas da lista de estabelecimentos do S4E não foram reconhecidas.")
    return result


def _search_companies(session, situation, progress):
    page = _checked(*session.get(COMPANIES_PATH, timeout=60))
    fields = {key: value for key, value in _form_fields(page).items() if key.startswith("__")}
    fields.update(
        __EVENTTARGET="", __EVENTARGUMENT="",
        TXT_BuscaCodigo="", TXT_BuscaNome="", TXT_NRCGC="", TXT_CdEmpresa="",
        CMB_Situacao=situation, CMB_CentroCusto="-1", TXT_CodigoGrupo="", TXT_NomeGrupo="",
        TXT_TRANSP="", TXT_CDEmpresa_Adesao="", TXT_nrcontrato="", CMD_Buscar="Buscar",
    )
    page = _checked(*session.post(COMPANIES_PATH, fields, timeout=180))
    return _walk(session, COMPANIES_PATH, page, parse_companies, progress)


def fetch_companies(session, progress):
    companies = {}
    total = len(COMPANY_SITUATIONS)
    for index, situation in enumerate(COMPANY_SITUATIONS, 1):
        label = COMPANY_LABELS[situation]
        progress(f"Conferindo empresas {label} ({index}/{total})...", index - 1, total)

        def inside(pages, rows, label=label, index=index):
            progress(f"Empresas {label}: página {pages}, {rows} registro(s) ({index}/{total})...",
                     index - 1, total)

        for item in _search_companies(session, situation, inside):
            companies[item["id"] or item["nome"]] = item
        progress(f"Empresas {label}: {len(companies)} cadastro(s) lido(s) até agora.", index, total)
    return sorted(companies.values(), key=lambda item: (item["data"], item["nome"]))


def fetch_establishments(session, start, end, progress):
    progress("Conferindo estabelecimentos cadastrados no período...", 0, 1)
    page = _checked(*session.get(ESTABLISHMENTS_PATH, timeout=60))
    fields = _form_fields(page)
    fields.update(
        __EVENTTARGET="", __EVENTARGUMENT="",
        TXT_DataInicial=start.strftime("%d/%m/%Y"), TXT_DataFinal=end.strftime("%d/%m/%Y"),
        CMB_TipoBusca="2", BTN_Buscar="Buscar",
    )
    page = _checked(*session.post(ESTABLISHMENTS_PATH, fields, timeout=180))
    rows = _walk(session, ESTABLISHMENTS_PATH, page, parse_establishments)
    result = {f'{item["id"]}|{item["nome"]}': item for item in rows}
    progress(f"Estabelecimentos: {len(result)} cadastro(s) no período.", 1, 1)
    return sorted(result.values(), key=lambda item: (item["data"], item["nome"]))


# ── Cache e consulta ────────────────────────────────────────────────────────
def _load_registry(db):
    row = db.execute("SELECT payload, checked_at FROM semanal_empresas WHERE id = 1").fetchone()
    if not row:
        return [], ""
    try:
        return json.loads(row["payload"]).get("empresas", []), row["checked_at"]
    except (TypeError, ValueError):
        return [], ""


def _load_week(db, start, end):
    row = db.execute(
        "SELECT payload, checked_at FROM semanal_semanas WHERE inicio = ? AND fim = ?",
        (start.isoformat(), end.isoformat()),
    ).fetchone()
    if not row:
        return [], ""
    try:
        return json.loads(row["payload"]).get("estabelecimentos", []), row["checked_at"]
    except (TypeError, ValueError):
        return [], ""


def _age(checked_at):
    if not checked_at:
        return None
    try:
        stamp = datetime.fromisoformat(checked_at)
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - stamp).total_seconds()
    except ValueError:
        return None


def _fresh(checked_at, ttl):
    age = _age(checked_at)
    return age is not None and age <= ttl


def _store_registry(db, companies):
    db.execute(
        "INSERT INTO semanal_empresas(id, payload, checked_at) VALUES(1, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, checked_at = excluded.checked_at",
        (json.dumps({"empresas": companies}, ensure_ascii=False), _stamp()),
    )


def _store_week(db, start, end, establishments):
    db.execute(
        "INSERT INTO semanal_semanas(inicio, fim, payload, checked_at) VALUES(?, ?, ?, ?) "
        "ON CONFLICT(inicio, fim) DO UPDATE SET payload = excluded.payload, checked_at = excluded.checked_at",
        (start.isoformat(), end.isoformat(),
         json.dumps({"estabelecimentos": establishments}, ensure_ascii=False), _stamp()),
    )


def overview(db, start, end):
    registry, registry_at = _load_registry(db)
    establishments, week_at = _load_week(db, start, end)
    first, last = start.isoformat(), end.isoformat()
    companies = sorted(
        (item for item in registry if first <= item["data"] <= last),
        key=lambda item: (item["data"], item["nome"]),
    )
    return {
        "inicio": first,
        "fim": last,
        "empresas": companies,
        "estabelecimentos": establishments,
        "empresasConsultadoEm": registry_at,
        "estabelecimentosConsultadoEm": week_at,
        "empresasDesatualizadas": not _fresh(registry_at, REGISTRY_TTL),
        "estabelecimentosDesatualizados": not _fresh(week_at, WEEK_TTL),
        "totalEmpresasConhecidas": len(registry),
        "job": job_status(),
    }


def start_sync(start, end, force=False):
    if _busy():
        raise s4e.ConnectorError("Aguarde outra consulta ou apuração terminar antes de atualizar os cadastros.")
    with _lock:
        if _job["running"]:
            raise s4e.ConnectorError("A atualização dos cadastros já está em andamento. Aguarde a conclusão.")
        _job.update(running=True, start=start.isoformat(), end=end.isoformat(), force=bool(force),
                    message="Abrindo uma sessão de consulta no S4E...", done=0, total=2,
                    error="", startedAt=_stamp(), finishedAt=None)
    try:
        threading.Thread(target=_worker, args=(start, end, bool(force)), name="s4e-semanal", daemon=True).start()
    except Exception:
        _update(running=False, finishedAt=_stamp())
        raise


def _worker(start, end, force):
    try:
        session = s4e_vendas.open_session(_credentials())

        def progress(message, done, total):
            _update(message=message, done=done, total=total)

        establishments = fetch_establishments(session, start, end, progress)
        with _connection() as db:
            _store_week(db, start, end, establishments)

        with _connection() as db:
            registry, registry_at = _load_registry(db)
        if force or not _fresh(registry_at, REGISTRY_TTL):
            companies = fetch_companies(session, progress)
            with _connection() as db:
                _store_registry(db, companies)
        else:
            companies = registry

        in_week = [item for item in companies
                   if start.isoformat() <= item["data"] <= end.isoformat()]
        _update(message=(f"Atualização concluída: {len(in_week)} empresa(s) e "
                         f"{len(establishments)} estabelecimento(s) de "
                         f"{start:%d/%m/%Y} a {end:%d/%m/%Y}."), error="")
    except Exception as exc:
        _update(error=str(exc), message="A atualização não foi concluída. Os dados anteriores foram preservados.")
    finally:
        _update(running=False, finishedAt=_stamp())