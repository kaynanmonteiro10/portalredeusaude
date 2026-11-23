import hashlib
import json
import re
import threading
import time
import urllib.error
import urllib.request
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from urllib.parse import quote, urlencode, urlparse

MAILBOXES = {
    'administrativo@appredesaude.com.br': 'Administrativo',
    'faturamento@appredesaude.com.br': 'Faturamento',
}
SCOPES = 'offline_access User.Read Mail.Read Mail.Read.Shared'
GRAPH = 'https://graph.microsoft.com/v1.0'
SETUP_KEY = 'email_center_setup'
STATUSES = {'review', 'awaiting_me', 'awaiting_them', 'done'}
PRIORITIES = {'urgent', 'high', 'medium', 'low'}
_connection = _protect = _reveal = None
_guard = threading.RLock()
_sessions = {}
_jobs = {}
_tokens = {}
_token_locks = {address: threading.Lock() for address in MAILBOXES}


class EmailError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def configure(connection, protect, reveal):
    global _connection, _protect, _reveal
    _connection, _protect, _reveal = connection, protect, reveal


@contextmanager
def database():
    db = _connection()
    try:
        with db:
            yield db
    finally:
        db.close()


def ensure_schema(db):
    db.execute('''CREATE TABLE IF NOT EXISTS email_accounts (
        address TEXT PRIMARY KEY, sealed TEXT NOT NULL,
        last_sync TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '')''')
    db.execute('''CREATE TABLE IF NOT EXISTS email_messages (
        mailbox TEXT NOT NULL, message_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
        at TEXT NOT NULL, direction TEXT NOT NULL, fingerprint TEXT NOT NULL,
        sealed TEXT NOT NULL, PRIMARY KEY(mailbox, message_id))''')
    db.execute('CREATE INDEX IF NOT EXISTS email_conversations ON email_messages(mailbox, conversation_id, at)')
    db.execute('''CREATE TABLE IF NOT EXISTS email_followups (
        key TEXT PRIMARY KEY, status TEXT NOT NULL, due TEXT NOT NULL,
        priority TEXT NOT NULL, updated_at TEXT NOT NULL)''')
    db.execute('CREATE TABLE IF NOT EXISTS email_task_links (key TEXT PRIMARY KEY, task_id TEXT NOT NULL)')
    db.execute('CREATE TABLE IF NOT EXISTS email_task_messages (fingerprint TEXT PRIMARY KEY, task_id TEXT NOT NULL)')


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def seal(data):
    value = _protect(json.dumps(data, ensure_ascii=False))
    if not value:
        raise EmailError('O Windows não conseguiu proteger os dados da central.', 503)
    return value


def unseal(value):
    decoded = _reveal(value)
    if not decoded:
        raise EmailError('Não foi possível abrir os dados protegidos. Use o mesmo usuário Windows do servidor.', 503)
    return json.loads(decoded)


def mailbox_value(value):
    address = str(value or '').strip().lower()
    if address not in MAILBOXES:
        raise EmailError('Selecione uma das duas caixas configuradas.')
    return address


def setup(db):
    row = db.execute('SELECT value FROM meta WHERE key=?', (SETUP_KEY,)).fetchone()
    return json.loads(row['value']) if row else {'clientId': '', 'tenant': 'organizations'}


def account(db, mailbox):
    row = db.execute('SELECT sealed FROM email_accounts WHERE address=?', (mailbox,)).fetchone()
    return unseal(row['sealed']) if row else None


