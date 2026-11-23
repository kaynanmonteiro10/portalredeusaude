import json
import re
import threading
import unicodedata
import uuid
from datetime import date, datetime, timedelta, timezone

import s4e_connector as s4e
import xlsx_simple as xlsx

UNKNOWN = "Sem centro de custo"
UNKNOWN_GROUP = "Sem grupo"
UNKNOWN_TEAM = "Sem equipe"
UNKNOWN_REASON = "Motivo não informado"

_MONTHS = {
    "janeiro": 1, "fevereiro": 2, "marco": 3, "abril": 4, "maio": 5, "junho": 6,
    "julho": 7, "agosto": 8, "setembro": 9, "outubro": 10, "novembro": 11, "dezembro": 12,
}

SCOPE_LABELS = {"all": "Ativas e canceladas", "ATIVO": "Ativas", "CANCELADO": "Canceladas"}

_lock = threading.Lock()
_job = {"running": False, "start": "", "end": "", "escopo": "", "message": "", "done": 0, "total": 0,
        "error": "", "startedAt": None, "finishedAt": None}
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


def start_sync(start, end, escopo="all", usuario=""):
    if escopo not in SCOPE_LABELS:
        raise ValueError("Escolha uma situação válida para a consulta.")
    if _busy():
        raise s4e.ConnectorError("Aguarde outra consulta ou apuração terminar antes de buscar as pessoas no S4E.")
    with _lock:
        if _job["running"]:
            raise s4e.ConnectorError("Já existe uma consulta de pessoas em andamento. Aguarde a conclusão.")
        _job.update(running=True, start=start.isoformat(), end=end.isoformat(), escopo=escopo,
                    message="Abrindo uma sessão de consulta de usuários no S4E...",
                    done=0, total=0, error="", startedAt=_stamp(), finishedAt=None)
    try:
        threading.Thread(target=_worker, args=(start, end, escopo, usuario), name="s4e-usuarios", daemon=True).start()
    except Exception:
        _update(running=False, finishedAt=_stamp())
        raise


def _worker(start, end, escopo, usuario):
    try:
        import s4e_usuarios

        session = s4e_usuarios.open_session(_credentials())
        parsed = s4e_usuarios.fetch_users(
            session, start, end, escopo, lambda message, done, total: _update(message=message, done=done, total=total))
        arquivo = f"S4E · {start:%d/%m/%Y} a {end:%d/%m/%Y} · {SCOPE_LABELS[escopo]}"
        with _connection() as db:
            store_relatorio(db, parsed, arquivo, usuario, origem="s4e",
                            inicio=start.isoformat(), fim=end.isoformat(), escopo=escopo)
        _update(message=f"Consulta concluída: {len(parsed['rows'])} pessoa(s) — {parsed['ativos']} ativa(s) e "
                        f"{parsed['cancelados']} cancelada(s).", error="")
    except Exception as exc:
        _update(error=str(exc), message="A consulta não foi concluída. A lista anterior foi preservada.")
    finally:
        _update(running=False, finishedAt=_stamp())


def _norm(value):
    text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode().upper()
    text = re.sub(r"[^A-Z0-9 ]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _split_company(value):
    match = re.match(r"^\s*(\d+)\s*-\s*(.+?)\s*$", str(value or ""))
    return (match.group(1), match.group(2)) if match else ("", str(value or "").strip())


def _br_date(value):
    match = re.match(r"^(\d{2})/(\d{2})/(\d{4})$", str(value or "").strip())
    return f"{match.group(3)}-{match.group(2)}-{match.group(1)}" if match else ""


def _date_label(value):
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", str(value or "").strip())
    return f"{match.group(3)}/{match.group(2)}/{match.group(1)}" if match else ""


def _stamp_label(value):
    try:
        return datetime.fromisoformat(str(value)).astimezone().strftime("%d/%m/%Y %H:%M")
    except (TypeError, ValueError):
        return "consulta pendente"


def _money(value):
    text = re.sub(r"[^0-9,.-]", "", str(value or ""))
    if not text:
        return 0.0
    if "," in text:
        text = text.replace(".", "").replace(",", ".")
    try:
        return round(float(text), 2)
    except ValueError:
        return 0.0


def _iso_date(value):
    text = str(value or "").strip()
    if not text:
        return ""
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})", text)
    if match:
        return f"{match.group(1)}-{match.group(2)}-{match.group(3)}"
    match = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})", text)
    if match:
        return f"{match.group(3)}-{int(match.group(2)):02d}-{int(match.group(1)):02d}"
    try:
        serial = float(text)
    except ValueError:
        return ""
    if serial < 20000:
        return ""
    return (date(1899, 12, 30) + timedelta(days=int(serial))).isoformat()


def _client_code(value):
    match = re.match(r"^\s*(\d+)\s*-\s*", str(value or ""))
    return match.group(1) if match else ""


