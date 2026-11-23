"""Conferência de notas fiscais duplicadas no S4E. Somente leitura."""
import json
import re
import threading
import time
import unicodedata
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone

import s4e_connector as s4e
import xlsx_simple as xlsx

MAX_TITLES = 60000
MAX_DAYS = 366
MAX_LOTS = 90
LOT_WORKERS = 4
LOT_TIMEOUT = 20
LOT_BUDGET = 240
LOTE_TTL_DAYS = 7
LOTE_EMPTY_TTL_HOURS = 24

CLASSIFICATIONS = {
    "confirmada": "Duplicidade confirmada",
    "provavel": "Provável duplicidade",
    "suspeita": "Suspeita (sem nota emitida)",
}

TRIBUTO_FIELDS = (
    ("cofins", "COFINS", "COFINS RET"),
    ("csll", "CSLL", "CSLL RET"),
    ("inss", "INSS", "INSS RET"),
    ("ir", "IR", "IR RET"),
    ("iss", "ISS", "ISS RET"),
    ("pis", "PIS", "PIS RET"),
)

_lock = threading.Lock()
_job = {
    "running": False, "runId": None, "inicio": "", "fim": "", "phase": "inicio",
    "message": "", "percent": 0, "done": 0, "total": 0, "error": "",
    "startedAt": None, "finishedAt": None,
}
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


def ensure_schema(db):
    db.execute(
        """CREATE TABLE IF NOT EXISTS notas_runs (
            id TEXT PRIMARY KEY,
            inicio TEXT NOT NULL DEFAULT '',
            fim TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'running',
            total_titulos INTEGER NOT NULL DEFAULT 0,
            total_notas INTEGER NOT NULL DEFAULT 0,
            grupos INTEGER NOT NULL DEFAULT 0,
            confirmadas INTEGER NOT NULL DEFAULT 0,
            provaveis INTEGER NOT NULL DEFAULT 0,
            suspeitas INTEGER NOT NULL DEFAULT 0,
            valor_risco REAL NOT NULL DEFAULT 0,
            valor_total REAL NOT NULL DEFAULT 0,
            impostos REAL NOT NULL DEFAULT 0,
            multas REAL NOT NULL DEFAULT 0,
            acrescimos REAL NOT NULL DEFAULT 0,
            tarifas REAL NOT NULL DEFAULT 0,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            created_by TEXT NOT NULL DEFAULT '',
            error TEXT NOT NULL DEFAULT '',
            timings TEXT NOT NULL DEFAULT ''
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS notas_rows (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            grupo TEXT NOT NULL DEFAULT '',
            ordem INTEGER NOT NULL DEFAULT 0,
            classificacao TEXT NOT NULL DEFAULT '',
            papel TEXT NOT NULL DEFAULT '',
            justificativa TEXT NOT NULL DEFAULT '',
            motivos TEXT NOT NULL DEFAULT '[]',
            empresa TEXT NOT NULL DEFAULT '',
            documento TEXT NOT NULL DEFAULT '',
            grupo_empresa TEXT NOT NULL DEFAULT '',
            departamento TEXT NOT NULL DEFAULT '',
            competencia TEXT NOT NULL DEFAULT '',
            tipo_parcela TEXT NOT NULL DEFAULT '',
            vencimento TEXT NOT NULL DEFAULT '',
            gerado TEXT NOT NULL DEFAULT '',
            emissao TEXT NOT NULL DEFAULT '',
            valor REAL NOT NULL DEFAULT 0,
            titulo REAL NOT NULL DEFAULT 0,
            imposto REAL NOT NULL DEFAULT 0,
            taxa REAL NOT NULL DEFAULT 0,
            tarifa REAL NOT NULL DEFAULT 0,
            multa REAL NOT NULL DEFAULT 0,
            acrescimo REAL NOT NULL DEFAULT 0,
            acrescimo_avulso REAL NOT NULL DEFAULT 0,
            desconto REAL NOT NULL DEFAULT 0,
            desconto_pagamento REAL NOT NULL DEFAULT 0,
            valor_pago REAL NOT NULL DEFAULT 0,
            data_pagamento TEXT NOT NULL DEFAULT '',
            parcela TEXT NOT NULL DEFAULT '',
            lote TEXT NOT NULL DEFAULT '',
            nf TEXT NOT NULL DEFAULT '',
            situacao TEXT NOT NULL DEFAULT '',
            vidas TEXT NOT NULL DEFAULT '',
            nf_url TEXT NOT NULL DEFAULT '',
            tributos TEXT NOT NULL DEFAULT ''
        )"""
    )
    db.execute("CREATE INDEX IF NOT EXISTS notas_rows_run ON notas_rows(run_id)")
    db.execute("CREATE INDEX IF NOT EXISTS notas_rows_grupo ON notas_rows(run_id, grupo)")
    db.execute(
        """CREATE TABLE IF NOT EXISTS notas_lotes (
            lote TEXT PRIMARY KEY,
            payload TEXT NOT NULL DEFAULT '',
            fetched_at TEXT NOT NULL
        )"""
    )


