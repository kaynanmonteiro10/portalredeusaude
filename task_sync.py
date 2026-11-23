
import json
import math
from uuid import UUID, uuid4

MAX_OPERATIONS = 100
MAX_TASK_BYTES = 128 * 1024
MAX_PAYLOAD_BYTES = 2 * 1024 * 1024
MAX_STRING_BYTES = 64 * 1024
MAX_DEPTH = 20
MAX_JSON_NODES = 50000
MAX_ID_LENGTH = 200


def ensure_schema(db):
    """Create sync-owned tables only, without touching or committing state."""
    db.execute('''CREATE TABLE IF NOT EXISTS task_sync_receipts (
        user_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        operation_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, operation_id)
    )''')
    # Keep deletions even if a legacy state writer drops deletedTaskIds.
    db.execute('''CREATE TABLE IF NOT EXISTS task_sync_tombstones (
        task_id TEXT PRIMARY KEY NOT NULL
    )''')
    # One row per recurring occurrence: (series, day) can only exist once.
    # This is the database-level guard that stops two writers (the browser and
    # the server sweeper) from creating the same daily task twice.
    db.execute('''CREATE TABLE IF NOT EXISTS task_occurrences (
        series_key TEXT NOT NULL,
        due TEXT NOT NULL,
        task_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (series_key, due)
    )''')
    db.execute('CREATE INDEX IF NOT EXISTS task_occurrences_task ON task_occurrences(task_id)')


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'), allow_nan=False)


def _validate_json(value, depth=0, budget=None):
    if budget is None:
        budget = [MAX_JSON_NODES]
    budget[0] -= 1
    if depth > MAX_DEPTH or budget[0] < 0:
        raise ValueError('Task sync JSON is too complex.')
    kind = type(value)
    if kind is str:
        try:
            size = len(value.encode('utf-8'))
        except UnicodeEncodeError as exc:
            raise ValueError('Task sync strings must be valid Unicode.') from exc
        if size > MAX_STRING_BYTES:
            raise ValueError('Task sync string is too large.')
    elif kind is dict:
        if len(value) > 256:
            raise ValueError('Task sync object has too many fields.')
        for key, item in value.items():
            if type(key) is not str:
                raise ValueError('Task sync JSON keys must be strings.')
            _validate_json(key, depth + 1, budget)
            _validate_json(item, depth + 1, budget)
    elif kind is list:
        if len(value) > 2000:
            raise ValueError('Task sync array is too large.')
        for item in value:
            _validate_json(item, depth + 1, budget)
    elif kind is float:
        if not math.isfinite(value):
            raise ValueError('Task sync numbers must be finite.')
    elif kind is int:
        if abs(value) > 2**53 - 1:
            raise ValueError('Task sync integers must be JSON-safe.')
    elif value is not None and kind is not bool:
        raise ValueError('Task sync accepts JSON values only.')


def _identifier(value, label):
    if (type(value) is not str or not value or len(value) > MAX_ID_LENGTH
            or value != value.strip() or any(ord(char) < 32 for char in value)):
        raise ValueError(f'{label} must be a nonempty, bounded string.')
    return value


def _operation_id(value):
    if type(value) is not str or len(value) != 36:
        raise ValueError('Operation id must be a hyphenated UUID.')
    try:
        normalized = str(UUID(value))
    except ValueError as exc:
        raise ValueError('Operation id must be a hyphenated UUID.') from exc
    if value.lower() != normalized:
        raise ValueError('Operation id must be a hyphenated UUID.')
    return normalized


def _operations(payload):
    if type(payload) is not dict or set(payload) not in ({'operations'}, {'ops'}):
        raise ValueError('Provide an operations array (or ops), without extra fields.')
    operations = payload.get('operations', payload.get('ops'))
    if type(operations) is not list or len(operations) > MAX_OPERATIONS:
        raise ValueError('Task sync accepts at most 100 operations.')
    _validate_json(payload)
    if len(_canonical(payload).encode('utf-8')) > MAX_PAYLOAD_BYTES:
        raise ValueError('Task sync payload is too large.')
    validated = []
    seen = {}
    for operation in operations:
        if type(operation) is not dict or set(operation) != {'id', 'taskId', 'base', 'task'}:
            raise ValueError('Each operation needs only id, taskId, base and task.')
        operation_id = _operation_id(operation['id'])
        task_id = _identifier(operation['taskId'], 'taskId')
        for name in ('base', 'task'):
            task = operation[name]
            if task is None:
                continue
            if type(task) is not dict or task.get('id') != task_id:
                raise ValueError(f'{name} must be null or a task with the matching id.')
            sector = task.get('sectorId')
            if sector is not None and (type(sector) is not str or len(sector) > MAX_ID_LENGTH):
                raise ValueError('sectorId must be null or a bounded string.')
            if len(_canonical(task).encode('utf-8')) > MAX_TASK_BYTES:
                raise ValueError(f'{name} task is too large.')
        encoded = _canonical(operation)
        if operation_id in seen and seen[operation_id] != encoded:
            raise ValueError('Operation id was reused with a different payload.')
        seen[operation_id] = encoded
        # Detach all snapshots from the caller's mutable outbox.
        validated.append((operation_id, encoded, json.loads(encoded)))
    return validated