def ensure_schema(db):
    db.execute(
        """CREATE TABLE IF NOT EXISTS vidas_importacoes (
            id TEXT PRIMARY KEY,
            arquivo TEXT NOT NULL,
            aba TEXT NOT NULL DEFAULT '',
            linhas INTEGER NOT NULL DEFAULT 0,
            ativos INTEGER NOT NULL DEFAULT 0,
            cancelados INTEGER NOT NULL DEFAULT 0,
            importado_em TEXT NOT NULL,
            importado_por TEXT NOT NULL DEFAULT '',
            origem TEXT NOT NULL DEFAULT 'arquivo',
            inicio TEXT NOT NULL DEFAULT '',
            fim TEXT NOT NULL DEFAULT '',
            escopo TEXT NOT NULL DEFAULT ''
        )"""
    )
    db.execute(
        """CREATE TABLE IF NOT EXISTS vidas_usuarios (
            id TEXT PRIMARY KEY,
            import_id TEXT NOT NULL,
            arquivo TEXT NOT NULL,
            chave TEXT NOT NULL,
            situacao TEXT NOT NULL DEFAULT '',
            nome TEXT NOT NULL DEFAULT '',
            empresa TEXT NOT NULL DEFAULT '',
            cpf TEXT NOT NULL DEFAULT '',
            contrato TEXT NOT NULL DEFAULT '',
            parentesco TEXT NOT NULL DEFAULT '',
            plano TEXT NOT NULL DEFAULT '',
            centro TEXT NOT NULL DEFAULT '',
            grupo TEXT NOT NULL DEFAULT '',
            valor REAL NOT NULL DEFAULT 0,
            data TEXT NOT NULL DEFAULT '',
            nascimento TEXT NOT NULL DEFAULT '',
            nome_mae TEXT NOT NULL DEFAULT '',
            responsavel TEXT NOT NULL DEFAULT '',
            vencimento TEXT NOT NULL DEFAULT '',
            importado_em TEXT NOT NULL
        )"""
    )
    db.execute("CREATE INDEX IF NOT EXISTS vidas_usuarios_chave ON vidas_usuarios(chave)")
    db.execute("CREATE INDEX IF NOT EXISTS vidas_usuarios_import ON vidas_usuarios(import_id)")
    for table, columns in (
        ("vidas_importacoes", (("origem", "'arquivo'"), ("inicio", "''"), ("fim", "''"), ("escopo", "''"))),
        ("vidas_usuarios", (("centro", "''"), ("grupo", "''"))),
    ):
        existing = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
        for column, default in columns:
            if column not in existing:
                db.execute(f"ALTER TABLE {table} ADD COLUMN {column} TEXT NOT NULL DEFAULT {default}")


def _competencia_order(label):
    parts = _norm(label).split()
    month = _MONTHS.get(parts[0].lower()) if parts else None
    year = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
    return (year, month or 0)


def done_runs(db):
    """Uma apuração concluída por competência, da mais recente para a mais antiga."""
    rows = db.execute(
        "SELECT id, competencia, competencia_label, started_at, finished_at FROM apuracao_runs "
        "WHERE status = 'done' ORDER BY started_at DESC"
    ).fetchall()
    latest = {}
    for row in rows:
        label = row["competencia_label"] or row["competencia"] or ""
        latest.setdefault(_competencia_order(label), dict(row, label=label))
    return [latest[key] for key in sorted(latest, reverse=True)]


def run_companies(db, run_id):
    result = {}
    for row in db.execute(
        "SELECT empresa, grupo_mae, grupo_empresa, vidas FROM apuracao_rows WHERE run_id = ?", (run_id,)
    ):
        code, name = _split_company(row["empresa"])
        key = _norm(name)
        if not key:
            continue
        try:
            lives = int(str(row["vidas"] or "0").strip())
        except ValueError:
            lives = 0
        result[key] = {
            "codigo": code,
            "nome": name,
            "centro": str(row["grupo_mae"] or "").strip(),
            "grupo": str(row["grupo_empresa"] or "").strip(),
            "vidas": lives,
        }
    return result


def attribute(name, index):
    key = _norm(name)
    if not key:
        return None
    if key in index:
        return key
    if len(key) < 8 or " " not in key:
        return None
    candidates = [other for other in index if other.startswith(key + " ") or key.startswith(other + " ")]
    return candidates[0] if len(candidates) == 1 else None


def _snapshot(db, start, end):
    return db.execute(
        "SELECT * FROM vendas_snapshots WHERE start_date = ? AND end_date = ? ORDER BY id DESC LIMIT 1",
        (start.isoformat(), end.isoformat()),
    ).fetchone()