def parse_period(payload):
    if not isinstance(payload, dict):
        raise ValueError("Informe o período da conferência.")
    try:
        start = date.fromisoformat(str(payload.get("start") or "").strip())
        end = date.fromisoformat(str(payload.get("end") or "").strip())
    except ValueError as exc:
        raise ValueError("Informe a data inicial e a data final da conferência.") from exc
    if start > end:
        raise ValueError("A data inicial não pode ser maior que a data final.")
    if (end - start).days > MAX_DAYS:
        raise ValueError("Escolha um período de até 366 dias para conferir as notas.")
    return start, end


def start_run(start, end, usuario=""):
    if _busy():
        raise s4e.ConnectorError("Aguarde outra consulta ou apuração terminar antes de conferir as notas.")
    run_id = str(uuid.uuid4())
    with _lock:
        if _job["running"]:
            raise s4e.ConnectorError("Já existe uma conferência de notas em andamento. Aguarde a conclusão.")
        _job.update(
            running=True, runId=run_id, inicio=start.isoformat(), fim=end.isoformat(), phase="inicio",
            message="Preparando a conferência de notas fiscais...", percent=2, done=0, total=0,
            error="", startedAt=_stamp(), finishedAt=None,
        )
    inserted = False
    try:
        with _connection() as db:
            db.execute(
                "INSERT INTO notas_runs(id, inicio, fim, status, started_at, created_by) VALUES (?, ?, ?, 'running', ?, ?)",
                (run_id, start.isoformat(), end.isoformat(), _stamp(), usuario),
            )
            db.commit()
            inserted = True
        threading.Thread(target=_worker, args=(run_id, start, end), name="s4e-notas", daemon=True).start()
    except Exception as exc:
        if inserted:
            try:
                with _connection() as db:
                    db.execute(
                        "UPDATE notas_runs SET status = 'error', finished_at = ?, error = ? WHERE id = ?",
                        (_stamp(), str(exc), run_id),
                    )
                    db.commit()
            except Exception:  # noqa: BLE001 - mantém o erro original
                pass
        _update(running=False, phase="erro", error=str(exc), finishedAt=_stamp())
        raise
    return run_id