def save_setup(payload):
    client = str(payload.get('clientId') or '').strip()
    tenant = str(payload.get('tenant') or 'organizations').strip()
    guid = r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}'
    if not re.fullmatch(guid, client) or (tenant != 'organizations' and not re.fullmatch(guid, tenant)):
        raise EmailError('Informe o ID do aplicativo e o ID do diretório Microsoft válidos.')
    with _guard, database() as db:
        if db.execute('SELECT 1 FROM email_accounts').fetchone() or _sessions:
            raise EmailError('Desconecte as caixas e encerre as autorizações antes de alterar o aplicativo.', 409)
        db.execute('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                   (SETUP_KEY, json.dumps({'clientId': client, 'tenant': tenant})))
    return {'ok': True}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise EmailError('A Microsoft retornou um redirecionamento inesperado.', 502)


def validate_url(url, mailbox=None, oauth=False):
    parsed = urlparse(url)
    if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in (None, 443) or parsed.fragment:
        raise EmailError('Endereço Microsoft inválido.', 502)
    if oauth:
        valid = parsed.hostname == 'login.microsoftonline.com' and re.fullmatch(
            r'/(?:organizations|[0-9a-fA-F-]{36})/oauth2/v2\.0/(?:devicecode|token)', parsed.path)
    else:
        prefix = f'/v1.0/users/{quote(mailbox, safe="")}' if mailbox else ''
        valid = parsed.hostname == 'graph.microsoft.com' and (
            parsed.path == '/v1.0/me' or
            (prefix and (parsed.path in (prefix + '/mailFolders/Inbox', prefix + '/mailFolders/Inbox/messages',
                                        prefix + '/mailFolders/SentItems/messages') or
                         re.fullmatch(re.escape(prefix) + r'/messages/[A-Za-z0-9_%=+\-]+', parsed.path))))
    if not valid:
        raise EmailError('A central permite somente os endpoints de leitura das caixas autorizadas.', 502)


def request(url, token='', form=None, mailbox=None):
    validate_url(url, mailbox, oauth=form is not None)
    headers = {'Accept': 'application/json'}
    data = None
    if form is not None:
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
        data = urlencode(form).encode('utf-8')
    else:
        headers['Authorization'] = f'Bearer {token}'
        headers['Prefer'] = 'IdType="ImmutableId", outlook.body-content-type="text"'
    req = urllib.request.Request(url, data=data, headers=headers, method='POST' if form is not None else 'GET')
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=35) as response:
            status, raw = response.status, response.read(8_000_001)
    except urllib.error.HTTPError as exc:
        status, raw = exc.code, exc.read(8_000_001)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise EmailError('A leitura Microsoft não foi concluída. Os dados anteriores foram preservados.', 502) from exc
    if len(raw) > 8_000_000:
        raise EmailError('A resposta Microsoft excedeu o limite de leitura.', 502)
    try:
        result = json.loads(raw.decode('utf-8')) if raw else {}
    except (ValueError, UnicodeDecodeError) as exc:
        raise EmailError('A Microsoft retornou uma resposta inválida.', 502) from exc
    if not isinstance(result, dict):
        raise EmailError('A Microsoft retornou uma resposta inválida.', 502)
    return status, result


def graph_error(status):
    if status in (401, 403):
        return EmailError('O acesso de leitura foi negado ou expirou. Reconecte a caixa e confira as permissões Microsoft.', 403)
    if status == 429:
        return EmailError('A Microsoft limitou as consultas. A central tentará novamente após alguns minutos.', 429)
    return EmailError('Não foi possível concluir a leitura Microsoft. Os dados anteriores foram preservados.', 502)


def graph_get(url, token, mailbox):
    status, result = request(url, token=token, mailbox=mailbox)
    if status >= 300:
        raise graph_error(status)
    return result


def authority(config):
    return f'https://login.microsoftonline.com/{config["tenant"]}/oauth2/v2.0'


def purge_sessions():
    for sid in list(_sessions):
        if _sessions[sid]['expires'] <= time.monotonic():
            del _sessions[sid]


