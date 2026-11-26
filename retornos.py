import hashlib
import json
import threading
import time
from datetime import date, datetime, timedelta, timezone

import s4e_connector as s4e
import s4e_retornos as source

_lock = threading.Lock()
_state = {'running': False, 'message': '', 'error': '', 'nextCheck': None, 'periodStart': None, 'periodEnd': None, 'pendingStart': None, 'pendingEnd': None}
_connection = None
_credentials = None
_busy = None
_auto_enabled = lambda: True
_http = None
AUTO_TZ = timezone(timedelta(hours=-3))
AUTO_INTERVAL_MINUTES = 30
AUTO_WINDOW_START = 7
AUTO_WINDOW_END = 19


def configure(connection, credentials, busy, auto_enabled=None):
    global _connection, _credentials, _busy, _auto_enabled
    _connection, _credentials, _busy = connection, credentials, busy
    _auto_enabled = auto_enabled or (lambda: True)


def _auto_window_open(now=None):
    now = now or datetime.now(AUTO_TZ)
    return now.weekday() <= 4 and AUTO_WINDOW_START <= now.hour < AUTO_WINDOW_END


def stamp():
    return datetime.now(timezone.utc).isoformat()


def ensure_schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS retornos_files (
        id TEXT PRIMARY KEY, metadata TEXT NOT NULL, details TEXT,
        checked_at TEXT NOT NULL, detail_error TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL DEFAULT ''
    )''')
    db.execute('''CREATE TABLE IF NOT EXISTS retornos_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, lote_id TEXT NOT NULL,
        at TEXT NOT NULL, status TEXT NOT NULL, metadata TEXT NOT NULL, details TEXT NOT NULL
    )''')
    db.execute('CREATE INDEX IF NOT EXISTS retornos_history_lote ON retornos_history(lote_id, id)')
    db.execute('''CREATE TABLE IF NOT EXISTS retornos_incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT, lote_id TEXT NOT NULL, identity TEXT NOT NULL,
        scope TEXT NOT NULL, state TEXT NOT NULL, message TEXT NOT NULL, line TEXT,
        first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, resolved_at TEXT, UNIQUE(lote_id, identity)
    )''')
    db.execute('''CREATE TABLE IF NOT EXISTS retornos_control (
        id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0, last_checked TEXT
    )''')
    if not db.execute('SELECT 1 FROM retornos_control WHERE id=1').fetchone():
        db.execute('INSERT OR IGNORE INTO retornos_control(id) VALUES(1)')
    columns = {row[1] for row in db.execute('PRAGMA table_info(retornos_incidents)')}
    if 'processed_at' not in columns:
        db.execute("ALTER TABLE retornos_incidents ADD COLUMN processed_at TEXT NOT NULL DEFAULT ''")
        db.execute("UPDATE retornos_incidents SET processed_at=(SELECT json_extract(metadata,'$.processedAt') FROM retornos_files WHERE id=lote_id)")
    if 'resolution' not in columns:
        db.execute('ALTER TABLE retornos_incidents ADD COLUMN resolution TEXT')
    db.execute('''CREATE TABLE IF NOT EXISTS retornos_scans (
        start_date TEXT NOT NULL, end_date TEXT NOT NULL, checked_at TEXT NOT NULL,
        PRIMARY KEY(start_date,end_date)
    )''')


def _file(row):
    metadata = json.loads(row['metadata'])
    details = json.loads(row['details']) if row['details'] else {'rows': []}
    return {**metadata, 'checkedAt': row['checked_at'], 'detailError': row['detail_error'],
            'errors': sum(x['severity'] == 'error' for x in details['rows']),
            'warnings': sum(x['severity'] == 'warning' for x in details['rows']), 'lines': len(details['rows'])}


def _incidents(db, lote_id=None):
    where, params = ('WHERE i.lote_id=?', (lote_id,)) if lote_id else ('', ())
    rows = db.execute(f'''SELECT i.*, f.metadata FROM retornos_incidents i
        JOIN retornos_files f ON f.id=i.lote_id {where}
        ORDER BY CASE i.state WHEN 'open' THEN 0 ELSE 1 END, i.last_seen DESC, i.id DESC''', params).fetchall()
    result = []
    for row in rows:
        file = json.loads(row['metadata'])
        result.append({'id': row['id'], 'loteId': row['lote_id'], 'scope': row['scope'], 'state': row['state'],
                       'message': row['message'], 'firstSeen': row['first_seen'], 'lastSeen': row['last_seen'],
                       'resolvedAt': row['resolved_at'], 'filename': file['filename'], 'type': file['type'],
                       'agreement': file['agreement'], 'processedAt': row['processed_at'], 'sourceStatus': file['status'],
                       'resolution': json.loads(row['resolution']) if row['resolution'] else None,
                       'line': json.loads(row['line']) if row['line'] else None})
    return result


def monitor(db):
    control = db.execute('SELECT * FROM retornos_control WHERE id=1').fetchone()
    with _lock:
        state = dict(_state)
    return {**state, 'enabled': bool(control['enabled']), 'lastChecked': control['last_checked']}


def overview(db, start=None, end=None):
    start, end = start or date.today(), end or date.today()
    incidents = _incidents(db)
    line_scopes = {(item['loteId'], item['state']) for item in incidents if item['scope'] == 'line'}
    incidents = [item for item in incidents if item['scope'] != 'file' or (item['loteId'], item['state']) not in line_scopes]
    global_open = sum(item['state'] == 'open' for item in incidents)
    selected = [item for item in incidents if start <= datetime.strptime(item['processedAt'][:10], '%d/%m/%Y').date() <= end]
    institutions = set()
    for row in db.execute('SELECT metadata FROM retornos_files'):
        file = json.loads(row['metadata'])
        if start <= datetime.strptime(file['processedAt'][:10], '%d/%m/%Y').date() <= end:
            institutions.add(file['type'])
    institutions.update(item['type'] for item in selected)
    scan = db.execute('SELECT checked_at FROM retornos_scans WHERE start_date=? AND end_date=?', (start.isoformat(), end.isoformat())).fetchone()
    return {'incidents': selected, 'institutions': sorted(institutions), 'globalOpen': global_open,
            'period': {'start': start.isoformat(), 'end': end.isoformat(), 'checkedAt': scan['checked_at'] if scan else None},
            'monitor': monitor(db)}


def detail(db, lote_id):
    row = db.execute('SELECT * FROM retornos_files WHERE id=?', (lote_id,)).fetchone()
    if not row:
        return None
    history = db.execute('SELECT * FROM retornos_history WHERE lote_id=? ORDER BY id DESC', (lote_id,)).fetchall()
    return {'file': _file(row), 'details': json.loads(row['details']) if row['details'] else None,
            'history': [{'at': h['at'], 'status': h['status'], 'file': json.loads(h['metadata']),
                         'details': json.loads(h['details'])} for h in history], 'incidents': _incidents(db, lote_id)}


def _line_identity(line):
    return (line['installment'], line['ourNumber'], line['client'])


def _processed(file):
    return datetime.strptime(file['processedAt'], '%d/%m/%Y %H:%M:%S')


def _normalized_our_number(value):
    value = str(value or '').strip()
    return value.lstrip('0') or '0' if value else ''


def _correction_key(line):
    our_number = _normalized_our_number(line.get('ourNumber'))
    client = str(line.get('client') or '').strip()
    return (our_number, client) if our_number and client else None


def _correction_identity(line):
    fields = ('ourNumber', 'client')
    values = tuple(line.get(key) for key in fields)
    return values if all(value is not None and value != '' for value in values) else None


def _open_incident(db, file, identity, scope, message, line, at):
    previous = db.execute('SELECT * FROM retornos_incidents WHERE lote_id=? AND identity=?', (file['id'], identity)).fetchone()
    if previous and previous['resolution']:
        resolution = json.loads(previous['resolution'])
        original = json.loads(previous['line']) if previous['line'] else None
        if original == line and _processed(file) < _processed(resolution):
            db.execute('UPDATE retornos_incidents SET last_seen=? WHERE id=?', (at, previous['id']))
            return
    db.execute('''INSERT INTO retornos_incidents
        (lote_id,identity,scope,state,message,line,first_seen,last_seen,processed_at)
        VALUES(?,?,?,'open',?,?,?,?,?) ON CONFLICT(lote_id,identity) DO UPDATE SET
        state='open',message=excluded.message,line=excluded.line,last_seen=excluded.last_seen,resolved_at=NULL,resolution=NULL''',
        (file['id'], identity, scope, message, json.dumps(line, ensure_ascii=False) if line else None, at, at, file['processedAt']))


def reconcile(db, at=None):
    at = at or stamp()
    files = []
    for row in db.execute('SELECT * FROM retornos_files'):
        files.append((json.loads(row['metadata']), json.loads(row['details']) if row['details'] else None, row['detail_error']))
    family_fields = ('filename', 'service', 'type', 'nsa', 'agreement')
    for original, old_details, _ in files:
        if not old_details:
            continue
        candidates = [(file, details, error) for file, details, error in files
                      if file['id'] != original['id'] and _processed(file) > _processed(original)
                      and all(original.get(key) and original[key] == file.get(key) for key in family_fields)]
        if not candidates:
            continue
        latest = max(_processed(file) for file, _, _ in candidates)
        candidates = [candidate for candidate in candidates if _processed(candidate[0]) == latest]
        if len(candidates) != 1:
            continue
        file, details, error = candidates[0]
        if error or not details or source.normalized(file['status']) != 'processado':
            continue
        rows = details['rows']
        incidents = db.execute("SELECT * FROM retornos_incidents WHERE lote_id=? AND scope='line' AND state='open'", (original['id'],)).fetchall()
        complete_replacement = bool(rows) and len(rows) == len(old_details['rows']) and all(
            row['severity'] == 'success' for row in rows
        )
        if complete_replacement:
            for incident in incidents:
                line = json.loads(incident['line'])
                key = _correction_key(line)
                matches = [row for row in rows if _correction_key(row) == key] if key else []
                corrected = matches[0] if len(matches) == 1 else None
                resolution = {'loteId': file['id'], 'processedAt': file['processedAt'],
                              'status': file['status']}
                if corrected:
                    resolution['line'] = corrected
                db.execute("UPDATE retornos_incidents SET state='resolved',resolved_at=?,resolution=? WHERE id=?",
                           (at, json.dumps(resolution, ensure_ascii=False), incident['id']))
            resolution = {'loteId': file['id'], 'processedAt': file['processedAt'], 'status': file['status']}
            db.execute("UPDATE retornos_incidents SET state='resolved',resolved_at=?,resolution=? WHERE lote_id=? AND state='open'",
                       (at, json.dumps(resolution, ensure_ascii=False), original['id']))
            continue
        for incident in incidents:
            line = json.loads(incident['line'])
            identity = _correction_identity(line)
            old_matches = [row for row in old_details['rows'] if _correction_identity(row) == identity]
            matches = [row for row in rows if _correction_key(row) == _correction_key(line)]
            if not identity or len(old_matches) != 1 or len(matches) != 1:
                continue
            corrected = matches[0]
            if corrected['severity'] != 'success' or _correction_identity(corrected) != identity or not corrected.get('installment'):
                continue
            resolution = {'loteId': file['id'], 'processedAt': file['processedAt'], 'status': file['status'], 'line': corrected}
            db.execute("UPDATE retornos_incidents SET state='resolved',resolved_at=?,resolution=? WHERE id=?",
                       (at, json.dumps(resolution, ensure_ascii=False), incident['id']))
        incidents = db.execute("SELECT * FROM retornos_incidents WHERE lote_id=? AND scope='line'", (original['id'],)).fetchall()
        if incidents and all(item['state'] == 'resolved' for item in incidents) and rows and all(row['severity'] == 'success' for row in rows):
            resolutions = [json.loads(item['resolution']) for item in incidents if item['resolution']]
            if len(resolutions) == len(incidents) and all(item['loteId'] == file['id'] for item in resolutions):
                resolution = {'loteId': file['id'], 'processedAt': file['processedAt'], 'status': file['status']}
                db.execute("UPDATE retornos_incidents SET state='resolved',resolved_at=?,resolution=? WHERE lote_id=? AND scope='file' AND state='open'",
                           (at, json.dumps(resolution, ensure_ascii=False), original['id']))


def store(db, file, details=None, error='', at=None):
    at = at or stamp()
    previous = db.execute('SELECT * FROM retornos_files WHERE id=?', (file['id'],)).fetchone()
    if previous:
        old = json.loads(previous['metadata'])
        identity_fields = ('filename', 'service', 'type', 'nsa', 'agreement')
        if any(old[key] != file[key] for key in identity_fields):
            raise s4e.ConnectorError('O S4E mudou a identidade de um lote conhecido; a associação automática foi interrompida.')
    metadata = json.dumps(file, ensure_ascii=False, sort_keys=True)
    encoded = json.dumps(details, ensure_ascii=False, sort_keys=True) if details is not None else None
    fingerprint = hashlib.sha256((metadata + encoded).encode()).hexdigest() if encoded else ''
    if details is None and previous and json.loads(previous['metadata']) != file and not error:
        error = 'Os detalhes precisam ser conferidos novamente após a atualização do lote.'
    db.execute('''INSERT INTO retornos_files(id,metadata,details,checked_at,detail_error,fingerprint)
        VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,
        details=COALESCE(excluded.details,retornos_files.details),checked_at=excluded.checked_at,
        detail_error=excluded.detail_error,
        fingerprint=CASE WHEN excluded.details IS NULL THEN retornos_files.fingerprint ELSE excluded.fingerprint END''',
        (file['id'], metadata, encoded, at, error, fingerprint))
    rejected = source.normalized(file['status']) == 'rejeitado'
    processed = source.normalized(file['status']) == 'processado'
    if rejected:
        errors = [line for line in (details or {}).get('rows', []) if line['severity'] == 'error']
        reasons = ', '.join(sorted({line['occurrence'] for line in errors}))
        message = f"Arquivo rejeitado pelo S4E: {reasons}" if reasons else 'Arquivo rejeitado pelo S4E. O motivo detalhado ainda não foi confirmado.'
        _open_incident(db, file, 'file', 'file', message, None, at)
    if details is None:
        return
    if not previous or previous['fingerprint'] != fingerprint:
        db.execute('INSERT INTO retornos_history(lote_id,at,status,metadata,details) VALUES(?,?,?,?,?)',
                   (file['id'], at, file['status'], metadata, encoded))
    errors = [line for line in details['rows'] if line['severity'] == 'error']
    for line in errors:
        identity = json.dumps([*_line_identity(line), line['occurrenceCode'], line['occurrence']], ensure_ascii=False)
        _open_incident(db, file, identity, 'line', line['occurrence'], line, at)
    if not processed:
        return
    successful = {_line_identity(line) for line in details['rows'] if line['severity'] == 'success' and all(_line_identity(line))}
    blocked = {_line_identity(line) for line in details['rows'] if line['severity'] in ('error', 'warning', 'info')}
    incidents = db.execute("SELECT * FROM retornos_incidents WHERE lote_id=? AND scope='line' AND state='open'", (file['id'],)).fetchall()
    for incident in incidents:
        line = json.loads(incident['line'])
        if _line_identity(line) in successful - blocked:
            db.execute("UPDATE retornos_incidents SET state='resolved',resolved_at=?,last_seen=? WHERE id=?", (at, at, incident['id']))
    unresolved = db.execute("SELECT 1 FROM retornos_incidents WHERE lote_id=? AND scope='line' AND state='open'", (file['id'],)).fetchone()
    confirmed = bool(details['rows']) and all(line['severity'] == 'success' for line in details['rows'])
    if confirmed and not unresolved:
        db.execute("UPDATE retornos_incidents SET state='resolved',resolved_at=?,last_seen=? WHERE lote_id=? AND identity='file' AND state='open'", (at, at, file['id']))


def period(payload):
    if not isinstance(payload, dict):
        raise ValueError('Envie um objeto JSON com o período.')
    end = date.fromisoformat(payload.get('end') or date.today().isoformat())
    start = date.fromisoformat(payload.get('start') or end.isoformat())
    if start > end or (end - start).days > 30 or end > date.today():
        raise ValueError('Escolha um período de até 31 dias, sem datas futuras.')
    return start, end


def _update(**values):
    with _lock:
        _state.update(values)


def start_sync(start, end, force=True):
    with _lock:
        if _state['running']:
            return False
        if _busy():
            raise s4e.ConnectorError('Aguarde a apuração ou a importação do S4E terminar antes de consultar os retornos.')
        _state.update(running=True, message='Conferindo os retornos de todas as instituições...', error='', nextCheck=None,
                      periodStart=start.isoformat(), periodEnd=end.isoformat())
    try:
        with _connection() as db:
            db.execute('UPDATE retornos_control SET enabled=1 WHERE id=1')
            db.commit()
        threading.Thread(target=_worker, args=(start, end, force), daemon=True, name='s4e-retornos').start()
    except Exception:
        _update(running=False)
        raise
    return True


def _worker(start, end, force=True):
    global _http
    failures = 0
    deferred = 0
    begun = time.monotonic()
    try:
        if _http is None:
            _http = source.open_session(_credentials())
        _update(message='Consultando a lista de retornos e conferindo os lotes com alertas abertos...')
        files = source.fetch_files(_http, start, end)
        with _connection() as db:
            stored = {row['id']: row for row in db.execute('SELECT * FROM retornos_files')}
            pending = db.execute("SELECT DISTINCT f.metadata FROM retornos_files f JOIN retornos_incidents i ON i.lote_id=f.id WHERE i.state='open'").fetchall()
        known = {file['id'] for file in files}
        days = set()
        for row in pending:
            file = json.loads(row['metadata'])
            if file['id'] not in known:
                days.add(datetime.strptime(file['processedAt'][:10], '%d/%m/%Y').date())
        for day in sorted(days):
            if time.monotonic() - begun > 180 or _busy():
                deferred += 1
                break
            extra = source.fetch_files(_http, day, day)
            for file in extra:
                if file['id'] not in known and file['id'] in stored:
                    files.append(file)
                    known.add(file['id'])
        with _connection() as db:
            for file in files:
                previous = stored.get(file['id'])
                error = previous['detail_error'] if previous else 'Detalhes ainda não consultados.'
                store(db, file, error=error)
            db.commit()
        files.sort(key=lambda file: (source.normalized(file['status']) != 'rejeitado', -int(file['id'])))
        for index, file in enumerate(files):
            if time.monotonic() - begun > 180 or _busy():
                deferred += len(files) - index
                break
            previous = stored.get(file['id'])
            in_selected_period = start <= datetime.strptime(file['processedAt'][:10], '%d/%m/%Y').date() <= end
            needs_details = (force and in_selected_period) or not previous or previous['detail_error'] or not previous['details']
            if previous:
                old = json.loads(previous['metadata'])
                old_details = json.loads(previous['details']) if previous['details'] else {'rows': []}
                needs_details = needs_details or old != file or any(line['severity'] in ('error', 'warning', 'info') for line in old_details['rows'])
            if source.normalized(file['status']) == 'rejeitado':
                needs_details = True
            if not needs_details:
                continue
            _update(message=f"Lendo todas as linhas do lote {file['id']} ({index + 1} de {len(files)})...")
            try:
                details = source.fetch_details(_http, file['id'])
                with _connection() as db:
                    store(db, file, details)
                    db.commit()
            except (s4e.ConnectorError, OSError) as exc:
                failures += 1
                with _connection() as db:
                    store(db, file, error=str(exc))
                    db.commit()
                if 'sessão' in str(exc).casefold():
                    _http = None
                    raise
        with _connection() as db:
            reconcile(db)
            db.commit()
        if not failures and not deferred:
            with _connection() as db:
                checked_at = stamp()
                db.execute('UPDATE retornos_control SET last_checked=? WHERE id=1', (checked_at,))
                db.execute('INSERT INTO retornos_scans(start_date,end_date,checked_at) VALUES(?,?,?) ON CONFLICT(start_date,end_date) DO UPDATE SET checked_at=excluded.checked_at',
                           (start.isoformat(), end.isoformat(), checked_at))
                db.commit()
        error = ''
        if failures or deferred:
            error = f'Consulta parcial: {failures} lote(s) sem detalhes confirmados; {deferred} leitura(s) pendentes. Os dados anteriores foram preservados e o monitor tentará novamente.'
        _update(message=f'{len(files)} arquivo(s) consultado(s). Monitoramento a cada 30 minutos, em horário comercial.', error=error)
    except Exception as exc:
        failures += 1
        _http = None
        _update(message='Não foi possível concluir a consulta; os dados anteriores foram preservados.', error=str(exc))
    finally:
        _update(running=False, nextCheck=(datetime.now(timezone.utc) + timedelta(minutes=AUTO_INTERVAL_MINUTES)).isoformat(),
                pendingStart=start.isoformat() if failures or deferred else None,
                pendingEnd=end.isoformat() if failures or deferred else None)


def activate():
    with _connection() as db:
        db.execute('UPDATE retornos_control SET enabled=1 WHERE id=1')
        db.commit()
    if _auto_enabled() and _auto_window_open() and not _busy():
        start_sync(date.today(), date.today())


def scheduler():
    while True:
        time.sleep(30)
        try:
            with _connection() as db:
                state = monitor(db)
            if not state['enabled'] or state['running'] or not _auto_enabled() or not _auto_window_open() or _busy():
                continue
            if state['nextCheck'] and datetime.now(timezone.utc) < datetime.fromisoformat(state['nextCheck']):
                continue
            if state.get('pendingStart'):
                start_sync(date.fromisoformat(state['pendingStart']), date.fromisoformat(state['pendingEnd']), force=False)
            else:
                start_sync(date.today(), date.today())
        except Exception as exc:
            _update(error=str(exc), nextCheck=(datetime.now(timezone.utc) + timedelta(minutes=AUTO_INTERVAL_MINUTES)).isoformat())