def _worker(run_id, start, end):
    started = time.monotonic()
    timings = {}
    try:
        _update(phase="s4e", percent=4, message="Abrindo a sessão do S4E e lendo o relatório de faturamento...")
        session = s4e.ensure_session()
        try:
            rows = s4e.fetch_faturamento_rows(
                session, start.strftime("%d/%m/%Y"), end.strftime("%d/%m/%Y"),
                lambda done, total, message: _update(
                    phase="s4e", message=message, done=done, total=total,
                    percent=5 + round(55 * done / max(total, 1)),
                ),
                include_zero=True,
            )
        except s4e.ConnectorError as exc:
            if "expirou" not in str(exc):
                raise
            s4e.disconnect()
            _update(phase="s4e", percent=4, message="A sessão do S4E expirou. Entrando novamente com a conta salva...")
            session = s4e.ensure_session()
            rows = s4e.fetch_faturamento_rows(
                session, start.strftime("%d/%m/%Y"), end.strftime("%d/%m/%Y"), include_zero=True,
            )
        if not rows:
            raise s4e.ConnectorError("O S4E não retornou títulos no período selecionado.")
        if len(rows) > MAX_TITLES:
            raise s4e.ConnectorError("O período tem títulos demais. Escolha um intervalo menor para conferir as notas.")
        timings["relatorio"] = round(time.monotonic() - started, 1)

        _update(phase="grupos", percent=64, message="Comparando títulos, parcelas e notas fiscais...")
        groups = build_groups(rows)
        annotate(rows, groups)
        timings["comparacao"] = round(time.monotonic() - started - sum(timings.values()), 1)

        lots = sorted({_lot(row) for group in groups for row in group["rows"] if _lot(row)})
        if groups and any(not _lot(row) for group in groups for row in group["rows"]):
            _update(phase="tributos", percent=68, message="Localizando no S4E os lotes das notas fiscais...")
            try:
                discovered = s4e.fetch_nfse_lot_ids(session, start, end)
            except s4e.ConnectorError:
                discovered = []
            lots = sorted(set(lots) | set(discovered[-MAX_LOTS:]))
        if lots:
            _update(phase="tributos", percent=70, total=len(lots), done=0,
                    message=f"Lendo os tributos das notas em {len(lots)} lote(s) no S4E...")
            cache = _load_lotes(lots)
            pending = [lot for lot in lots if lot not in cache]
            updates = {}
            done = len(lots) - len(pending)
            if pending:
                pool = ThreadPoolExecutor(max_workers=LOT_WORKERS)
                futures = {pool.submit(_fetch_lote, session.clone(), lot): lot for lot in pending}
                try:
                    for future in as_completed(futures, timeout=LOT_BUDGET):
                        lot = futures[future]
                        done += 1
                        try:
                            payload = future.result()
                        except Exception:  # noqa: BLE001 - lote ilegível não impede a conferência
                            payload = None
                        if payload is not None:
                            cache[lot] = payload
                            updates[lot] = payload
                        _update(phase="tributos", percent=70 + round(18 * done / max(len(lots), 1)),
                                done=done, total=len(lots),
                                message=f"Conferindo tributos no S4E ({done} de {len(lots)} lote(s))...")
                except TimeoutError:
                    pass
                finally:
                    pool.shutdown(wait=False, cancel_futures=True)
            if updates:
                with _connection() as db:
                    _save_lotes(db, updates)
                    db.commit()
            _apply_lotes(rows, cache)
        timings["tributos"] = round(time.monotonic() - started - timings["relatorio"] - timings["comparacao"], 1)

        _update(phase="salvar", percent=92, message="Salvando a conferência e os totais...")
        stats = store_run(_connection, run_id, rows, groups)
        timings["total"] = round(time.monotonic() - started, 1)
        with _connection() as db:
            db.execute(
                "UPDATE notas_runs SET status = 'done', finished_at = ?, total_titulos = ?, total_notas = ?, "
                "grupos = ?, confirmadas = ?, provaveis = ?, suspeitas = ?, valor_risco = ?, valor_total = ?, "
                "impostos = ?, multas = ?, acrescimos = ?, tarifas = ?, timings = ?, error = '' WHERE id = ?",
                (
                    _stamp(), stats["totalTitulos"], stats["totalNotas"], stats["grupos"],
                    stats["confirmadas"], stats["provaveis"], stats["suspeitas"], stats["valorRisco"],
                    stats["valorTotal"], stats["impostos"], stats["multas"], stats["acrescimos"],
                    stats["tarifas"], json.dumps(timings), run_id,
                ),
            )
            db.commit()
        _update(
            running=False, phase="fim", percent=100, finishedAt=_stamp(), timings=timings,
            message=(
                f"Conferência concluída: {stats['grupos']} grupo(s) de duplicidade em "
                f"{stats['totalTitulos']} título(s) conferido(s)."
            ),
        )
    except Exception as exc:
        message = str(exc) or "Falha inesperada na conferência das notas."
        timings["total"] = round(time.monotonic() - started, 1)
        try:
            with _connection() as db:
                db.execute(
                    "UPDATE notas_runs SET status = 'error', finished_at = ?, error = ?, timings = ? WHERE id = ?",
                    (_stamp(), message, json.dumps(timings), run_id),
                )
                db.commit()
        finally:
            _update(running=False, phase="erro", error=message, message=message, finishedAt=_stamp())


# ── Leitura dos tributos por lote ───────────────────────────────────────────
def parse_lote(page):
    parser = s4e._NFSeRowsParser()
    parser.feed(page)
    header = None
    tributos = {}
    for cells in parser.rows:
        texts = [cell["text"].strip() for cell in cells]
        if "Mensalidade" in texts and "Cliente" in texts and "COFINS" in texts:
            header = {name: index for index, name in enumerate(texts)}
            continue
        if not header or len(cells) != len(header):
            continue
        def value(name):
            index = header.get(name)
            return s4e._money(texts[index]) if index is not None and index < len(texts) else 0.0
        parcela = _digits(texts[header["Mensalidade"]]) if "Mensalidade" in header else ""
        if not parcela:
            continue
        item = {
            "nf": _nf(texts[header["NF"]]) if "NF" in header else "",
            "fatura": value("FATURA"),
            "refImp": value("REF IMP"),
            "plano": value("Plano"),
            "orto": value("Orto"),
        }
        for key, label, retention in TRIBUTO_FIELDS:
            item[key] = value(label)
            item[key + "Ret"] = value(retention)
        tributos[parcela] = item
    return {"tributos": tributos, "links": _lote_links(parser, header)}


def _lote_links(parser, header):
    if not header or "Cliente" not in header or "NF" not in header:
        return []
    links = []
    for cells in parser.rows:
        if len(cells) != len(header):
            continue
        texts = [cell["text"].strip() for cell in cells]
        code = re.match(r"^\s*([0-9]+)\s*-", texts[header["Cliente"]])
        nf = _nf(texts[header["NF"]])
        if not code or not nf:
            continue
        for index in (header["NF"], header.get("Mensalidade")):
            if index is None:
                continue
            for href in cells[index]["links"]:
                url = s4e._public_nf_url(href)
                if url:
                    links.append([code.group(1), nf, url])
    return links