def start_connect(payload, user):
    mailbox = mailbox_value(payload.get('mailbox'))
    with _guard, database() as db:
        purge_sessions()
        config = setup(db)
        if not config.get('clientId'):
            raise EmailError('Configure primeiro o aplicativo de leitura Microsoft 365 da empresa.')
        if account(db, mailbox):
            raise EmailError('Esta caixa já está conectada. Desconecte antes de autorizar novamente.', 409)
        if any(item['mailbox'] == mailbox for item in _sessions.values()):
            raise EmailError('Já há uma autorização em andamento para esta caixa.', 409)
    status, data = request(authority(config) + '/devicecode', form={'client_id': config['clientId'], 'scope': SCOPES})
    if status >= 300 or not data.get('device_code') or not data.get('user_code'):
        raise EmailError('Não foi possível iniciar a autorização. Confira o aplicativo público e a liberação do fluxo de dispositivo no Microsoft 365.', 502)
    uri = str(data.get('verification_uri') or '')
    parsed = urlparse(uri)
    if parsed.scheme != 'https' or parsed.hostname not in ('microsoft.com', 'www.microsoft.com', 'login.microsoftonline.com') or parsed.username or parsed.password:
        raise EmailError('O endereço de autorização Microsoft é inválido.', 502)
    lifetime = min(900, max(60, int(data.get('expires_in') or 900)))
    interval = max(5, min(30, int(data.get('interval') or 5)))
    sid = uuid.uuid4().hex
    with _guard:
        purge_sessions()
        if any(item['mailbox'] == mailbox for item in _sessions.values()):
            raise EmailError('Já há uma autorização em andamento para esta caixa.', 409)
        _sessions[sid] = {'mailbox': mailbox, 'owner': user['id'], 'device': data['device_code'],
                          'config': config, 'expires': time.monotonic() + lifetime, 'interval': interval,
                          'next': time.monotonic() + interval, 'busy': False}
    return {'sessionId': sid, 'userCode': data['user_code'], 'verificationUri': uri,
            'expiresIn': lifetime, 'interval': interval}


def check_scope(token):
    scopes = {s.rsplit('/', 1)[-1] for s in str(token.get('scope') or '').split()}
    if 'Mail.Read' not in scopes or any(s not in {'Mail.Read', 'Mail.Read.Shared', 'User.Read', 'offline_access', 'openid', 'profile', 'email'} for s in scopes):
        raise EmailError('A autorização precisa ser exclusiva de leitura. Confira as permissões do aplicativo.', 403)


def poll_connect(payload, user):
    sid = str(payload.get('sessionId') or '')
    with _guard:
        item = _sessions.get(sid)
        if not item or item['owner'] != user['id']:
            return {'status': 'expired'}
        if item['expires'] <= time.monotonic():
            del _sessions[sid]
            return {'status': 'expired'}
        if item['busy'] or time.monotonic() < item['next']:
            return {'status': 'pending', 'interval': item['interval']}
        item['busy'] = True
        item['next'] = time.monotonic() + item['interval']
    try:
        status, token = request(authority(item['config']) + '/token', form={
            'grant_type': 'urn:ietf:params:oauth:grant-type:device_code',
            'client_id': item['config']['clientId'], 'device_code': item['device']})
        if status >= 300:
            error = token.get('error')
            if error in ('authorization_pending', 'slow_down'):
                with _guard:
                    if error == 'slow_down':
                        item['interval'] += 5
                        item['next'] = time.monotonic() + item['interval']
                return {'status': 'pending', 'interval': item['interval']}
            with _guard:
                _sessions.pop(sid, None)
            raise EmailError('A autorização Microsoft não foi concluída. Inicie a conexão novamente.', 403)
        check_scope(token)
        if not token.get('access_token') or not token.get('refresh_token'):
            raise EmailError('A Microsoft não liberou uma conexão de leitura renovável.', 403)
        mailbox = item['mailbox']
        me = graph_get(GRAPH + '/me?' + urlencode({'$select': 'id,mail,userPrincipalName'}), token['access_token'], mailbox)
        identity = str(me.get('mail') or me.get('userPrincipalName') or '')[:254]
        graph_get(f'{GRAPH}/users/{quote(mailbox, safe="")}/mailFolders/Inbox?' + urlencode({'$select': 'id'}), token['access_token'], mailbox)
        saved = {'refreshToken': token['refresh_token'], 'account': identity, 'connectionId': uuid.uuid4().hex,
                 'clientId': item['config']['clientId'], 'tenant': item['config']['tenant']}
        with _guard, database() as db:
            if _sessions.get(sid) is not item:
                return {'status': 'expired'}
            db.execute('INSERT INTO email_accounts(address,sealed) VALUES(?,?)', (mailbox, seal(saved)))
            _sessions.pop(sid, None)
            _tokens.pop(mailbox, None)
            _jobs.pop(mailbox, None)
        start_sync(mailbox)
        return {'status': 'connected', 'mailbox': mailbox}
    except Exception:
        with _guard:
            _sessions.pop(sid, None)
        raise
    finally:
        with _guard:
            item['busy'] = False