def _can_access(task, allowed, manager):
    sector = task.get('sectorId')
    return manager or (type(sector) is str and sector in allowed)


def _authorized(operation, current, allowed, manager, sectors):
    if current is not None and not _can_access(current, allowed, manager):
        return False
    desired = operation['task']
    if desired is not None:
        sector = desired.get('sectorId')
        valid_sector = (manager and sector in (None, '')) or sector in sectors
        return valid_sector and _can_access(desired, allowed, manager)
    if current is not None:
        return True
    # An absent/deleted task has no current sector to authorize against.
    base = operation['base']
    return manager or (base is not None and _can_access(base, allowed, manager))


def occurrence_key(task):
    """Stable key for one recurring series: recurrence + owner + normalized title.

    Mirrors taskSeriesKey() in app.js and task_series_key() in portal_server.py,
    so the browser, the sweeper and this guard all name a series the same way.
    """
    if type(task) is not dict:
        return None
    recurrence = str(task.get('recurrence') or '')
    if recurrence in ('', 'none'):
        return None
    title = ' '.join(str(task.get('title') or '').lower().split())
    owner = ' '.join(str(task.get('owner') or '').lower().split())
    if not title:
        return None
    return '%s|%s|%s' % (recurrence, owner, title)


def _due_of(task):
    due = str(task.get('due') or task.get('periodEnd') or '')[:10]
    return due if len(due) == 10 else None


def _register_occurrences(db, tasks):
    """Backfill the guard from the state we just loaded.

    A row is only taken when the (series, day) pair is still free, so the
    earliest writer keeps the slot and any duplicate already in the data is
    left alone here (cleanup is a separate, deliberate step).
    """
    for task in tasks.values():
        key = occurrence_key(task)
        due = _due_of(task)
        if not key or not due:
            continue
        db.execute(
            'INSERT OR IGNORE INTO task_occurrences (series_key, due, task_id) VALUES (?, ?, ?)',
            (key, due, str(task.get('id') or '')),
        )


def _claim_occurrence(db, task):
    """Take the (series, day) slot for a task the caller is about to create.

    Returns True when this caller owns the slot. False means another writer
    already created that occurrence, so the caller must not add a second one.
    """
    key = occurrence_key(task)
    due = _due_of(task)
    if not key or not due:
        return True
    cursor = db.execute(
        'INSERT OR IGNORE INTO task_occurrences (series_key, due, task_id) VALUES (?, ?, ?)',
        (key, due, str(task.get('id') or '')),
    )
    if cursor.rowcount == 1:
        return True
    owner = db.execute(
        'SELECT task_id FROM task_occurrences WHERE series_key = ? AND due = ?', (key, due),
    ).fetchone()
    return bool(owner and owner[0] == str(task.get('id') or ''))


def _release_occurrence(db, task):
    key = occurrence_key(task)
    due = _due_of(task)
    if not key or not due:
        return
    db.execute(
        'DELETE FROM task_occurrences WHERE series_key = ? AND due = ? AND task_id = ?',
        (key, due, str(task.get('id') or '')),
    )


def find_duplicate(tasks, candidate, exclude_id=None):
    """Find a task that already covers the same title on the same day for the same owner.

    Used to warn before a manual entry is saved, so a hand-typed task does not
    land on top of one the recurring series already created for that day.
    """
    if type(candidate) is not dict:
        return None
    title = ' '.join(str(candidate.get('title') or '').lower().split())
    owner = ' '.join(str(candidate.get('owner') or '').lower().split())
    due = _due_of(candidate)
    if not title or not due:
        return None
    for task in tasks:
        if type(task) is not dict:
            continue
        if exclude_id and str(task.get('id')) == str(exclude_id):
            continue
        if ' '.join(str(task.get('title') or '').lower().split()) != title:
            continue
        if ' '.join(str(task.get('owner') or '').lower().split()) != owner:
            continue
        if _due_of(task) != due:
            continue
        return task
    return None


def _occurrence_twin(db, tasks, desired):
    """Return the task that already owns this (series, day) slot, if any."""
    key = occurrence_key(desired)
    due = _due_of(desired)
    if not key or not due:
        return None
    row = db.execute(
        'SELECT task_id FROM task_occurrences WHERE series_key = ? AND due = ?', (key, due),
    ).fetchone()
    if row and row[0] in tasks:
        return tasks[row[0]]
    return None


def _load_state(db):
    row = db.execute('SELECT data FROM portal_state WHERE id = 1').fetchone()
    state = json.loads(row[0]) if row else {}
    if type(state) is not dict:
        raise ValueError('Stored portal state must be a JSON object.')
    tasks = state.get('tasks')
    deleted = state.get('deletedTaskIds')
    tasks = [] if tasks is None else tasks
    deleted = [] if deleted is None else deleted
    if type(tasks) is not list or type(deleted) is not list:
        raise ValueError('Stored tasks and tombstones must be arrays.')
    by_id = {}
    for task in tasks:
        if type(task) is not dict:
            raise ValueError('Stored tasks must be objects.')
        task_id = _identifier(task.get('id'), 'Stored task id')
        if task_id in by_id:
            raise ValueError('Stored task IDs must be unique.')
        by_id[task_id] = task
    tombstones = {_identifier(item, 'Stored tombstone id') for item in deleted}
    tombstones.update(row[0] for row in db.execute('SELECT task_id FROM task_sync_tombstones'))
    return state, by_id, tombstones