def _fetch_lote(session, lote):
    raw, headers = session.get(f"/SYS/NFSe/Lote.aspx?ID={lote}&Modal=1", timeout=LOT_TIMEOUT)
    page = s4e._decode(raw, headers)
    if s4e._looks_logged_out(page):
        raise s4e.ConnectorError("A sessão do S4E expirou durante a conferência das notas.")
    return parse_lote(page)


def _load_lotes(lots):
    cache = {}
    if not lots:
        return cache
    with _connection() as db:
        rows = db.execute(
            f"SELECT lote, payload, fetched_at FROM notas_lotes WHERE lote IN ({','.join('?' for _ in lots)})",
            tuple(lots),
        ).fetchall()
    for row in rows:
        try:
            payload = json.loads(row["payload"] or "{}")
        except (TypeError, ValueError):
            continue
        if not isinstance(payload, dict):
            continue
        empty = not payload.get("tributos") and not payload.get("links")
        if empty and not _recent(row["fetched_at"], hours=LOTE_EMPTY_TTL_HOURS):
            continue
        if not empty and not _recent(row["fetched_at"], days=LOTE_TTL_DAYS):
            continue
        cache[str(row["lote"])] = payload
    return cache


def _recent(value, days=0, hours=0):
    try:
        moment = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return False
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - moment).total_seconds() < days * 86400 + hours * 3600


def _save_lotes(db, updates):
    for lot, payload in updates.items():
        db.execute(
            "INSERT INTO notas_lotes(lote, payload, fetched_at) VALUES (?, ?, ?) "
            "ON CONFLICT(lote) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at",
            (lot, json.dumps(payload, ensure_ascii=False), _stamp()),
        )


def _apply_lotes(rows, cache):
    by_parcela, by_link = {}, {}
    for payload in cache.values():
        for parcela, detail in (payload.get("tributos") or {}).items():
            by_parcela.setdefault(parcela, detail)
        for code, number, url in payload.get("links") or []:
            by_link.setdefault((code, number), url)
    for row in rows:
        row["tributos"] = None
        row["nfUrl"] = ""
        payload = cache.get(_lot(row)) or {}
        parcela = _digits(row.get("parcela"))
        nf = _nf(row.get("nf"))
        detail = (payload.get("tributos") or {}).get(parcela)
        if not detail and nf:
            detail = next(
                (item for item in (payload.get("tributos") or {}).values() if item.get("nf") == nf),
                None,
            )
        row["tributos"] = detail or by_parcela.get(parcela)
        if nf:
            code = str(row.get("cdAssociado") or "")
            row["nfUrl"] = by_link.get((code, nf)) or next(
                (url for item_code, number, url in payload.get("links") or []
                 if number == nf and item_code == code),
                "",
            )