def _movements(payload, index, start, end):
    movements = []
    for row in payload.get("rows", []):
        cancelled = row.get("kind") == "cancelled"
        day = _br_date(row.get("cancelledAt") if cancelled else row.get("registeredAt"))
        if not day or day < start.isoformat() or day > end.isoformat():
            continue
        name = str(row.get("company") or "").strip()
        key = attribute(name, index)
        info = index.get(key) if key else None
        movements.append({
            "tipo": "saida" if cancelled else "entrada",
            "dia": day,
            "cliente": str(row.get("client") or "").strip(),
            "codigoCliente": _client_code(row.get("responsible")),
            "empresa": info["nome"] if info else (name or "Empresa não informada"),
            "codigoEmpresa": info["codigo"] if info else _split_company(name)[0],
            "chave": key or _norm(name) or "SEM EMPRESA",
            "centro": (info["centro"] or UNKNOWN) if info else UNKNOWN,
            "grupo": info["grupo"] if info else "",
            "atribuida": bool(info),
            "vendedor": str(row.get("seller") or "").strip(),
            "equipe": str(row.get("team") or "").strip(),
            "motivo": str(row.get("reason") or "").strip(),
            "plano": str(row.get("plan") or "").strip(),
            "valor": str(row.get("value") or "").strip(),
            "valorNum": _money(row.get("value")),
            "lote": str(row.get("batch") or "").strip(),
            "cadastro": _br_date(row.get("registeredAt")),
            "assinatura": _br_date(row.get("signatureDate")),
        })
    return movements


def _context(db, start, end):
    runs = done_runs(db)
    current = runs[0] if runs else None
    previous = runs[1] if len(runs) > 1 else None
    now = run_companies(db, current["id"]) if current else {}
    before = run_companies(db, previous["id"]) if previous else {}
    index = {**before, **now}
    snapshot = _snapshot(db, start, end)
    all_movements = _movements(json.loads(snapshot["payload"]), index, start, end) if snapshot else []
    return {
        "current": current, "previous": previous, "now": now, "before": before,
        "index": index, "snapshot": snapshot, "all_movements": all_movements,
    }


def _scoped(info, centro, grupo):
    return (not centro or (info["centro"] or UNKNOWN) == centro) and (not grupo or info["grupo"] == grupo)


def _filter(movements, centro, grupo):
    return [item for item in movements if _scoped(item, centro, grupo)]


