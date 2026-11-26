"""Ponto eletrônico consultivo baseado nas sessões do Portal do Setor."""

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
import re
import secrets
import unicodedata


TZ = timezone(timedelta(hours=-3))
POLICY_CHANGE = date(2026, 12, 16)


EMPLOYEES = (
    ("juliana", "JULIANA LIMA NUNES", "Financeiro"),
    ("monalisa", "MONALISA DA SILVA MARCELINO", "Financeiro"),
    ("david", "DAVID DA SILVA FLORENCIO", "Suporte - Relacionamento"),
    ("pedro", "PEDRO EMANUEL FRANCO FELIX", "Cadastro Faturamento"),
    ("kaynan", "KAYNAN MONTEIRO DA SILVA", "Cadastro Faturamento"),
    ("camila", "CAMILA RODRIGUES BARBOSA", "Cadastro Faturamento"),
    ("joao", "JOAO CRISTIANO DA SILVA ARAUJO", "T.I"),
    ("tiago", "TIAGO SILVEIRA TAUMATURGO", "T.I"),
    ("rosemary", "ROSEMARY NASCIMENTO LIMA", "Comercial"),
    ("rita", "RITA DE CASSIA MACHADO MELO", "Comercial"),
    ("yanca", "YANCA LEITAO ARAUJO", "Credenciamento"),
    ("simone", "MARIA SIMONE DOS SANTOS LIMA", "Credenciamento"),
)

# start, lunch start, lunch end, end. None means no work planned.
STANDARD_A = (("08:00", "13:00", "14:00", "18:00"), ("08:00", "13:00", "14:00", "18:00"),
              ("08:00", "12:00", "13:00", "18:00"), ("08:00", "12:00", "13:00", "18:00"),
              ("08:00", "12:00", "14:00", "16:00"), None, None)
STANDARD_B = (("08:00", "12:00", "13:00", "18:00"), ("08:00", "12:00", "13:00", "18:00"),
              ("08:00", "12:00", "13:00", "18:00"), ("08:00", "12:00", "14:00", "16:00"),
              ("08:00", "12:00", "13:00", "18:00"), None, None)
SCHEDULES = {
    "juliana": STANDARD_A, "david": STANDARD_A, "pedro": STANDARD_A,
    "joao": STANDARD_A, "rosemary": STANDARD_A, "rita": STANDARD_A,
    "monalisa": STANDARD_B, "kaynan": STANDARD_B, "camila": STANDARD_B, "simone": STANDARD_B,
    "tiago": (("08:00", "12:00", "13:00", "17:00"),) * 3 +
             (("08:00", "12:00", "13:00", "18:00"),) * 2 + (None, None),
    "yanca": (("08:00", "12:00", "13:00", "17:00"),) * 4 +
             (("08:00", None, None, "14:00"), ("08:00", None, None, "12:00"), None),
}

VACATIONS = (
    ("david", "2026-11-30", 21, "2026-12-21", "Simone/Camila/Kaynan", "Vai sair 1 semana antes para voltar 1 semana antes"),
    ("joao", "2026-12-14", 21, "2027-01-04", "Tiago/Cavaleiro", ""),
    ("juliana", "2026-12-14", 10, "2026-12-24", "Monalisa/Rita", "Vai trabalhar 17, 18 e 23/12; descontar das férias"),
    ("kaynan", "2026-12-21", 15, "2027-01-05", "Pedro", ""),
    ("simone", "2026-12-21", 21, "2027-01-04", "David", "Vai trabalhar de 14 a 19/12; descontar das férias"),
    ("monalisa", "2026-12-21", 10, "2026-12-31", "Pedro", ""),
    ("pedro", "2026-12-07", 14, "2026-12-21", "Kaynan/Camila", ""),
    ("rita", "2026-12-21", 14, "2027-01-04", "Pedro/David", ""),
    ("rosemary", "2026-12-09", 30, "2027-01-08", "", ""),
    ("yanca", "2026-12-14", 10, "2027-01-04", "Simone", ""),
)


def _norm(value):
    text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode().lower()
    return " ".join(text.split())