# ── Regras de duplicidade ───────────────────────────────────────────────────
def _norm(value):
    text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode().upper()
    text = re.sub(r"[^A-Z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _digits(value):
    return re.sub(r"\D", "", str(value or ""))


def _lot(row):
    return _digits(row.get("nfLote") or row.get("lote"))


def _nf(value):
    text = str(value or "").strip()
    return str(int(text)) if text.isdigit() and int(text) > 0 else ""


def _iso(value):
    match = re.match(r"^(\d{2})/(\d{2})/(\d{4})$", str(value or "").strip())
    return f"{match.group(3)}-{match.group(2)}-{match.group(1)}" if match else ""


def _charge_key(row):
    return "|".join((
        _digits(row.get("documento")),
        _norm(row.get("competencia")),
        str(row.get("tipoParcela") or ""),
        f"{float(row.get('valor') or 0):.2f}",
    ))


def _paid(row):
    return float(row.get("valorRecebido") or 0) > 0 and bool(row.get("dataPagamento"))


def build_groups(rows):
    parent = list(range(len(rows)))

    def find(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(indexes):
        root = find(indexes[0])
        for index in indexes[1:]:
            other = find(index)
            if other != root:
                parent[other] = root
                root = find(root)

    by_nf, by_charge, by_parcela = {}, {}, {}
    for index, row in enumerate(rows):
        if float(row.get("valor") or 0) <= 0:
            continue
        nf = _nf(row.get("nf"))
        if nf:
            by_nf.setdefault(nf, []).append(index)
        by_charge.setdefault(_charge_key(row), []).append(index)
        parcela = _digits(row.get("parcela"))
        if parcela:
            by_parcela.setdefault(parcela, []).append(index)

    repeated_nf = {key: indexes for key, indexes in by_nf.items() if len(indexes) > 1}
    repeated_charge = {key: indexes for key, indexes in by_charge.items() if len(indexes) > 1}
    repeated_parcela = {}
    for parcela, indexes in by_parcela.items():
        lots = {_lot(rows[index]) for index in indexes if _lot(rows[index])}
        if len(lots) > 1:
            repeated_parcela[parcela] = indexes

    for indexes in repeated_nf.values():
        union(indexes)
    for indexes in repeated_charge.values():
        union(indexes)
    for indexes in repeated_parcela.values():
        union(indexes)

    buckets = {}
    for index in range(len(rows)):
        buckets.setdefault(find(index), []).append(index)
    groups = []
    for members in buckets.values():
        if len(members) < 2:
            continue
        groups.append(_make_group(rows, members, repeated_nf, repeated_charge, repeated_parcela))
    groups.sort(key=lambda group: (group["ordem"], -group["valorRisco"], group["empresa"].casefold()))
    for number, group in enumerate(groups, start=1):
        group["id"] = f"G{number:03d}"
    return groups


def _make_group(rows, members, repeated_nf, repeated_charge, repeated_parcela):
    member_set = set(members)
    motivos = []
    confirmed = False
    for nf, indexes in repeated_nf.items():
        found = [index for index in indexes if index in member_set]
        if len(found) < 2:
            continue
        confirmed = True
        emissions = {_iso(rows[index].get("emissao")) for index in found}
        extra = " (datas de emissão diferentes)" if len(emissions) > 1 else ""
        motivos.append(f"A nota fiscal {nf} aparece em {len(found)} títulos{extra}.")
    for parcela, indexes in repeated_parcela.items():
        found = [index for index in indexes if index in member_set]
        if len(found) < 2:
            continue
        confirmed = True
        lots = sorted({_lot(rows[index]) for index in found if _lot(rows[index])})
        motivos.append(f"A parcela {parcela} aparece em {len(lots)} lotes: {', '.join(lots)}.")
    for indexes in repeated_charge.values():
        found = [index for index in indexes if index in member_set]
        if len(found) < 2:
            continue
        notes = sorted({_nf(rows[index].get("nf")) for index in found if _nf(rows[index].get("nf"))})
        if len(notes) > 1:
            motivos.append(
                f"Mesma cobrança (CNPJ, competência e valor) emitida em {len(notes)} notas: {', '.join(notes)}."
            )
        else:
            motivos.append(f"Mesma cobrança (CNPJ, competência e valor) em {len(found)} títulos.")
    all_paid = all(_paid(rows[index]) for index in members)
    if all_paid:
        motivos.append("Todos os títulos do grupo têm pagamento registrado: pode ter havido cobrança em duplicidade.")
    correct, justification = _choose_correct(rows, members)
    classification = "confirmada" if confirmed else ("provavel" if correct is not None or all_paid else "suspeita")
    valor_risco = round(sum(float(rows[index].get("valor") or 0) for index in members if index != correct), 2)
    if correct is None and len(members) > 1:
        valor_risco = round(sum(float(rows[index].get("valor") or 0) for index in members), 2)
    empresas = [rows[index].get("empresa") or rows[index].get("cliente") or "" for index in members]
    documentos = [rows[index].get("documento") or "" for index in members]
    competencias = [rows[index].get("competencia") or "" for index in members]
    tipos = {rows[index].get("tipoParcela") or "" for index in members}
    valores = {float(rows[index].get("valor") or 0) for index in members}
    return {
        "id": "",
        "classificacao": classification,
        "rotulo": CLASSIFICATIONS[classification],
        "empresa": next((name for name in empresas if name), ""),
        "documento": next((doc for doc in documentos if doc), ""),
        "competencia": max(set(competencias), key=competencias.count) if competencias else "",
        "tipoParcela": next(iter(tipos)) if len(tipos) == 1 else "Vários",
        "valor": max(valores) if valores else 0.0,
        "valorRisco": valor_risco,
        "correta": rows[correct].get("parcela") if correct is not None else "",
        "justificativa": justification,
        "motivos": motivos,
        "ordem": {"confirmada": 0, "provavel": 1, "suspeita": 2}[classification],
        "rows": [rows[index] for index in sorted(members, key=lambda index: (
            not _paid(rows[index]), _iso(rows[index].get("emissao")) or "9999", _digits(rows[index].get("parcela"))
        ))],
        "indices": members,
        "correctIndex": correct,
    }


def _choose_correct(rows, members):
    paid = [index for index in members if _paid(rows[index])]
    if len(paid) == len(members):
        return None, "Todos os títulos têm pagamento registrado. Confira com a contabilidade antes de cancelar qualquer nota."
    emissions = sorted(filter(None, (_iso(rows[index].get("emissao")) for index in members)))
    earliest = emissions[0] if emissions else ""
    scored = []
    for index in members:
        row = rows[index]
        score = 0
        reasons = []
        if _paid(row):
            score += 30
            reasons.append("tem pagamento registrado")
        if _nf(row.get("nf")):
            score += 20
        if _lot(row):
            score += 5
        if str(row.get("situacao") or "").upper().startswith("CANCEL"):
            score -= 40
            reasons.append("está cancelado")
        emission = _iso(row.get("emissao"))
        if emission and emission == earliest and len(emissions) > 1:
            score += 3
            reasons.append("nota emitida primeiro")
        scored.append((score, index, reasons))
    scored.sort(key=lambda item: (-item[0], item[1]))
    if len(scored) > 1 and scored[0][0] == scored[1][0]:
        return None, "Os títulos estão empatados nos critérios de conferência. Avalie manualmente antes de cancelar."
    if scored[0][0] <= 0:
        return None, "Nenhum título tem pagamento ou nota emitida que permita indicar a versão correta."
    best = scored[0]
    reason = ", ".join(best[2]) or "reúne os indícios de emissão"
    return best[1], f"Provável correta: {reason}. Confirme o cancelamento da outra nota no S4E antes de executar."


def annotate(rows, groups):
    for row in rows:
        if not row.get("empresa"):
            row["empresa"] = row.get("cliente") or ""
        row["grupo"] = ""
        row["classificacao"] = ""
        row["papel"] = ""
        row["justificativa"] = ""
        row["motivos"] = []
        row.setdefault("tributos", None)
        row.setdefault("nfUrl", "")
    for group in groups:
        for index in group["indices"]:
            row = rows[index]
            row["grupo"] = group["id"]
            row["classificacao"] = group["classificacao"]
            row["papel"] = (
                "correta" if index == group["correctIndex"]
                else "duplicada" if group["classificacao"] in ("confirmada", "provavel")
                else "revisar"
            )
            row["justificativa"] = group["justificativa"]
            row["motivos"] = group["motivos"]


# ── Persistência ────────────────────────────────────────────────────────────
def store_run(connection, run_id, rows, groups):
    total_notas = len({_nf(row.get("nf")) for row in rows if _nf(row.get("nf"))})
    stats = {
        "totalTitulos": len(rows),
        "totalNotas": total_notas,
        "grupos": len(groups),
        "confirmadas": sum(1 for group in groups if group["classificacao"] == "confirmada"),
        "provaveis": sum(1 for group in groups if group["classificacao"] == "provavel"),
        "suspeitas": sum(1 for group in groups if group["classificacao"] == "suspeita"),
        "valorRisco": round(sum(group["valorRisco"] for group in groups), 2),
        "valorTotal": round(sum(float(row.get("valor") or 0) for row in rows), 2),
        "impostos": round(sum(float(row.get("imposto") or 0) for row in rows), 2),
        "multas": round(sum(float(row.get("multa") or 0) for row in rows), 2),
        "acrescimos": round(sum(float(row.get("acrescimo") or 0) + float(row.get("acrescimoAvulso") or 0) for row in rows), 2),
        "tarifas": round(sum(float(row.get("tarifa") or 0) for row in rows), 2),
    }
    with connection() as db:
        db.execute("DELETE FROM notas_rows WHERE run_id = ?", (run_id,))
        db.executemany(
            "INSERT INTO notas_rows(id, run_id, grupo, ordem, classificacao, papel, justificativa, motivos, empresa, "
            "documento, grupo_empresa, departamento, competencia, tipo_parcela, vencimento, gerado, emissao, valor, "
            "titulo, imposto, taxa, tarifa, multa, acrescimo, acrescimo_avulso, desconto, desconto_pagamento, "
            "valor_pago, data_pagamento, parcela, lote, nf, situacao, vidas, nf_url, tributos) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    f"{run_id}:{ordem}", run_id, row.get("grupo") or "", ordem, row.get("classificacao") or "",
                    row.get("papel") or "", row.get("justificativa") or "",
                    json.dumps(row.get("motivos") or [], ensure_ascii=False), row.get("empresa") or "",
                    row.get("documento") or "", row.get("grupo") or "", row.get("departamento") or "",
                    row.get("competencia") or "", row.get("tipoParcela") or "", row.get("vencimento") or "",
                    row.get("gerado") or "", row.get("emissao") or "", float(row.get("valor") or 0),
                    float(row.get("titulo") or 0), float(row.get("imposto") or 0), float(row.get("taxa") or 0),
                    float(row.get("tarifa") or 0), float(row.get("multa") or 0), float(row.get("acrescimo") or 0),
                    float(row.get("acrescimoAvulso") or 0), float(row.get("desconto") or 0),
                    float(row.get("descontoPagamento") or 0), float(row.get("valorRecebido") or 0),
                    row.get("dataPagamento") or "", row.get("parcela") or "", row.get("nfLote") or "",
                    _nf(row.get("nf")), row.get("situacao") or "", row.get("vidas") or "",
                    row.get("nfUrl") or "",
                    json.dumps(row.get("tributos"), ensure_ascii=False) if row.get("tributos") else "",
                )
                for ordem, row in enumerate(rows)
            ],
        )
        db.commit()
    return stats