def _overview(ctx, start, end, centro="", grupo=""):
    current, previous = ctx["current"], ctx["previous"]
    now, before, index = ctx["now"], ctx["before"], ctx["index"]
    all_movements = ctx["all_movements"]
    snapshot = ctx["snapshot"]
    movements = _filter(all_movements, centro, grupo)

    empresas = {}
    for item in movements:
        record = empresas.setdefault(item["chave"], {
            "codigo": index.get(item["chave"], {}).get("codigo", ""),
            "nome": item["empresa"], "centro": item["centro"], "grupo": item["grupo"],
            "vidasAntes": before.get(item["chave"], {}).get("vidas", 0),
            "vidasAgora": now.get(item["chave"], {}).get("vidas", 0),
            "entradas": 0, "saidas": 0, "registros": [],
        })
        record["entradas" if item["tipo"] == "entrada" else "saidas"] += 1
        record["registros"].append({
            key: item[key] for key in (
                "tipo", "dia", "cliente", "codigoCliente", "lote", "vendedor", "equipe",
                "motivo", "plano", "valor", "cadastro", "assinatura",
            )
        })
    for key, info in now.items():
        if not _scoped(info, centro, grupo) or key in empresas or not before.get(key):
            continue
        if before[key]["vidas"] != info["vidas"]:
            empresas[key] = {
                "codigo": info["codigo"], "nome": info["nome"], "centro": info["centro"] or UNKNOWN,
                "grupo": info["grupo"], "vidasAntes": before[key]["vidas"], "vidasAgora": info["vidas"],
                "entradas": 0, "saidas": 0, "registros": [],
            }

    empresa_rows = sorted(empresas.values(), key=lambda r: (-(r["entradas"] + r["saidas"]), r["nome"].casefold()))

    daily = {start + timedelta(days=offset): {"entradas": 0, "saidas": 0} for offset in range((end - start).days + 1)}
    for item in movements:
        day = date.fromisoformat(item["dia"])
        if day in daily:
            daily[day]["entradas" if item["tipo"] == "entrada" else "saidas"] += 1
    daily_rows, running = [], 0
    for day in sorted(daily):
        running += daily[day]["entradas"] - daily[day]["saidas"]
        daily_rows.append({
            "dia": day.isoformat(), "entradas": daily[day]["entradas"], "saidas": daily[day]["saidas"],
            "saldo": daily[day]["entradas"] - daily[day]["saidas"], "acumulado": running,
        })

    sellers = {}
    for item in movements:
        name = item["vendedor"] or "Sem vendedor"
        record = sellers.setdefault(name, {"nome": name, "equipe": "", "entradas": 0, "saidas": 0})
        record["equipe"] = record["equipe"] or item["equipe"]
        record["entradas" if item["tipo"] == "entrada" else "saidas"] += 1
    seller_rows = sorted(sellers.values(), key=lambda r: (-r["entradas"], -r["saidas"], r["nome"].casefold()))

    teams = {}
    for item in movements:
        name = item["equipe"] or UNKNOWN_TEAM
        record = teams.setdefault(name, {"nome": name, "entradas": 0, "saidas": 0})
        record["entradas" if item["tipo"] == "entrada" else "saidas"] += 1
    for record in teams.values():
        record["saldo"] = record["entradas"] - record["saidas"]
    team_rows = sorted(teams.values(), key=lambda r: (-(r["entradas"] + r["saidas"]), r["nome"].casefold()))

    reasons = {}
    for item in movements:
        if item["tipo"] != "saida":
            continue
        name = item["motivo"] or UNKNOWN_REASON
        reasons[name] = reasons.get(name, 0) + 1
    reason_rows = sorted(
        ({"nome": name, "saidas": count} for name, count in reasons.items()),
        key=lambda r: (-r["saidas"], r["nome"].casefold()),
    )

    centros = {}
    for info in now.values():
        if _scoped(info, centro, grupo):
            record = centros.setdefault(info["centro"] or UNKNOWN, {"nome": info["centro"] or UNKNOWN, "entradas": 0, "saidas": 0, "vidasAntes": 0, "vidasAgora": 0, "empresas": 0})
            record["vidasAgora"] += info["vidas"]
            record["empresas"] += 1
    for key, info in before.items():
        if _scoped(info, centro, grupo) and (info["centro"] or UNKNOWN) in centros:
            centros[info["centro"] or UNKNOWN]["vidasAntes"] += info["vidas"]
    movement_keys = {}
    for item in movements:
        record = centros.setdefault(item["centro"], {"nome": item["centro"], "entradas": 0, "saidas": 0, "vidasAntes": 0, "vidasAgora": 0, "empresas": 0})
        record["entradas" if item["tipo"] == "entrada" else "saidas"] += 1
        movement_keys.setdefault(("centro", item["centro"]), set()).add(item["chave"])
    for record in centros.values():
        if not record["empresas"]:
            record["empresas"] = len(movement_keys.get(("centro", record["nome"]), ()))
    centro_rows = sorted(centros.values(), key=lambda r: (-(r["entradas"] + r["saidas"]), r["nome"].casefold()))

    grupos = {}
    for info in now.values():
        if _scoped(info, centro, grupo):
            record = grupos.setdefault(info["grupo"] or UNKNOWN_GROUP, {"nome": info["grupo"] or UNKNOWN_GROUP, "entradas": 0, "saidas": 0, "vidasAntes": 0, "vidasAgora": 0, "empresas": 0})
            record["vidasAgora"] += info["vidas"]
            record["empresas"] += 1
    for key, info in before.items():
        if _scoped(info, centro, grupo):
            record = grupos.setdefault(info["grupo"] or UNKNOWN_GROUP, {"nome": info["grupo"] or UNKNOWN_GROUP, "entradas": 0, "saidas": 0, "vidasAntes": 0, "vidasAgora": 0, "empresas": 0})
            record["vidasAntes"] += info["vidas"]
    for item in movements:
        name = item["grupo"] or UNKNOWN_GROUP
        record = grupos.setdefault(name, {"nome": name, "entradas": 0, "saidas": 0, "vidasAntes": 0, "vidasAgora": 0, "empresas": 0})
        record["entradas" if item["tipo"] == "entrada" else "saidas"] += 1
        movement_keys.setdefault(("grupo", name), set()).add(item["chave"])
    for record in grupos.values():
        if not record["empresas"]:
            record["empresas"] = len(movement_keys.get(("grupo", record["nome"]), ()))
    grupo_rows = sorted(grupos.values(), key=lambda r: (-max(r["vidasAntes"], r["vidasAgora"]), r["nome"].casefold()))

    all_centros = sorted({info["centro"] or UNKNOWN for info in index.values()} | ({UNKNOWN} if any(not item["atribuida"] for item in all_movements) else set()), key=str.casefold)
    all_grupos = sorted({info["grupo"] for info in index.values() if info["grupo"]}, key=str.casefold)
    grupos_por_centro = {}
    for info in index.values():
        if info["grupo"]:
            grupos_por_centro.setdefault(info["centro"] or UNKNOWN, set()).add(info["grupo"])
    grupos_por_centro = {name: sorted(values, key=str.casefold) for name, values in grupos_por_centro.items()}

    entradas = sum(1 for item in movements if item["tipo"] == "entrada")
    saidas = sum(1 for item in movements if item["tipo"] == "saida")
    attributed = sum(1 for item in movements if item["atribuida"])
    outside = [key for key in before if key not in now and _scoped(before[key], centro, grupo)]
    vidas_antes = sum(info["vidas"] for info in before.values() if _scoped(info, centro, grupo))
    vidas_agora = sum(info["vidas"] for info in now.values() if _scoped(info, centro, grupo))
    valor_entradas = round(sum(item["valorNum"] for item in movements if item["tipo"] == "entrada"), 2)
    valor_saidas = round(sum(item["valorNum"] for item in movements if item["tipo"] == "saida"), 2)

    return {
        "periodo": {"inicio": start.isoformat(), "fim": end.isoformat()},
        "movimentacao": {
            "consultaId": snapshot["id"] if snapshot else None,
            "consultadoEm": snapshot["checked_at"] if snapshot else "",
            "registros": len(movements),
        },
        "apuracao": {
            "atual": {"id": current["id"], "competencia": current["label"], "concluidaEm": current["finished_at"]} if current else None,
            "anterior": {"id": previous["id"], "competencia": previous["label"], "concluidaEm": previous["finished_at"]} if previous else None,
        },
        "totais": {
            "entradas": entradas, "saidas": saidas, "saldo": entradas - saidas,
            "empresasComMovimento": sum(1 for record in empresa_rows if record["entradas"] or record["saidas"]),
            "vidasAntes": vidas_antes, "vidasAgora": vidas_agora, "variacao": vidas_agora - vidas_antes,
            "empresasFora": len(outside), "vidasFora": sum(before[key]["vidas"] for key in outside),
            "atribuidas": attributed, "naoAtribuidas": len(movements) - attributed,
            "valorEntradas": valor_entradas, "valorSaidas": valor_saidas,
            "ticketMedio": round(valor_entradas / entradas, 2) if entradas else 0,
            "taxaSaida": round(saidas / vidas_antes * 100, 1) if vidas_antes else 0,
        },
        "filtros": {"centro": centro, "grupo": grupo, "centros": all_centros, "grupos": all_grupos, "gruposPorCentro": grupos_por_centro},
        "diario": daily_rows,
        "vendedores": seller_rows,
        "equipes": team_rows,
        "motivos": reason_rows,
        "centros": centro_rows,
        "grupos": grupo_rows,
        "empresas": empresa_rows,
    }