def sync(db, payload, user, sector_ids, manager):
    # The caller must acquire BEGIN IMMEDIATE before reading any task state.
    operations = _operations(payload)
    try:
        user_id = _identifier(user['id'], 'Authenticated user id')
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError('An authenticated user is required.') from exc
    if type(manager) is not bool:
        raise ValueError('manager must be a server-provided boolean.')
    if sector_ids is None and manager:
        sector_ids = ()
    if not isinstance(sector_ids, (list, tuple, set, frozenset)):
        raise ValueError('sector_ids must be a server-provided collection.')
    allowed = {_identifier(sector, 'Authorized sector id') for sector in sector_ids}
    if not db.in_transaction:
        raise ValueError('sync requires the parent BEGIN IMMEDIATE transaction.')

    savepoint = 'task_sync_' + uuid4().hex
    db.execute(f'SAVEPOINT {savepoint}')
    try:
        # Reject receipt reuse before any state mutation, even late in a batch.
        receipts = {}
        for operation_id, encoded, _operation in operations:
            receipt = db.execute(
                'SELECT operation_json, result_json FROM task_sync_receipts '
                'WHERE user_id = ? AND operation_id = ?', (user_id, operation_id),
            ).fetchone()
            if receipt is not None:
                if receipt[0] != encoded:
                    raise ValueError('Operation id was reused with a different payload.')
                receipts[operation_id] = receipt[1]

        state, tasks, tombstones = _load_state(db)
        _register_occurrences(db, tasks)
        sectors = {row[0] for row in db.execute('SELECT id FROM sectors')}
        original_json = _canonical(state)
        # A tombstone is authoritative even over inconsistent legacy state.
        for task_id in tombstones:
            tasks.pop(task_id, None)
        results = []
        for operation_id, encoded, operation in operations:
            task_id = operation['taskId']
            current = tasks.get(task_id)
            permitted = _authorized(operation, current, allowed, manager, sectors)
            if operation_id in receipts:
                result = json.loads(receipts[operation_id])
                snapshot = result.get('current')
                if not permitted or (snapshot is not None and not _can_access(snapshot, allowed, manager)):
                    result = {'id': operation['id'], 'status': 'forbidden'}
            else:
                desired = operation['task']
                deleted = task_id in tombstones
                if not permitted:
                    result = {'id': operation['id'], 'status': 'forbidden'}
                elif deleted and desired is not None:
                    result = {'id': operation['id'], 'status': 'conflict',
                              'current': None, 'deleted': True, 'operation': operation}
                elif (_canonical(current) == _canonical(desired)
                      or _canonical(current) == _canonical(operation['base'])):
                    if desired is None:
                        if current is not None:
                            tombstones.add(task_id)
                            _release_occurrence(db, current)
                        tasks.pop(task_id, None)
                        result = {'id': operation['id'], 'status': 'applied',
                                  'current': None, 'deleted': task_id in tombstones}
                    elif current is None and not _claim_occurrence(db, desired):
                        # Another writer already created this series for that day.
                        twin = _occurrence_twin(db, tasks, desired)
                        result = {'id': operation['id'], 'status': 'duplicate',
                                  'current': twin, 'duplicate': True}
                    else:
                        tasks[task_id] = desired
                        result = {'id': operation['id'], 'status': 'applied',
                                  'current': desired, 'deleted': task_id in tombstones}
                else:
                    result = {'id': operation['id'], 'status': 'conflict',
                              'current': current, 'deleted': deleted, 'operation': operation}
                result_json = _canonical(result)
                db.execute(
                    'INSERT INTO task_sync_receipts '
                    '(user_id, operation_id, operation_json, result_json) VALUES (?, ?, ?, ?)',
                    (user_id, operation_id, encoded, result_json),
                )
                receipts[operation_id] = result_json
            results.append(result)

        db.executemany('INSERT OR IGNORE INTO task_sync_tombstones(task_id) VALUES (?)',
                       ((task_id,) for task_id in sorted(tombstones)))
        state['tasks'] = list(tasks.values())
        state['deletedTaskIds'] = sorted(tombstones)
        state_json = _canonical(state)
        if state_json != original_json:
            db.execute(
                'INSERT INTO portal_state(id, data) VALUES(1, ?) '
                'ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP',
                (state_json,),
            )
        response = {'results': results, 'state': state}
        db.execute(f'RELEASE SAVEPOINT {savepoint}')
        return response
    except BaseException:
        db.execute(f'ROLLBACK TO SAVEPOINT {savepoint}')
        db.execute(f'RELEASE SAVEPOINT {savepoint}')
        raise