def _run_payload(row):
    if not row:
        return None
    try:
        timings = json.loads(row["timings"] or "{}")
    except (TypeError, ValueError):
        timings = {}
    return {
        "id": row["id"], "inicio": row["inicio"], "fim": row["fim"], "status": row["status"],
        "totalTitulos": row["total_titulos"], "totalNotas": row["total_notas"], "grupos": row["grupos"],
        "confirmadas": row["confirmadas"], "provaveis": row["provaveis"], "suspeitas": row["suspeitas"],
        "valorRisco": row["valor_risco"], "valorTotal": row["valor_total"], "impostos": row["impostos"],
        "multas": row["multas"], "acrescimos": row["acrescimos"], "tarifas": row["tarifas"],
        "startedAt": row["started_at"], "finishedAt": row["finished_at"], "createdBy": row["created_by"],
        "error": row["error"], "timings": timings if isinstance(timings, dict) else {},
    }


def _row_payload(row):
    def decode(value, fallback):
        try:
            return json.loads(value) if value else fallback
        except (TypeError, ValueError):
            return fallback
    return {
        "id": row["id"], "grupo": row["grupo"], "classificacao": row["classificacao"], "papel": row["papel"],
        "justificativa": row["justificativa"], "motivos": decode(row["motivos"], []),
        "empresa": row["empresa"], "documento": row["documento"], "grupoEmpresa": row["grupo_empresa"],
        "departamento": row["departamento"], "competencia": row["competencia"], "tipoParcela": row["tipo_parcela"],
        "vencimento": row["vencimento"], "gerado": row["gerado"], "emissao": row["emissao"],
        "valor": row["valor"], "titulo": row["titulo"], "imposto": row["imposto"], "taxa": row["taxa"],
        "tarifa": row["tarifa"], "multa": row["multa"], "acrescimo": row["acrescimo"],
        "acrescimoAvulso": row["acrescimo_avulso"], "desconto": row["desconto"],
        "descontoPagamento": row["desconto_pagamento"], "valorPago": row["valor_pago"],
        "dataPagamento": row["data_pagamento"], "parcela": row["parcela"], "lote": row["lote"],
        "nf": row["nf"], "situacao": row["situacao"], "vidas": row["vidas"], "nfUrl": row["nf_url"],
        "tributos": decode(row["tributos"], None),
    }