def overview(db, start, end, centro="", grupo=""):
    return _overview(_context(db, start, end), start, end, centro, grupo)


def movements(db, start, end, centro="", grupo=""):
    """Movimentações linha a linha, já com empresa, centro de custo e grupo resolvidos."""
    items = _filter(_context(db, start, end)["all_movements"], centro, grupo)
    return sorted(items, key=lambda item: (item["dia"], item["tipo"], item["cliente"].casefold()))


REPORT_FIELDS = (
    ("nome", ("USUARIO", "NOME DO USUARIO")),
    ("empresa", ("EMPRESA", "EMPRESA ATUAL")),
    ("situacao", ("SITUACAO ATUAL", "SITUACAO")),
    ("valor", ("VALOR", "VALOR MENSAL")),
    ("data", ("DATA", "DATA DE INCLUSAO", "DATA DE CANCELAMENTO")),
    ("nomeMae", ("NOME DA MAE",)),
    ("parentesco", ("PARENTESCO",)),
    ("nascimento", ("DATA DE NASCIMENTO", "NASCIMENTO")),
    ("responsavel", ("NOME RESPONSAVEL", "RESPONSAVEL")),
    ("vencimento", ("VENCIMENTO", "DIA DE VENCIMENTO")),
    ("contrato", ("CONTRATO", "NUMERO DO CONTRATO")),
    ("cpf", ("CPF", "CPF DO USUARIO")),
    ("centro", ("CENTRO DE CUSTO", "CENTRO CUSTO", "GRUPO MAE", "PLANO")),
    ("grupo", ("GRUPO DE FATURAMENTO", "GRUPO")),
)


def _person_key(item):
    document = re.sub(r"\D", "", item.get("cpf") or "")
    if document:
        return f"{document}|{item.get('contrato') or ''}"
    return f"{_norm(item.get('nome'))}|{item.get('contrato') or ''}"