def cancel_connect(payload, user):
    with _guard:
        sid = str(payload.get('sessionId') or '')
        if sid in _sessions and _sessions[sid]['owner'] == user['id']:
            _sessions.pop(sid)
    return {'ok': True}


def access_token(mailbox):
    with _token_locks[mailbox]:
        with database() as db:
            config = account(db, mailbox)
        if not config:
            raise EmailError('Conecte a caixa Microsoft para ler suas mensagens.', 409)
        with _guard:
            cached = _tokens.get(mailbox)
            if cached and cached['connectionId'] == config['connectionId'] and cached['expires'] > time.monotonic():
                return cached['value'], config['connectionId']
        status, token = request(authority(config) + '/token', form={
            'grant_type': 'refresh_token', 'client_id': config['clientId'],
            'refresh_token': config['refreshToken'], 'scope': SCOPES})
        if status >= 300 or not token.get('access_token'):
            raise graph_error(401 if token.get('error') in ('invalid_grant', 'interaction_required') else status)
        check_scope(token)
        config['refreshToken'] = token.get('refresh_token') or config['refreshToken']
        with _guard, database() as db:
            current = account(db, mailbox)
            if not current or current['connectionId'] != config['connectionId']:
                raise EmailError('A conexão desta caixa foi encerrada.', 409)
            db.execute('UPDATE email_accounts SET sealed=? WHERE address=?', (seal(config), mailbox))
            _tokens[mailbox] = {'value': token['access_token'], 'connectionId': config['connectionId'],
                                'expires': time.monotonic() + max(1, min(3500, int(token.get('expires_in') or 3600) - 120))}
        return token['access_token'], config['connectionId']


def outlook_link(value):
    parsed = urlparse(str(value or ''))
    return str(value) if parsed.scheme == 'https' and parsed.hostname in ('outlook.office.com', 'outlook.office365.com') and not parsed.username and not parsed.password else ''


def person(value):
    email = value.get('emailAddress') if isinstance(value, dict) else None
    email = email if isinstance(email, dict) else {}
    return {'name': str(email.get('name') or '')[:254], 'address': str(email.get('address') or '')[:254]}


def normalize_message(source, direction):
    if not isinstance(source, dict) or not source.get('id') or not source.get('conversationId'):
        raise EmailError('A Microsoft retornou uma mensagem sem identificação.', 502)
    raw = source.get('receivedDateTime' if direction == 'incoming' else 'sentDateTime')
    try:
        moment = datetime.fromisoformat(str(raw).replace('Z', '+00:00'))
        if moment.tzinfo is None:
            raise ValueError()
    except ValueError as exc:
        raise EmailError('A Microsoft retornou uma mensagem com data inválida.', 502) from exc
    message_id = str(source['id'])
    if len(message_id) > 2048 or not re.fullmatch(r'[A-Za-z0-9_=+\-]+', message_id):
        raise EmailError('Identificador de mensagem Microsoft inválido.', 502)
    recipients = source.get('toRecipients') or []
    if not isinstance(recipients, list):
        raise EmailError('Destinatários Microsoft inválidos.', 502)
    return {'id': message_id, 'conversationId': str(source['conversationId'])[:2048],
            'subject': str(source.get('subject') or '(Sem assunto)')[:500],
            'from': person(source.get('from')), 'to': [person(r) for r in recipients[:100]],
            'direction': direction, 'at': moment.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
            'preview': str(source.get('bodyPreview') or '')[:2000], 'isRead': bool(source.get('isRead')),
            'hasAttachments': bool(source.get('hasAttachments')), 'webLink': outlook_link(source.get('webLink')),
            'internetMessageId': str(source.get('internetMessageId') or '')[:2048]}