def overview(db, run_id=""):
    run = None
    if run_id:
        run = db.execute("SELECT * FROM notas_runs WHERE id = ?", (run_id,)).fetchone()
    if not run:
        run = db.execute(
            "SELECT * FROM notas_runs WHERE status IN ('done', 'running') ORDER BY started_at DESC LIMIT 1"
        ).fetchone()
    if not run:
        run = db.execute("SELECT * FROM notas_runs ORDER BY started_at DESC LIMIT 1").fetchone()
    payload = {"run": _run_payload(run), "job": job_status(), "grupos": [], "resumo": {}}
    if not run:
        return payload
    rows = db.execute(
        "SELECT * FROM notas_rows WHERE run_id = ? ORDER BY grupo = '' , grupo, ordem", (run["id"],)
    ).fetchall()
    groups = {}
    for row in rows:
        item = _row_payload(row)
        if item["grupo"]:
            group = groups.setdefault(item["grupo"], {
                "id": item["grupo"], "classificacao": item["classificacao"],
                "rotulo": CLASSIFICATIONS.get(item["classificacao"], ""),
                "empresa": item["empresa"], "documento": item["documento"], "competencia": item["competencia"],
                "tipoParcela": item["tipoParcela"], "valor": item["valor"],
                "justificativa": item["justificativa"], "motivos": item["motivos"], "itens": [],
            })
            group["itens"].append(item)
            group["valor"] = max(group["valor"], item["valor"])
    for group in groups.values():
        group["valorRisco"] = round(sum(
            item["valor"] for item in group["itens"] if item["papel"] != "correta"
        ), 2) if any(item["papel"] == "correta" for item in group["itens"]) else round(
            sum(item["valor"] for item in group["itens"]), 2
        )
    payload["grupos"] = sorted(
        groups.values(),
        key=lambda group: ({"confirmada": 0, "provavel": 1, "suspeita": 2}.get(group["classificacao"], 3),
                           -group["valorRisco"], group["empresa"].casefold()),
    )
    payload["resumo"] = {
        "totalTitulos": run["total_titulos"], "totalNotas": run["total_notas"], "grupos": run["grupos"],
        "confirmadas": run["confirmadas"], "provaveis": run["provaveis"], "suspeitas": run["suspeitas"],
        "valorRisco": run["valor_risco"], "valorTotal": run["valor_total"], "impostos": run["impostos"],
        "multas": run["multas"], "acrescimos": run["acrescimos"], "tarifas": run["tarifas"],
    }
    return payload