def parse_relatorio(sheets):
    """Lê o relatório 'usuários por período/situação' do S4E (planilha ou grade HTML)."""
    for sheet in sheets:
        name, cells, max_row, max_col = sheet[:4]

        def values(row):
            return [str(cells.get((row, column), "")).strip() for column in range(max_col)]

        mapping, header_index = {}, None
        for index in range(min(max_row, 12)):
            for column, label in enumerate(values(index)):
                key = _norm(label)
                for field, aliases in REPORT_FIELDS:
                    if key in aliases and field not in mapping:
                        mapping[field] = column
            if {"nome", "empresa", "situacao"} <= set(mapping) and ("cpf" in mapping or "contrato" in mapping):
                header_index = index
                break
            mapping = {}
        if header_index is None:
            continue

        items = []
        for index in range(header_index + 1, max_row):
            row = values(index)

            def get(field):
                column = mapping.get(field)
                return row[column] if column is not None and column < len(row) else ""

            item = {
                "nome": get("nome"),
                "empresa": get("empresa"),
                "situacao": get("situacao").upper(),
                "cpf": get("cpf"),
                "contrato": get("contrato"),
                "parentesco": get("parentesco").upper(),
                "centro": get("centro"),
                "grupo": get("grupo"),
                "responsavel": get("responsavel"),
                "nomeMae": get("nomeMae"),
                "vencimento": get("vencimento"),
                "valor": _money(get("valor")),
                "data": _iso_date(get("data")),
                "nascimento": _iso_date(get("nascimento")),
            }
            if not item["nome"] or not (item["cpf"] or item["contrato"]):
                continue
            item["chave"] = _person_key(item)
            items.append(item)
        if not items:
            raise ValueError("A planilha foi lida, mas nenhuma pessoa tem nome e CPF/contrato.")
        ativos = sum(1 for item in items if item["situacao"] == "ATIVO")
        return {"aba": name, "rows": items, "ativos": ativos, "cancelados": len(items) - ativos}
    raise ValueError("Não reconheci o relatório de usuários do S4E.")


def store_relatorio(db, parsed, arquivo, usuario="", origem="arquivo", inicio="", fim="", escopo=""):
    import_id = uuid.uuid4().hex
    stamp = datetime.now().astimezone().isoformat(timespec="seconds")
    if origem == "s4e":
        db.execute("DELETE FROM vidas_usuarios WHERE import_id IN (SELECT id FROM vidas_importacoes WHERE origem = 's4e')")
        db.execute("DELETE FROM vidas_importacoes WHERE origem = 's4e'")
    else:
        db.execute(
            "DELETE FROM vidas_usuarios WHERE import_id IN "
            "(SELECT id FROM vidas_importacoes WHERE origem != 's4e' AND lower(arquivo) = lower(?))", (arquivo,)
        )
        db.execute("DELETE FROM vidas_importacoes WHERE origem != 's4e' AND lower(arquivo) = lower(?)", (arquivo,))
    for item in parsed["rows"]:
        db.execute(
            "INSERT INTO vidas_usuarios (id, import_id, arquivo, chave, situacao, nome, empresa, cpf, contrato, "
            "parentesco, centro, grupo, valor, data, nascimento, nome_mae, responsavel, vencimento, importado_em) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                uuid.uuid4().hex, import_id, arquivo, item["chave"], item["situacao"], item["nome"],
                item["empresa"], item["cpf"], item["contrato"], item["parentesco"], item["centro"],
                item["grupo"], item["valor"], item["data"], item["nascimento"], item["nomeMae"],
                item["responsavel"], item["vencimento"], stamp,
            ),
        )
    db.execute(
        "INSERT INTO vidas_importacoes (id, arquivo, aba, linhas, ativos, cancelados, importado_em, importado_por, "
        "origem, inicio, fim, escopo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (import_id, arquivo, parsed["aba"], len(parsed["rows"]), parsed["ativos"], parsed["cancelados"], stamp,
         usuario, origem, inicio, fim, escopo),
    )
    db.commit()
    return {"id": import_id, "arquivo": arquivo, "linhas": len(parsed["rows"]), "ativos": parsed["ativos"],
            "cancelados": parsed["cancelados"], "importadoEm": stamp, "origem": origem}


def imports(db):
    rows = db.execute(
        "SELECT id, arquivo, aba, linhas, ativos, cancelados, importado_em, importado_por, origem, inicio, fim, escopo "
        "FROM vidas_importacoes ORDER BY importado_em DESC, arquivo COLLATE NOCASE"
    ).fetchall()
    return [
        {
            "id": row["id"], "arquivo": row["arquivo"], "aba": row["aba"], "linhas": row["linhas"],
            "ativos": row["ativos"], "cancelados": row["cancelados"],
            "importadoEm": row["importado_em"], "importadoPor": row["importado_por"],
            "origem": row["origem"], "inicio": row["inicio"], "fim": row["fim"], "escopo": row["escopo"],
        }
        for row in rows
    ]


def remove_import(db, import_id):
    row = db.execute("SELECT id FROM vidas_importacoes WHERE id = ?", (import_id,)).fetchone()
    if not row:
        return False
    db.execute("DELETE FROM vidas_usuarios WHERE import_id = ?", (import_id,))
    db.execute("DELETE FROM vidas_importacoes WHERE id = ?", (import_id,))
    db.commit()
    return True