def fingerprint(message):
    value = message.get('internetMessageId', '').strip()
    return hashlib.sha256(value.encode()).hexdigest() if value else ''


def conversation_key(mailbox, conversation_id):
    return hashlib.sha256((mailbox + '\0' + conversation_id).encode()).hexdigest()


def fetch_folder(mailbox, folder, token, since):
    direction = 'incoming' if folder == 'Inbox' else 'outgoing'
    field = 'receivedDateTime' if folder == 'Inbox' else 'sentDateTime'
    prefix = f'{GRAPH}/users/{quote(mailbox, safe="")}/mailFolders/{folder}/messages'
    params = {'$select': 'id,conversationId,internetMessageId,subject,from,toRecipients,receivedDateTime,sentDateTime,bodyPreview,isRead,hasAttachments,webLink',
              '$filter': f'{field} ge {since}', '$orderby': f'{field} desc', '$top': '100'}
    url, rows, seen = prefix + '?' + urlencode(params), [], set()
    for _ in range(50):
        if url in seen:
            raise EmailError('A paginação Microsoft se repetiu. A leitura anterior foi preservada.', 502)
        seen.add(url)
        parsed = urlparse(url)
        if parsed.path != urlparse(prefix).path:
            raise EmailError('A paginação Microsoft mudou a pasta consultada.', 502)
        result = graph_get(url, token, mailbox)
        values = result.get('value')
        if not isinstance(values, list):
            raise EmailError('A Microsoft retornou uma lista de mensagens inválida.', 502)
        rows.extend(normalize_message(row, direction) for row in values)
        if len(rows) > 5000:
            raise EmailError('A caixa ultrapassou 5.000 mensagens por pasta nos últimos 30 dias. A leitura anterior foi preservada.', 422)
        url = result.get('@odata.nextLink')
        if not url:
            return rows
        if not isinstance(url, str):
            raise EmailError('Paginação Microsoft inválida.', 502)
    raise EmailError('Não foi possível concluir todas as páginas da caixa. A leitura anterior foi preservada.', 422)


def sync_worker(mailbox, job):
    connection_id = None
    try:
        token, connection_id = access_token(mailbox)
        since = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat(timespec='seconds').replace('+00:00', 'Z')
        messages = fetch_folder(mailbox, 'Inbox', token, since) + fetch_folder(mailbox, 'SentItems', token, since)
        if len({m['id'] for m in messages}) != len(messages):
            raise EmailError('A leitura retornou mensagens repetidas. A prévia anterior foi preservada.', 502)
        prepared = [(mailbox, m['id'], m['conversationId'], m['at'], m['direction'], fingerprint(m), seal(m)) for m in messages]
        with _guard, database() as db:
            current = account(db, mailbox)
            if _jobs.get(mailbox) is not job or not current or current['connectionId'] != connection_id:
                return
            db.execute('DELETE FROM email_messages WHERE mailbox=?', (mailbox,))
            db.executemany('INSERT INTO email_messages(mailbox,message_id,conversation_id,at,direction,fingerprint,sealed) VALUES(?,?,?,?,?,?,?)', prepared)
            db.execute('UPDATE email_accounts SET last_sync=?,error=? WHERE address=?', (stamp(), '', mailbox))
    except Exception as exc:
        message = str(exc) if isinstance(exc, EmailError) else 'Não foi possível concluir a leitura. Os dados anteriores foram preservados.'
        with _guard, database() as db:
            current = account(db, mailbox)
            if _jobs.get(mailbox) is job and current and (connection_id is None or current['connectionId'] == connection_id):
                db.execute('UPDATE email_accounts SET error=? WHERE address=?', (message, mailbox))
    finally:
        with _guard:
            job['running'] = False
            job['checked'] = time.monotonic()


def start_sync(mailbox, force=True):
    mailbox = mailbox_value(mailbox)
    with _guard, database() as db:
        if not account(db, mailbox):
            if force:
                raise EmailError('Conecte esta caixa primeiro.', 409)
            return False
        previous = _jobs.get(mailbox)
        if previous and (previous['running'] or (not force and time.monotonic() - previous['checked'] < 300)):
            return False
        job = {'running': True, 'checked': time.monotonic()}
        _jobs[mailbox] = job
    threading.Thread(target=sync_worker, args=(mailbox, job), daemon=True, name='email-center-read').start()
    return True


