import hashlib
import json
import re
import threading
from datetime import date, datetime, timezone

import s4e_connector as s4e
import s4e_vendas as source

_lock = threading.Lock()
_job = {'running': False, 'start': '', 'end': '', 'message': '', 'done': 0, 'total': 0,
        'error': '', 'startedAt': None, 'finishedAt': None}
_connection = None
_credentials = None
_busy = None


def configure(connection, credentials, busy):
    global _connection, _credentials, _busy
    _connection, _credentials, _busy = connection, credentials, busy


def stamp():
    return datetime.now(timezone.utc).isoformat()


def ensure_schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS vendas_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
        checked_at TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL
    )''')
    db.execute('CREATE INDEX IF NOT EXISTS vendas_snapshot_period ON vendas_snapshots(start_date,end_date,id)')
    db.execute('''CREATE TABLE IF NOT EXISTS vendas_links (
        link_key TEXT PRIMARY KEY, company_id TEXT NOT NULL, confirmed_by TEXT NOT NULL,
        confirmed_at TEXT NOT NULL, source_snapshot INTEGER NOT NULL, source_record TEXT NOT NULL,
        FOREIGN KEY(company_id) REFERENCES contract_companies(id) ON DELETE CASCADE
    )''')
    db.execute('CREATE INDEX IF NOT EXISTS vendas_links_company ON vendas_links(company_id)')
    db.execute('''CREATE TABLE IF NOT EXISTS vendas_link_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, link_key TEXT NOT NULL, company_id TEXT NOT NULL,
        confirmed_by TEXT NOT NULL, confirmed_at TEXT NOT NULL, source_snapshot INTEGER NOT NULL,
        source_record TEXT NOT NULL
    )''')


def period(payload):
    if not isinstance(payload, dict):
        raise ValueError('Informe o período em um objeto JSON.')
    end = date.fromisoformat(payload.get('end') or date.today().isoformat())
    start = date.fromisoformat(payload.get('start') or end.replace(day=1).isoformat())
    if start > end or (end - start).days > 30 or end > date.today():
        raise ValueError('Escolha até 31 dias, sem datas futuras.')
    return start, end


def job_status():
    with _lock:
        return dict(_job)


def update(**values):
    with _lock:
        _job.update(values)


def store(db, start, end, payload, at=None):
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    fingerprint = hashlib.sha256(encoded.encode()).hexdigest()
    at = at or stamp()
    previous = db.execute('SELECT * FROM vendas_snapshots WHERE start_date=? AND end_date=? ORDER BY id DESC LIMIT 1',
                          (start.isoformat(), end.isoformat())).fetchone()
    if previous and previous['fingerprint'] == fingerprint:
        db.execute('UPDATE vendas_snapshots SET checked_at=? WHERE id=?', (at, previous['id']))
        return previous['id']
    cursor = db.execute('INSERT INTO vendas_snapshots(start_date,end_date,checked_at,fingerprint,payload) VALUES(?,?,?,?,?)',
                        (start.isoformat(), end.isoformat(), at, fingerprint, encoded))
    return cursor.lastrowid


def companies(db):
    return [dict(row) for row in db.execute('SELECT id,name,cnpj,seller FROM contract_companies ORDER BY lower(name),id')]


def snapshot_payload(db, row):
    data = json.loads(row['payload'])
    links = {item['link_key']: item['company_id'] for item in db.execute('SELECT link_key,company_id FROM vendas_links')}
    contracts = {item['id']: dict(item) for item in db.execute('SELECT id,name,cnpj FROM contract_companies')}
    for record in data['rows']:
        company = contracts.get(links.get(record['linkKey']))
        record['companyId'] = company['id'] if company else None
        record['linkedCompany'] = company
    return {**data, 'id': row['id'], 'start': row['start_date'], 'end': row['end_date'], 'checkedAt': row['checked_at']}


def overview(db, start, end):
    row = db.execute('SELECT * FROM vendas_snapshots WHERE start_date=? AND end_date=? ORDER BY id DESC LIMIT 1',
                     (start.isoformat(), end.isoformat())).fetchone()
    return {'snapshot': snapshot_payload(db, row) if row else None, 'job': job_status(), 'companies': companies(db)}


def confirm_link(db, payload, user_id):
    if not isinstance(payload, dict):
        raise ValueError('Informe o vínculo em um objeto JSON.')
    key, company_id = payload.get('linkKey'), payload.get('companyId')
    if not isinstance(key, str) or not re.fullmatch(r'[a-f0-9]{64}', key) or not isinstance(company_id, str):
        raise ValueError('Informe um registro de origem e um contrato válidos.')
    snapshot_id = payload.get('snapshotId')
    if isinstance(snapshot_id, bool) or not isinstance(snapshot_id, int):
        raise ValueError('Informe a consulta de origem do vínculo.')
    row = db.execute('SELECT * FROM vendas_snapshots WHERE id=?', (snapshot_id,)).fetchone()
    if not row:
        raise ValueError('A consulta de origem não foi encontrada. Atualize a tela.')
    latest = db.execute('SELECT id FROM vendas_snapshots WHERE start_date=? AND end_date=? ORDER BY id DESC LIMIT 1',
                        (row['start_date'], row['end_date'])).fetchone()
    if latest['id'] != snapshot_id:
        raise ValueError('Há uma consulta mais recente. Atualize a tela antes de confirmar o vínculo.')
    records = [item for item in json.loads(row['payload'])['rows'] if item['linkKey'] == key]
    if not records or not db.execute('SELECT 1 FROM contract_companies WHERE id=?', (company_id,)).fetchone():
        raise ValueError('O registro de vendas ou o contrato não foi encontrado.')
    proof = json.dumps({'responsibleId': records[0]['responsibleId'], 'responsible': records[0]['responsible'],
                        'company': records[0]['company'], 'records': [item['key'] for item in records]}, ensure_ascii=False)
    at = stamp()
    db.execute('''INSERT INTO vendas_links(link_key,company_id,confirmed_by,confirmed_at,source_snapshot,source_record)
        VALUES(?,?,?,?,?,?) ON CONFLICT(link_key) DO UPDATE SET company_id=excluded.company_id,
        confirmed_by=excluded.confirmed_by,confirmed_at=excluded.confirmed_at,
        source_snapshot=excluded.source_snapshot,source_record=excluded.source_record''',
        (key, company_id, user_id, at, snapshot_id, proof))
    db.execute('''INSERT INTO vendas_link_history(link_key,company_id,confirmed_by,confirmed_at,source_snapshot,source_record)
        VALUES(?,?,?,?,?,?)''', (key, company_id, user_id, at, snapshot_id, proof))


def start_query(start, end):
    if _busy():
        raise s4e.ConnectorError('Aguarde a apuração, a importação ou a consulta de retornos terminar antes de consultar as vendas.')
    with _lock:
        if _job['running']:
            raise s4e.ConnectorError('Já existe uma consulta de vendas em andamento. Aguarde a conclusão.')
        _job.update(running=True, start=start.isoformat(), end=end.isoformat(), message='Abrindo uma sessão de consulta de vendas no S4E...',
                    done=0, total=0, error='', startedAt=stamp(), finishedAt=None)
    try:
        threading.Thread(target=worker, args=(start, end), name='s4e-vendas', daemon=True).start()
    except Exception:
        update(running=False, finishedAt=stamp())
        raise


def worker(start, end):
    try:
        session = source.open_session(_credentials())
        payload = source.fetch_sales(session, start, end, lambda message, done, total: update(message=message, done=done, total=total))
        with _connection() as db:
            store(db, start, end, payload)
            db.commit()
        update(message=f"Consulta concluída: {len(payload['teams'])} equipes e {len(payload['rows'])} registros detalhados.", error='')
    except Exception as exc:
        update(error=str(exc), message='A consulta não foi concluída. Os últimos dados completos foram preservados.')
    finally:
        update(running=False, finishedAt=stamp())