def _people_records(db, index):
    rows = db.execute(
        "SELECT * FROM vidas_usuarios ORDER BY importado_em DESC, nome COLLATE NOCASE"
    ).fetchall()
    seen, records = set(), []
    for row in rows:
        if row["chave"] in seen:
            continue
        seen.add(row["chave"])
        record = dict(row)
        key = attribute(record["empresa"], index)
        info = index.get(key) if key else None
        apurado = str((info or {}).get("centro") or "").strip()
        reported = str(record.get("centro") or "").strip()
        record["centro"] = apurado or reported or UNKNOWN
        record["grupo"] = str((info or {}).get("grupo") or "").strip() or str(record.get("grupo") or "").strip()
        record["atribuida"] = bool(apurado or reported)
        records.append(record)
    records.sort(key=lambda item: (item["nome"].casefold(), item["contrato"]))
    return records


def _latest_index(db):
    runs = done_runs(db)
    return runs[0] if runs else None, (run_companies(db, runs[0]["id"]) if runs else {})


def people(db, busca="", situacao="", parentesco="", centro="", limite=300):
    current, index = _latest_index(db)
    records = _people_records(db, index)
    term = _norm(busca)
    digits = re.sub(r"\D", "", busca or "")
    scoped = []
    for record in records:
        if situacao and record["situacao"] != situacao:
            continue
        if parentesco and record["parentesco"] != parentesco:
            continue
        if centro and record["centro"] != centro:
            continue
        if term:
            haystack = " ".join(str(record.get(key) or "") for key in ("nome", "cpf", "empresa", "contrato", "responsavel"))
            found = term in _norm(haystack)
            if not found and len(digits) >= 3:
                found = digits in re.sub(r"\D", "", haystack)
            if not found:
                continue
        scoped.append(record)
    try:
        limite = max(50, min(1000, int(limite)))
    except (TypeError, ValueError):
        limite = 300
    return {
        "apuracao": current["label"] if current else "",
        "totais": {
            "pessoas": len(records),
            "ativos": sum(1 for record in records if record["situacao"] == "ATIVO"),
            "cancelados": sum(1 for record in records if record["situacao"] == "CANCELADO"),
            "titulares": sum(1 for record in records if record["parentesco"] == "TITULAR"),
            "dependentes": sum(1 for record in records if record["parentesco"] and record["parentesco"] != "TITULAR"),
            "semCentro": sum(1 for record in records if not record["atribuida"]),
        },
        "filtros": {
            "centros": sorted({record["centro"] for record in records}, key=str.casefold),
            "situacoes": sorted({record["situacao"] for record in records if record["situacao"]}),
            "parentescos": sorted({record["parentesco"] for record in records if record["parentesco"]}),
        },
        "aplicados": {"busca": busca, "situacao": situacao, "parentesco": parentesco, "centro": centro},
        "filtrados": len(scoped),
        "exibidos": min(len(scoped), limite),
        "pessoas": scoped[:limite],
        "importacoes": imports(db),
        "job": job_status(),
    }


def _type_label(item):
    return "Saída" if item["tipo"] == "saida" else "Entrada"