def _minutes(value):
    if not value:
        return 0
    hour, minute = (int(part) for part in value.split(":"))
    return hour * 60 + minute


def _scheduled_minutes(item):
    if not item:
        return 0
    start, lunch_start, lunch_end, end = item
    total = _minutes(end) - _minutes(start)
    if lunch_start and lunch_end:
        total -= _minutes(lunch_end) - _minutes(lunch_start)
    return max(0, total)


def ensure_tables(db):
    db.execute("""CREATE TABLE IF NOT EXISTS point_employees (
        id TEXT PRIMARY KEY, user_id TEXT, name TEXT NOT NULL, team TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1, UNIQUE(name))""")
    db.execute("""CREATE TABLE IF NOT EXISTS point_schedules (
        employee_id TEXT NOT NULL, weekday INTEGER NOT NULL, start_time TEXT, lunch_start TEXT,
        lunch_end TEXT, end_time TEXT, scheduled_minutes INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(employee_id, weekday))""")
    db.execute("""CREATE TABLE IF NOT EXISTS point_vacations (
        id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, start_date TEXT NOT NULL, days INTEGER NOT NULL,
        return_date TEXT NOT NULL, cover TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '')""")
    db.execute("""CREATE TABLE IF NOT EXISTS point_events (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, employee_id TEXT, session_token TEXT NOT NULL DEFAULT '',
        event_type TEXT NOT NULL, occurred_at TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'portal')""")
    db.execute("CREATE INDEX IF NOT EXISTS point_events_user_at ON point_events(user_id, occurred_at)")
    db.execute("""CREATE TABLE IF NOT EXISTS point_policies (
        effective_from TEXT PRIMARY KEY, weekly_minutes INTEGER NOT NULL, label TEXT NOT NULL)""")
    db.executemany(
        "INSERT OR IGNORE INTO point_policies(effective_from, weekly_minutes, label) VALUES (?, ?, ?)",
        (("2000-01-01", 2640, "44 horas semanais"), ("2026-12-16", 2520, "42 horas semanais")),
    )
    if db.execute("SELECT 1 FROM meta WHERE key='point_seed_v1'").fetchone():
        _link_users(db)
        return
    ids = {}
    for key, name, team in EMPLOYEES:
        employee_id = f"point-{key}"
        ids[key] = employee_id
        db.execute("INSERT OR IGNORE INTO point_employees(id, name, team) VALUES (?, ?, ?)", (employee_id, name, team))
        for weekday, item in enumerate(SCHEDULES[key]):
            if item:
                start, lunch_start, lunch_end, end = item
            else:
                start = lunch_start = lunch_end = end = None
            db.execute(
                "INSERT OR IGNORE INTO point_schedules(employee_id, weekday, start_time, lunch_start, lunch_end, end_time, scheduled_minutes) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (employee_id, weekday, start, lunch_start, lunch_end, end, _scheduled_minutes(item)),
            )
    for key, start, days, return_date, cover, note in VACATIONS:
        db.execute(
            "INSERT OR IGNORE INTO point_vacations(id, employee_id, start_date, days, return_date, cover, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (f"vac-{key}-{start}", ids[key], start, days, return_date, cover, note),
        )
    db.execute("INSERT INTO meta(key, value) VALUES ('point_seed_v1', '1')")
    _link_users(db)


def _link_users(db):
    users = db.execute("SELECT id, username, display_name FROM users WHERE active=1").fetchall()
    for employee in db.execute("SELECT id, name FROM point_employees WHERE user_id IS NULL OR user_id='' ").fetchall():
        emp = _norm(employee["name"])
        candidates = []
        for user in users:
            names = (_norm(user["display_name"]), _norm(user["username"]))
            score = max((len(name) for name in names if name and (name in emp or emp.startswith(name))), default=0)
            if score:
                candidates.append((score, user))
        candidates.sort(key=lambda item: item[0], reverse=True)
        if candidates and (len(candidates) == 1 or candidates[0][0] > candidates[1][0]):
            db.execute("UPDATE point_employees SET user_id=? WHERE id=?", (candidates[0][1]["id"], employee["id"]))