def runs(db, limit=12):
    return [
        _run_payload(row) for row in db.execute(
            "SELECT * FROM notas_runs ORDER BY started_at DESC LIMIT ?", (limit,)
        )
    ]


# ── Exportação ──────────────────────────────────────────────────────────────
def _money(value):
    return xlsx.Money(round(float(value or 0), 2))


def _tributos_columns(item):
    detail = item.get("tributos") or {}
    columns = []
    for key, _label, _retention in TRIBUTO_FIELDS:
        columns.append(_money(detail.get(key)))
    columns.append(_money(sum(float(detail.get(key + "Ret") or 0) for key, _l, _r in TRIBUTO_FIELDS)))
    columns.append(_money(sum(float(detail.get(key) or 0) for key, _l, _r in TRIBUTO_FIELDS)))
    return columns


def _export_row(item):
    return [
        item["grupo"], CLASSIFICATIONS.get(item["classificacao"], item["classificacao"]), item["papel"],
        item["empresa"], item["documento"], item["grupoEmpresa"], item["departamento"],
        item["competencia"], item["tipoParcela"], item["vencimento"], item["gerado"],
        item["parcela"], item["nf"], item["lote"], item["emissao"], item["situacao"],
        _money(item["valor"]), _money(item["titulo"]), _money(item["imposto"]), _money(item["taxa"]),
        _money(item["tarifa"]), _money(item["multa"]), _money(item["acrescimo"]),
        _money(item["acrescimoAvulso"]), _money(item["desconto"]), _money(item["descontoPagamento"]),
        _money(item["valorPago"]), item["dataPagamento"], item["vidas"],
        *_tributos_columns(item), item["nfUrl"],
        " | ".join(item.get("motivos") or []), item.get("justificativa") or "",
    ]


EXPORT_HEADER = [
    "Grupo", "Classificação", "Papel", "Empresa", "CNPJ", "Grupo empresa", "Departamento",
    "Competência", "Tipo parcela", "Vencimento", "Gerado em", "Parcela", "NF", "Lote NF",
    "Emissão NF", "Situação", "Valor", "Título (líquido)", "Imposto (relatório)", "Taxa",
    "Tarifa", "Multa", "Acréscimo", "Acréscimo avulso", "Desconto", "Desconto pagamento",
    "Valor pago", "Data pagamento", "Vidas",
    "COFINS", "CSLL", "INSS", "IR", "ISS", "PIS", "Retenções", "Tributos lote",
    "Link NF", "Motivos", "Justificativa",
]


def export_xlsx(db, run_id):
    run = db.execute("SELECT * FROM notas_runs WHERE id = ?", (run_id,)).fetchone()
    if not run:
        raise ValueError("Conferência não encontrada.")
    rows = [_row_payload(row) for row in db.execute(
        "SELECT * FROM notas_rows WHERE run_id = ? ORDER BY grupo = '', grupo, ordem", (run_id,)
    )]
    grouped = [item for item in rows if item["grupo"]]
    summary = [
        ["Conferência de notas fiscais — S4E"],
        ["Período", f"{run['inicio']} a {run['fim']}"],
        ["Executada em", run["finished_at"] or run["started_at"]],
        ["Responsável", run["created_by"]],
        ["Títulos conferidos", run["total_titulos"]],
        ["Notas fiscais distintas", run["total_notas"]],
        ["Grupos com duplicidade", run["grupos"]],
        ["Duplicidades confirmadas", run["confirmadas"]],
        ["Prováveis duplicidades", run["provaveis"]],
        ["Suspeitas sem nota", run["suspeitas"]],
        ["Valor sob revisão", _money(run["valor_risco"])],
        ["Valor total dos títulos", _money(run["valor_total"])],
        ["Impostos (relatório)", _money(run["impostos"])],
        ["Multas", _money(run["multas"])],
        ["Acréscimos", _money(run["acrescimos"])],
        ["Tarifas", _money(run["tarifas"])],
        [],
        ["Regras aplicadas"],
        ["1", "Mesma nota fiscal (NF) em mais de um título."],
        ["2", "Mesma parcela em lotes de nota diferentes."],
        ["3", "Mesmo CNPJ, competência, tipo de parcela e valor em mais de um título."],
        ["4", "Mesma cobrança emitida em mais de uma nota fiscal."],
        ["Como ler", "Papel 'correta' é uma indicação provável; o cancelamento deve ser confirmado no S4E."],
        ["Somente leitura", "A conferência não altera, cancela nem emite nota fiscal."],
    ]
    sheets = [
        ("Resumo", summary),
        ("Duplicidades", [EXPORT_HEADER, *[_export_row(item) for item in grouped]]),
        ("Todos os títulos", [EXPORT_HEADER, *[_export_row(item) for item in rows]]),
    ]
    body = xlsx.build(sheets)
    filename = f"conferencia_notas_{run['inicio']}_a_{run['fim']}.xlsx"
    return body, filename