def report(db, start, end, centro="", grupo=""):
    """Planilha .xlsx com o resumo, as movimentações e as agregações da tela."""
    ctx = _context(db, start, end)
    data = _overview(ctx, start, end, centro, grupo)
    items = sorted(_filter(ctx["all_movements"], centro, grupo), key=lambda item: (item["dia"], item["tipo"], item["cliente"].casefold()))
    totais, apuracao = data["totais"], data["apuracao"]
    atual = apuracao["atual"]["competencia"] if apuracao["atual"] else "sem apuração"
    anterior = apuracao["anterior"]["competencia"] if apuracao["anterior"] else "sem competência anterior"

    resumo = [
        ["Indicador", "Valor"],
        ["Período", f"{_date_label(data['periodo']['inicio'])} a {_date_label(data['periodo']['fim'])}"],
        ["Gerado em", datetime.now().strftime("%d/%m/%Y %H:%M")],
        ["Centro de custo", centro or "Todos os centros"],
        ["Grupo", grupo or "Todos os grupos"],
        ["Movimentações lidas do S4E em", _stamp_label(data["movimentacao"]["consultadoEm"])],
        ["Apuração usada", f"{atual} (antes: {anterior})"],
        ["Vidas que entraram", totais["entradas"]],
        ["Vidas que saíram", totais["saidas"]],
        ["Saldo do período", totais["saldo"]],
        ["Empresas com movimento", totais["empresasComMovimento"]],
        ["Vidas faturadas antes", totais["vidasAntes"]],
        ["Vidas faturadas agora", totais["vidasAgora"]],
        ["Variação das vidas faturadas", totais["variacao"]],
        ["Empresas fora da apuração atual", totais["empresasFora"]],
        ["Vidas fora da apuração atual", totais["vidasFora"]],
        ["Taxa de saída sobre as vidas de antes", xlsx.Percent(totais["taxaSaida"])],
        ["Valor mensal das entradas", xlsx.Money(totais["valorEntradas"])],
        ["Valor mensal das saídas", xlsx.Money(totais["valorSaidas"])],
        ["Ticket médio de entrada", xlsx.Money(totais["ticketMedio"])],
        ["Movimentações sem centro de custo identificado", totais["naoAtribuidas"]],
    ]
    people_rows = [
        record for record in _people_records(db, ctx["index"])
        if (not centro or record["centro"] == centro) and (not grupo or record["grupo"] == grupo)
    ]
    resumo.append(["Pessoas no relatório de usuários do S4E", len(people_rows)])
    movimentacoes = [["Dia", "Tipo", "Empresa", "Código da empresa", "Centro de custo", "Grupo",
                      "Cliente (vida)", "Código do cliente no S4E", "Lote", "Vendedor", "Equipe",
                      "Plano", "Valor mensal (R$)", "Motivo", "Cadastro no S4E", "Assinatura"]]
    for item in items:
        movimentacoes.append([
            _date_label(item["dia"]), _type_label(item), item["empresa"], item["codigoEmpresa"],
            item["centro"], item["grupo"] or "—", item["cliente"], item["codigoCliente"], item["lote"],
            item["vendedor"], item["equipe"], item["plano"], xlsx.Money(item["valorNum"]),
            item["motivo"], _date_label(item["cadastro"]), _date_label(item["assinatura"]),
        ])
    empresas = [["Empresa", "Código", "Centro de custo", "Grupo", "Vidas antes", "Vidas agora",
                 "Variação", "Entradas", "Saídas", "Quem trouxe"]]
    for record in data["empresas"]:
        sellers = sorted({item["vendedor"] for item in record["registros"] if item["tipo"] == "entrada" and item["vendedor"]})
        empresas.append([
            record["nome"], record["codigo"], record["centro"], record["grupo"] or "—",
            record["vidasAntes"], record["vidasAgora"], record["vidasAgora"] - record["vidasAntes"],
            record["entradas"], record["saidas"], ", ".join(sellers) or "—",
        ])

    def carteira(rows, title):
        sheet = [[title, "Empresas", "Vidas antes", "Vidas agora", "Variação", "Entradas", "Saídas"]]
        for record in rows:
            sheet.append([
                record["nome"], record["empresas"], record["vidasAntes"], record["vidasAgora"],
                record["vidasAgora"] - record["vidasAntes"], record["entradas"], record["saidas"],
            ])
        return sheet

    pessoas = [["Usuário", "CPF", "Empresa", "Centro de custo", "Grupo", "Situação", "Parentesco",
                "Nascimento", "Nome da mãe", "Responsável", "Contrato", "Valor mensal (R$)",
                "Data", "Vencimento"]]
    for record in people_rows:
        pessoas.append([
            record["nome"], record["cpf"], record["empresa"], record["centro"], record["grupo"] or "—",
            record["situacao"], record["parentesco"], _date_label(record["nascimento"]),
            record["nome_mae"], record["responsavel"], record["contrato"],
            xlsx.Money(record["valor"]), _date_label(record["data"]), record["vencimento"],
        ])

    vendedores = [["Vendedor", "Equipe", "Entradas", "Saídas", "Saldo"]]
    vendedores += [[r["nome"], r["equipe"], r["entradas"], r["saidas"], r["entradas"] - r["saidas"]] for r in data["vendedores"]]
    equipes = [["Equipe", "Entradas", "Saídas", "Saldo"]]
    equipes += [[r["nome"], r["entradas"], r["saidas"], r["saldo"]] for r in data["equipes"]]
    motivos = [["Motivo da saída", "Saídas"]]
    motivos += [[r["nome"], r["saidas"]] for r in data["motivos"]]
    diario = [["Dia", "Entradas", "Saídas", "Saldo", "Acumulado"]]
    diario += [[_date_label(r["dia"]), r["entradas"], r["saidas"], r["saldo"], r["acumulado"]] for r in data["diario"]]

    return xlsx.build([
        ("Resumo", resumo),
        ("Movimentações", movimentacoes),
        ("Empresas", empresas),
        ("Centros de custo", carteira(data["centros"], "Centro de custo")),
        ("Grupos", carteira(data["grupos"], "Grupo")),
        ("Pessoas (vidas)", pessoas),
        ("Vendedores", vendedores),
        ("Equipes", equipes),
        ("Motivos de saída", motivos),
        ("Movimento diário", diario),
    ])