def disconnect(payload):
    mailbox = mailbox_value(payload.get('mailbox'))
    with _guard, database() as db:
        db.execute('DELETE FROM email_accounts WHERE address=?', (mailbox,))
        db.execute('DELETE FROM email_messages WHERE mailbox=?', (mailbox,))
        _tokens.pop(mailbox, None)
        _jobs.pop(mailbox, None)
        for sid in list(_sessions):
            if _sessions[sid]['mailbox'] == mailbox:
                _sessions.pop(sid)
    return {'ok': True}


def load_state(db):
    row = db.execute('SELECT data FROM portal_state WHERE id=1').fetchone()
    return json.loads(row['data']) if row else {}


def summarize(db):
    groups = {}
    for row in db.execute('SELECT * FROM email_messages ORDER BY at DESC'):
        key = conversation_key(row['mailbox'], row['conversation_id'])
        groups.setdefault(key, {'mailbox': row['mailbox'], 'conversationId': row['conversation_id'], 'messages': []})['messages'].append(unseal(row['sealed']))
    follows = {r['key']: dict(r) for r in db.execute('SELECT * FROM email_followups')}
    links = {r['key']: r['task_id'] for r in db.execute('SELECT * FROM email_task_links')}
    state = load_state(db)
    tasks = {t['id']: t for t in state.get('tasks', []) if isinstance(t, dict) and t.get('id')}
    deleted = set(state.get('deletedTaskIds') or [])
    result = []
    for key, group in groups.items():
        messages = group['messages']
        latest = messages[0]
        incoming = [m for m in messages if m['direction'] == 'incoming']
        outgoing = [m for m in messages if m['direction'] == 'outgoing']
        suggestion = 'awaiting_me' if latest['direction'] == 'incoming' else 'awaiting_them'
        follow = follows.get(key)
        status = follow['status'] if follow else 'review'
        if follow and status == 'done' and latest['direction'] == 'incoming' and latest['at'] > follow['updated_at']:
            status = 'review'
        task_id = links.get(key)
        task = tasks.get(task_id) if task_id not in deleted else None
        result.append({'key': key, 'mailbox': group['mailbox'], 'conversationId': group['conversationId'],
                       'subject': latest['subject'], 'sender': latest['from']['name'] or latest['from']['address'],
                       'lastAt': latest['at'], 'unread': sum(not m['isRead'] for m in incoming),
                       'incomingCount': len(incoming), 'outgoingCount': len(outgoing), 'latestDirection': latest['direction'],
                       'suggestion': suggestion, 'status': status, 'due': follow['due'] if follow else '',
                       'priority': follow['priority'] if follow else 'medium',
                       'task': {field: task.get(field) for field in ('id', 'title', 'status', 'due')} if task else None,
                       'taskDeleted': bool(task_id and not task)})
    return sorted(result, key=lambda row: row['lastAt'], reverse=True)


def options(db):
    sectors = [{'id': row['id'], 'name': row['name']} for row in db.execute('SELECT id,name FROM sectors ORDER BY name')]
    owners = []
    for row in db.execute('SELECT id,display_name,sector_id,role FROM users WHERE active=1 ORDER BY display_name'):
        sector_ids = [s['sector_id'] for s in db.execute('SELECT sector_id FROM user_sectors WHERE user_id=?', (row['id'],))]
        if row['sector_id'] and row['sector_id'] not in sector_ids:
            sector_ids.append(row['sector_id'])
        if row['role'] == 'admin':
            sector_ids = [s['id'] for s in sectors]
        owners.append({'id': row['id'], 'name': row['display_name'], 'sectorIds': sector_ids})
    return {'sectors': sectors, 'owners': owners}