def record_event(db, user_id, event_type, token="", source="portal", occurred_at=None):
    ensure_tables(db)
    employee = db.execute("SELECT id FROM point_employees WHERE user_id=?", (user_id,)).fetchone()
    db.execute(
        "INSERT INTO point_events(id, user_id, employee_id, session_token, event_type, occurred_at, source) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (secrets.token_hex(16), user_id, employee["id"] if employee else None, token, event_type,
         occurred_at or datetime.now(timezone.utc).isoformat(), source),
    )


def policy_for(db, day):
    row = db.execute(
        "SELECT * FROM point_policies WHERE effective_from<=? ORDER BY effective_from DESC LIMIT 1", (day.isoformat(),)
    ).fetchone()
    return dict(row) if row else {"effective_from": "2000-01-01", "weekly_minutes": 2640, "label": "44 horas semanais"}


def _local(value):
    dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(TZ)


def _worked_by_day(events, now=None):
    now = now or datetime.now(TZ)
    grouped = defaultdict(list)
    for event in events:
        grouped[_local(event["occurred_at"]).date()].append(event)
    result = {}
    for day, rows in grouped.items():
        rows.sort(key=lambda row: row["occurred_at"])
        starts = [_local(row["occurred_at"]) for row in rows if row["event_type"] == "login"]
        ends = [_local(row["occurred_at"]) for row in rows if row["event_type"] == "logout"]
        if not starts:
            continue
        first = min(starts)
        last = max(ends) if ends else (now if day == now.date() else first)
        pauses = 0
        open_break = None
        for row in rows:
            at = _local(row["occurred_at"])
            if row["event_type"] in ("break_start", "lunch_start"):
                open_break = at
            elif row["event_type"] in ("break_end", "lunch_end") and open_break:
                pauses += max(0, int((at - open_break).total_seconds() // 60))
                open_break = None
        if open_break and day == now.date():
            pauses += max(0, int((now - open_break).total_seconds() // 60))
        result[day.isoformat()] = {
            "date": day.isoformat(), "first": first.isoformat(), "last": last.isoformat(),
            "workedMinutes": max(0, int((last - first).total_seconds() // 60) - pauses),
            "breakMinutes": pauses, "open": not bool(ends),
            "events": [{"type": row["event_type"], "at": _local(row["occurred_at"]).isoformat()} for row in rows],
        }
    return result


def _week_bounds(day):
    start = day - timedelta(days=day.weekday())
    return start, start + timedelta(days=6)


def overview(db, user, start=None, end=None):
    ensure_tables(db)
    now = datetime.now(TZ)
    today = now.date()
    week_start, week_end = _week_bounds(today)
    start_day = date.fromisoformat(start) if start else week_start
    end_day = date.fromisoformat(end) if end else week_end
    admin = user["role"] == "admin" or bool(user["management"] if "management" in user.keys() else False)
    employees = [dict(row) for row in db.execute("SELECT * FROM point_employees WHERE active=1 ORDER BY team, name")]
    if not admin:
        employees = [item for item in employees if item.get("user_id") == user["id"]]
    employee_ids = [item["id"] for item in employees]
    schedules = [dict(row) for row in db.execute("SELECT * FROM point_schedules ORDER BY employee_id, weekday")]
    vacations = [dict(row) for row in db.execute(
        "SELECT v.*, e.name, e.team FROM point_vacations v JOIN point_employees e ON e.id=v.employee_id ORDER BY start_date, e.name"
    )]
    if not admin:
        vacations = [item for item in vacations if item["employee_id"] in employee_ids]
    start_at = datetime.combine(start_day, datetime.min.time(), TZ).astimezone(timezone.utc).isoformat()
    end_at = datetime.combine(end_day + timedelta(days=1), datetime.min.time(), TZ).astimezone(timezone.utc).isoformat()
    params = [start_at, end_at]
    event_rows = [dict(row) for row in db.execute(
        "SELECT * FROM point_events WHERE occurred_at>=? AND occurred_at<? ORDER BY occurred_at", params
    )]
    if not admin:
        event_rows = [row for row in event_rows if row["user_id"] == user["id"]]
    by_user = defaultdict(list)
    for row in event_rows:
        by_user[row["user_id"]].append(row)
    policy = policy_for(db, today)
    people = []
    schedule_map = defaultdict(list)
    for item in schedules:
        schedule_map[item["employee_id"]].append(item)
    for employee in employees:
        days = _worked_by_day(by_user.get(employee.get("user_id"), []), now)
        weekly = sum(item["workedMinutes"] for item in days.values())
        planned = sum(item["scheduled_minutes"] for item in schedule_map[employee["id"]])
        people.append({**employee, "schedule": schedule_map[employee["id"]], "days": list(days.values()),
                       "workedMinutes": weekly, "plannedMinutes": planned,
                       "remainingMinutes": max(0, policy["weekly_minutes"] - weekly),
                       "overtimeMinutes": max(0, weekly - policy["weekly_minutes"])})
    change = policy_for(db, POLICY_CHANGE)
    portal_users = []
    if admin:
        portal_users = [
            {"id": row["id"], "displayName": row["display_name"], "username": row["username"]}
            for row in db.execute("SELECT id, display_name, username FROM users WHERE active=1 ORDER BY display_name")
        ]
    return {
        "today": today.isoformat(), "range": {"start": start_day.isoformat(), "end": end_day.isoformat()},
        "admin": admin, "policy": policy, "nextPolicy": change if today < POLICY_CHANGE else None,
        "people": people, "vacations": vacations, "rotations": rotation_suggestions(db, week_start),
        "portalUsers": portal_users,
    }


def save_employee_schedule(db, employee_id, payload):
    ensure_tables(db)
    employee = db.execute("SELECT * FROM point_employees WHERE id=?", (employee_id,)).fetchone()
    if not employee:
        raise ValueError("Pessoa não encontrada no ponto eletrônico.")
    team = str(payload.get("team") or employee["team"] or "").strip()[:100]
    user_id = str(payload.get("userId") or "").strip() or None
    if user_id:
        if not db.execute("SELECT 1 FROM users WHERE id=? AND active=1", (user_id,)).fetchone():
            raise ValueError("O usuário escolhido não está ativo no portal.")
        linked = db.execute("SELECT name FROM point_employees WHERE user_id=? AND id!=?", (user_id, employee_id)).fetchone()
        if linked:
            raise ValueError(f"Esse usuário já está vinculado a {linked['name']}.")
    rows = payload.get("schedule")
    if not isinstance(rows, list) or len(rows) != 7:
        raise ValueError("Informe os sete dias da escala.")

    def valid_time(value):
        text = str(value or "").strip()
        if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", text):
            raise ValueError("Use horários válidos no formato HH:MM.")
        return text

    normalized = []
    weekly = 0
    for weekday, row in enumerate(rows):
        if not isinstance(row, dict) or not row.get("enabled"):
            normalized.append((weekday, None, None, None, None, 0))
            continue
        start = valid_time(row.get("start"))
        end = valid_time(row.get("end"))
        lunch_start = str(row.get("lunchStart") or "").strip() or None
        lunch_end = str(row.get("lunchEnd") or "").strip() or None
        if bool(lunch_start) != bool(lunch_end):
            raise ValueError("Preencha o início e o fim do almoço, ou deixe os dois vazios.")
        if lunch_start:
            lunch_start, lunch_end = valid_time(lunch_start), valid_time(lunch_end)
            if not (_minutes(start) < _minutes(lunch_start) < _minutes(lunch_end) < _minutes(end)):
                raise ValueError("O almoço precisa ficar dentro do horário de trabalho.")
        elif _minutes(start) >= _minutes(end):
            raise ValueError("A saída precisa ser posterior à entrada.")
        item = (start, lunch_start, lunch_end, end)
        day_minutes = _scheduled_minutes(item)
        if day_minutes <= 0:
            raise ValueError("A jornada diária precisa ter duração positiva.")
        weekly += day_minutes
        normalized.append((weekday, start, lunch_start, lunch_end, end, day_minutes))
    db.execute("UPDATE point_employees SET user_id=?, team=? WHERE id=?", (user_id, team, employee_id))
    for weekday, start, lunch_start, lunch_end, end, day_minutes in normalized:
        db.execute(
            "INSERT INTO point_schedules(employee_id, weekday, start_time, lunch_start, lunch_end, end_time, scheduled_minutes) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(employee_id, weekday) DO UPDATE SET "
            "start_time=excluded.start_time, lunch_start=excluded.lunch_start, lunch_end=excluded.lunch_end, "
            "end_time=excluded.end_time, scheduled_minutes=excluded.scheduled_minutes",
            (employee_id, weekday, start, lunch_start, lunch_end, end, day_minutes),
        )
    policy = policy_for(db, datetime.now(TZ).date())
    return {
        "weeklyMinutes": weekly,
        "limitMinutes": policy["weekly_minutes"],
        "warning": f"A escala ultrapassa o limite vigente em {(weekly - policy['weekly_minutes']) / 60:.1f} hora(s)." if weekly > policy["weekly_minutes"] else "",
    }


def rotation_suggestions(db, week_start):
    ensure_tables(db)
    available = []
    for row in db.execute("SELECT id, name, team FROM point_employees WHERE active=1 ORDER BY team, name"):
        away = db.execute(
            "SELECT 1 FROM point_vacations WHERE employee_id=? AND start_date<=? AND return_date>?",
            (row["id"], (week_start + timedelta(days=6)).isoformat(), week_start.isoformat()),
        ).fetchone()
        if not away:
            available.append(dict(row))
    if not available:
        return []
    week_number = week_start.isocalendar().week
    shifted = available[week_number % len(available):] + available[:week_number % len(available)]
    short_days = ["segunda", "terça", "quarta", "quinta", "sexta"]
    return [
        {"id": "short-day", "title": "Dia curto alternado", "description": "Distribui a saída antecipada entre os dias úteis sem repetir sempre a mesma pessoa.",
         "items": [{"name": item["name"], "value": short_days[index % 5]} for index, item in enumerate(shifted)]},
        {"id": "saturday", "title": "Sábado alternado", "description": "Sugestão de rodízio entre pessoas disponíveis; exige validação da gestão e da cobertura do setor.",
         "items": [{"name": item["name"], "value": "08:00 às 12:00"} for item in shifted[:max(1, min(3, len(shifted)))]]},
        {"id": "coverage", "title": "Cobertura de férias", "description": "Prioriza quem está disponível e ainda não recebeu benefício nesta semana.",
         "items": [{"name": item["name"], "value": item["team"]} for item in reversed(shifted[-min(4, len(shifted)):])]},
    ]


def export_rows(data):
    summary = [["Pessoa", "Equipe", "Planejado", "Apurado", "Saldo até o limite", "Hora extra"]]
    records = [["Pessoa", "Data", "Primeira entrada", "Última saída", "Horas apuradas", "Pausas", "Saída pendente"]]
    schedules = [["Pessoa", "Dia", "Entrada", "Início almoço", "Fim almoço", "Saída", "Horas previstas"]]
    weekday_names = ("Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo")
    for person in data["people"]:
        summary.append([person["name"], person["team"], person["plannedMinutes"] / 60,
                        person["workedMinutes"] / 60, person["remainingMinutes"] / 60, person["overtimeMinutes"] / 60])
        for day in person["days"]:
            records.append([person["name"], day["date"], day["first"][11:16], day["last"][11:16],
                            day["workedMinutes"] / 60, day["breakMinutes"] / 60, day["open"]])
        for row in person["schedule"]:
            schedules.append([person["name"], weekday_names[row["weekday"]], row["start_time"], row["lunch_start"],
                              row["lunch_end"], row["end_time"], row["scheduled_minutes"] / 60])
    vacations = [["Pessoa", "Equipe", "Saída", "Dias informados", "Retorno", "Responsável no lugar", "Observação"]]
    for item in data["vacations"]:
        vacations.append([item["name"], item["team"], item["start_date"], item["days"], item["return_date"], item["cover"], item["note"]])
    return summary, records, schedules, vacations