def overview():
    for mailbox in MAILBOXES:
        start_sync(mailbox, force=False)
    with database() as db:
        config = setup(db)
        boxes = []
        with _guard:
            for address, label in MAILBOXES.items():
                row = db.execute('SELECT * FROM email_accounts WHERE address=?', (address,)).fetchone()
                saved = unseal(row['sealed']) if row else None
                boxes.append({'address': address, 'label': label, 'connected': bool(saved),
                              'account': saved['account'] if saved else '', 'lastSync': row['last_sync'] if row else '',
                              'error': row['error'] if row else '', 'running': bool(_jobs.get(address, {}).get('running'))})
        return {'setup': {**config, 'configured': bool(config.get('clientId'))}, 'mailboxes': boxes,
                'conversations': summarize(db), 'options': options(db)}


def find_thread(db, key):
    if not re.fullmatch(r'[0-9a-f]{64}', str(key or '')):
        raise EmailError('Conversa inválida.')
    conversation = next((item for item in summarize(db) if item['key'] == key), None)
    if not conversation:
        raise EmailError('Esta conversa não está mais na leitura atual da caixa.', 404)
    return conversation


def thread(key):
    with database() as db:
        conversation = find_thread(db, key)
        rows = db.execute('SELECT sealed FROM email_messages WHERE mailbox=? AND conversation_id=? ORDER BY at DESC LIMIT 51',
                          (conversation['mailbox'], conversation['conversationId'])).fetchall()
        return {'conversation': conversation, 'messages': [unseal(row['sealed']) for row in rows[:50]], 'limited': len(rows) > 50}


def message_body(key, message_id):
    with database() as db:
        conversation = find_thread(db, key)
        row = db.execute('SELECT sealed FROM email_messages WHERE mailbox=? AND conversation_id=? AND message_id=?',
                         (conversation['mailbox'], conversation['conversationId'], message_id)).fetchone()
        if not row:
            raise EmailError('Mensagem não encontrada nesta conversa.', 404)
    mailbox = conversation['mailbox']
    token, connection_id = access_token(mailbox)
    url = f'{GRAPH}/users/{quote(mailbox, safe="")}/messages/{quote(message_id, safe="")}?'
    result = graph_get(url + urlencode({'$select': 'id,body,webLink'}), token, mailbox)
    body = result.get('body')
    if not isinstance(body, dict) or str(body.get('contentType') or '').lower() != 'text':
        raise EmailError('O conteúdo não veio como texto seguro. Abra a mensagem no Outlook.', 502)
    with database() as db:
        current = account(db, mailbox)
        if not current or current['connectionId'] != connection_id:
            raise EmailError('A conexão desta caixa foi encerrada.', 409)
    return {'body': str(body.get('content') or '')[:100000], 'webLink': outlook_link(result.get('webLink'))}


def valid_due(value, required=False):
    raw = str(value or '')
    if not raw and not required:
        return ''
    try:
        if len(raw) != 10 or date.fromisoformat(raw).isoformat() != raw:
            raise ValueError()
    except ValueError as exc:
        raise EmailError('Informe um prazo válido para o acompanhamento.') from exc
    return raw


def followup(payload):
    status = payload.get('status')
    priority = payload.get('priority')
    if status not in STATUSES or priority not in PRIORITIES:
        raise EmailError('Selecione uma situação e uma prioridade válidas.')
    due = valid_due(payload.get('due'))
    with database() as db:
        conversation = find_thread(db, payload.get('key'))
        db.execute('INSERT INTO email_followups(key,status,due,priority,updated_at) VALUES(?,?,?,?,?) '
                   'ON CONFLICT(key) DO UPDATE SET status=excluded.status,due=excluded.due,priority=excluded.priority,updated_at=excluded.updated_at',
                   (conversation['key'], status, due, priority, stamp()))
    return {'ok': True}


def create_task(payload, user):
    title = str(payload.get('title') or '').strip()
    notes = str(payload.get('notes') or '').strip()
    due = valid_due(payload.get('due'), required=True)
    priority = payload.get('priority')
    if not title or len(title) > 200 or len(notes) > 4000 or priority not in PRIORITIES:
        raise EmailError('Revise título (até 200 caracteres), notas e prioridade da demanda.')
    with database() as db:
        db.execute('BEGIN IMMEDIATE')
        conversation = find_thread(db, payload.get('key'))
        key = conversation['key']
        rows = db.execute('SELECT fingerprint,sealed FROM email_messages WHERE mailbox=? AND conversation_id=?',
                          (conversation['mailbox'], conversation['conversationId'])).fetchall()
        fingerprints = {row['fingerprint'] for row in rows if row['fingerprint']}
        link = db.execute('SELECT task_id FROM email_task_links WHERE key=?', (key,)).fetchone()
        task_id = link['task_id'] if link else None
        if not task_id:
            for fp in fingerprints:
                match = db.execute('SELECT task_id FROM email_task_messages WHERE fingerprint=?', (fp,)).fetchone()
                if match:
                    task_id = match['task_id']
                    break
        state = load_state(db)
        if task_id:
            task = next((t for t in state.get('tasks', []) if t.get('id') == task_id), None)
            if not task or task_id in (state.get('deletedTaskIds') or []):
                raise EmailError('Esta conversa já gerou uma demanda que foi excluída. Nenhuma duplicata será criada.', 409)
            db.execute('INSERT OR IGNORE INTO email_task_links(key,task_id) VALUES(?,?)', (key, task_id))
            return {'task': task, 'created': False}
        sector_id, owner_id = str(payload.get('sectorId') or ''), str(payload.get('ownerId') or '')
        available = options(db)
        sector = next((s for s in available['sectors'] if s['id'] == sector_id), None)
        owner = next((o for o in available['owners'] if o['id'] == owner_id and sector_id in o['sectorIds']), None)
        if not sector or not owner:
            raise EmailError('Escolha um setor e um responsável ativo desse setor.')
        latest = max((unseal(r['sealed']) for r in rows), key=lambda m: m['at'])
        created_at = stamp()
        task_id = str(uuid.uuid4())
        task = {'id': task_id, 'title': title, 'sectorId': sector_id, 'owner': owner['name'],
                'category': sector['name'], 'priority': priority, 'status': 'todo', 'due': due,
                'periodStart': min(date.today().isoformat(), due), 'periodEnd': due, 'recurrence': 'none',
                'notes': notes, 'checklist': [], 'attachments': [], 'createdAt': created_at,
                'updatedAt': created_at, 'completedAt': None,
                'emailSource': {'key': key, 'mailbox': conversation['mailbox'], 'webLink': latest['webLink']}}
        state.setdefault('tasks', []).append(task)
        db.execute('INSERT INTO portal_state(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=CURRENT_TIMESTAMP',
                   (json.dumps(state, ensure_ascii=False),))
        db.execute('INSERT INTO email_task_links(key,task_id) VALUES(?,?)', (key, task_id))
        db.executemany('INSERT OR IGNORE INTO email_task_messages(fingerprint,task_id) VALUES(?,?)', [(fp, task_id) for fp in fingerprints])
        db.execute('INSERT INTO email_followups(key,status,due,priority,updated_at) VALUES(?,?,?,?,?) '
                   'ON CONFLICT(key) DO UPDATE SET due=excluded.due,priority=excluded.priority,updated_at=excluded.updated_at',
                   (key, 'awaiting_me', due, priority, created_at))
        return {'task': task, 'created': True}


def dispatch(method, action, query, payload, user):
    if method == 'GET':
        if action == '':
            return overview()
        if action == '/thread':
            return thread(query.get('key', [''])[0])
        if action == '/message':
            return message_body(query.get('key', [''])[0], query.get('id', [''])[0])
    if method == 'POST':
        if action == '/setup':
            return save_setup(payload)
        if action == '/connect':
            return start_connect(payload, user)
        if action == '/connect/check':
            return poll_connect(payload, user)
        if action == '/connect/cancel':
            return cancel_connect(payload, user)
        if action == '/disconnect':
            return disconnect(payload)
        if action == '/sync':
            return {'started': start_sync(payload.get('mailbox'))}
        if action == '/followup':
            return followup(payload)
        if action == '/task':
            return create_task(payload, user)
    raise EmailError('Ação da central de e-mails não encontrada.', 404)
