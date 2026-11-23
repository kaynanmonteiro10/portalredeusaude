"""Isolated task-sync tests: only named in-memory SQLite databases, no portal import."""

import copy
import json
import sqlite3
import unittest
from contextlib import closing
from uuid import uuid4

import task_sync


def task(task_id=None, sector='sales', **fields):
    item = {'id': task_id or str(uuid4()), 'sectorId': sector, 'title': 'Original',
            'updatedAt': '2026-11-11T10:00:00Z',
            'checklist': [{'id': 'check-1', 'text': 'Review', 'done': False}]}
    item.update(fields)
    return item


def operation(base, desired, task_id=None, operation_id=None):
    source = desired if desired is not None else base
    return {'id': operation_id or str(uuid4()),
            'taskId': task_id or source['id'],
            'base': copy.deepcopy(base), 'task': copy.deepcopy(desired)}


class TaskSyncTests(unittest.TestCase):
    def setUp(self):
        self.uri = f'file:task-sync-{uuid4().hex}?mode=memory&cache=shared'
        self.db = self.connect()
        self.db.execute('''CREATE TABLE portal_state (
            id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )''')
        self.db.execute('CREATE TABLE sectors(id TEXT PRIMARY KEY)')
        self.db.executemany('INSERT INTO sectors VALUES (?)', [('sales',), ('finance',)])
        self.db.execute('CREATE TABLE parent_markers(value TEXT)')
        task_sync.ensure_schema(self.db)
        self.db.commit()
        self.user = {'id': 'user-one', 'role': 'user', 'sector_id': 'sales'}
        self.unrelated = {'billingHistory': [{'company': 'Keep'}],
                          'learningData': {'custom': [1, None, True]},
                          'mergeRows': [{'EMPRESA': 'Keep'}], 'extension': {'opaque': 17}}
        self.seed([], [])

    def tearDown(self):
        self.db.close()

    def connect(self):
        db = sqlite3.connect(self.uri, uri=True, timeout=0)
        db.row_factory = sqlite3.Row
        return db

    def seed(self, tasks, tombstones=()):
        state = {**copy.deepcopy(self.unrelated), 'tasks': copy.deepcopy(tasks),
                 'deletedTaskIds': list(tombstones)}
        self.db.execute('INSERT INTO portal_state(id, data) VALUES(1, ?) '
                        'ON CONFLICT(id) DO UPDATE SET data=excluded.data', (json.dumps(state),))
        self.db.commit()
        return state

    def state(self, db=None):
        db = db if db is not None else self.db
        return json.loads(db.execute('SELECT data FROM portal_state WHERE id=1').fetchone()[0])

    def count(self, table):
        self.assertIn(table, ('task_sync_receipts', 'task_sync_tombstones', 'parent_markers'))
        return self.db.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]

    def apply(self, operations, user=None, sectors=('sales',), manager=False, db=None):
        db = db if db is not None else self.db
        db.execute('BEGIN IMMEDIATE')
        try:
            result = task_sync.sync(db, {'operations': operations}, user or self.user,
                                    sectors, manager)
            self.assertTrue(db.in_transaction, 'sync must not commit the parent transaction')
            db.commit()
            return result
        except BaseException:
            db.rollback()
            raise

    def assert_forbidden(self, response, op):
        self.assertEqual(response['results'], [{'id': op['id'], 'status': 'forbidden'}])

    def test_schema_idempotent_and_no_implicit_commit(self):
        self.db.execute('BEGIN IMMEDIATE')
        self.db.execute("INSERT INTO parent_markers VALUES ('parent')")
        task_sync.ensure_schema(self.db)
        task_sync.ensure_schema(self.db)
        self.assertTrue(self.db.in_transaction)
        self.db.rollback()
        self.assertEqual(self.count('parent_markers'), 0)

    def test_create_edit_delete_preserve_unrelated_state_and_input(self):
        created = task('legacy-task-id', notes='Offline notes', extra={'all': ['fields', None]})
        create = operation(None, created)
        original = copy.deepcopy(create)
        response = self.apply([create])
        self.assertEqual(response['results'][0], {'id': create['id'], 'status': 'applied',
                                                'current': created, 'deleted': False})
        self.assertEqual(create, original)
        edited = {**created, 'title': 'Edited', 'newField': {'custom': True}}
        edit = operation(created, edited)
        response = self.apply([edit])
        self.assertEqual(response['state']['tasks'], [edited])
        delete = operation(edited, None)
        response = self.apply([delete])
        self.assertEqual(response['results'][0], {'id': delete['id'], 'status': 'applied',
                                                'current': None, 'deleted': True})
        self.assertEqual(response['state']['tasks'], [])
        self.assertEqual(response['state']['deletedTaskIds'], [created['id']])
        for key, value in self.unrelated.items():
            self.assertEqual(response['state'][key], value)
        self.assertEqual(self.count('task_sync_receipts'), 3)
        self.assertEqual(self.count('task_sync_tombstones'), 1)

    def test_uncontested_edit_accepts_older_clock(self):
        original = task()
        self.seed([original])
        desired = {**original, 'title': 'Correct edit', 'updatedAt': '1900-01-01'}
        result = self.apply([operation(original, desired)])
        self.assertEqual(result['results'][0]['status'], 'applied')
        self.assertEqual(self.state()['tasks'], [desired])

    def test_two_clients_stale_edit_no_lost_changes_despite_clock_skew(self):
        original = task()
        self.seed([original])
        with closing(self.connect()) as peer:
            second_base = self.state(peer)['tasks'][0]
            winner = {**original, 'title': 'Winner', 'updatedAt': '1900-01-01'}
            self.apply([operation(original, winner)])
            loser = {**second_base, 'title': 'Pending', 'updatedAt': '9999-12-31'}
            pending = operation(second_base, loser)
            result = self.apply([pending], db=peer)
            self.assertEqual(result['results'][0], {'id': pending['id'], 'status': 'conflict',
                                                  'current': winner, 'deleted': False,
                                                  'operation': pending})
            self.assertEqual(result['state']['tasks'], [winner])

    def test_parent_write_lock_serializes_clients(self):
        peer = self.connect()
        try:
            self.db.execute('BEGIN IMMEDIATE')
            with self.assertRaises(sqlite3.OperationalError):
                peer.execute('BEGIN IMMEDIATE')
            self.db.rollback()
            peer.execute('BEGIN IMMEDIATE')
            result = task_sync.sync(peer, {'ops': []}, self.user, ['sales'], False)
            self.assertEqual(result['results'], [])
            peer.rollback()
        finally:
            self.db.rollback()
            peer.close()

    def test_all_fields_nested_changes_and_missing_null_are_versions(self):
        base = task()
        variants = []
        nested = copy.deepcopy(base)
        nested['checklist'][0]['done'] = True
        variants.append(nested)
        variants.append({**base, 'unknownField': None})
        variants.append({**base, 'updatedAt': 'different'})
        variants.append({**base, 'checklist': []})
        variants.append({**base, 'checklist': [{'done': 0, 'id': 'check-1', 'text': 'Review'}]})
        for current in variants:
            with self.subTest(current=current):
                self.seed([current])
                pending = operation(base, {**base, 'title': 'Pending'})
                result = self.apply([pending])['results'][0]
                self.assertEqual(result['status'], 'conflict')
                self.assertEqual(result['current'], current)
                self.assertEqual(result['operation'], pending)
                self.assertEqual(self.state()['tasks'], [current])

    def test_canonical_object_key_order_does_not_conflict(self):
        base = task(metadata={'a': 1, 'b': {'x': False, 'y': None}})
        self.seed([base])
        reordered = dict(reversed(list(base.items())))
        reordered['metadata'] = {'b': {'y': None, 'x': False}, 'a': 1}
        desired = {**base, 'title': 'Changed'}
        result = self.apply([operation(reordered, desired)])
        self.assertEqual(result['results'][0]['status'], 'applied')

    def test_array_order_is_part_of_version(self):
        base = task(custom=['a', 'b'])
        current = {**base, 'custom': ['b', 'a']}
        self.seed([current])
        result = self.apply([operation(base, {**base, 'title': 'Pending'})])
        self.assertEqual(result['results'][0]['status'], 'conflict')

    def test_semantic_noop_acknowledges_stale_base_without_rewriting(self):
        base = task()
        current = {**base, 'title': 'Already desired', 'updatedAt': 'old'}
        self.seed([current])
        before = self.db.execute('SELECT data FROM portal_state').fetchone()[0]
        result = self.apply([operation(base, current)])
        self.assertEqual(result['results'][0]['status'], 'applied')
        # The first call can canonicalize state, but subsequent no-ops do not write it.
        canonical = self.db.execute('SELECT data FROM portal_state').fetchone()[0]
        self.assertEqual(json.loads(before), json.loads(canonical))
        self.db.execute("CREATE TRIGGER no_state_update BEFORE UPDATE ON portal_state "
                        "BEGIN SELECT RAISE(ABORT, 'unexpected rewrite'); END")
        self.apply([operation(base, current)])
        self.assertEqual(self.db.execute('SELECT data FROM portal_state').fetchone()[0], canonical)

    def test_create_collision_conflicts_but_identical_create_is_noop(self):
        current = task()
        self.seed([current])
        pending = operation(None, {**current, 'title': 'Collision'})
        result = self.apply([pending])
        self.assertEqual(result['results'][0]['status'], 'conflict')
        self.assertEqual(result['results'][0]['operation'], pending)
        result = self.apply([operation(None, current)])
        self.assertEqual(result['results'][0]['status'], 'applied')
        self.assertEqual(self.state()['tasks'], [current])

    def test_concurrent_stale_delete_preserves_newer_edit(self):
        base = task()
        self.seed([base])
        current = {**base, 'notes': 'Another client added this'}
        self.apply([operation(base, current)])
        pending = operation(base, None)
        result = self.apply([pending])['results'][0]
        self.assertEqual(result, {'id': pending['id'], 'status': 'conflict',
                                  'current': current, 'deleted': False, 'operation': pending})
        self.assertEqual(self.state()['tasks'], [current])
        self.assertEqual(self.count('task_sync_tombstones'), 0)

    def test_delete_wins_against_stale_edit_and_uuid_never_resurrects(self):
        base = task()
        self.seed([base])
        with closing(self.connect()) as peer:
            stale = self.state(peer)['tasks'][0]
            delete = operation(base, None)
            self.apply([delete])
            pending = operation(stale, {**stale, 'title': 'Offline edit', 'updatedAt': '9999'})
            result = self.apply([pending], db=peer)['results'][0]
            self.assertEqual(result, {'id': pending['id'], 'status': 'conflict',
                                      'current': None, 'deleted': True, 'operation': pending})
        for manager in (False, True):
            with self.subTest(manager=manager):
                recreate = operation(None, base)
                result = self.apply([recreate], manager=manager)['results'][0]
                self.assertEqual(result['status'], 'conflict')
                self.assertTrue(result['deleted'])
                self.assertEqual(self.state()['tasks'], [])
        retry_delete = self.apply([operation(base, None)])['results'][0]
        self.assertEqual(retry_delete['status'], 'applied')
        self.assertTrue(retry_delete['deleted'])
        self.assertEqual(self.apply([delete])['results'][0]['status'], 'applied')

    def test_missing_stale_edit_conflicts_and_absent_delete_does_not_poison_uuid(self):
        base = task()
        pending = operation(base, {**base, 'title': 'Stale edit'})
        result = self.apply([pending])['results'][0]
        self.assertEqual(result['status'], 'conflict')
        self.assertIsNone(result['current'])
        self.assertFalse(result['deleted'])
        result = self.apply([operation(base, None)])['results'][0]
        self.assertEqual(result['status'], 'applied')
        self.assertFalse(result['deleted'])
        self.assertEqual(self.count('task_sync_tombstones'), 0)
        self.assertEqual(self.apply([operation(None, base)])['results'][0]['status'], 'applied')

    def test_applied_replay_returns_same_receipt_plus_latest_state(self):
        first = task()
        create = operation(None, first)
        initial = self.apply([create])
        latest = {**first, 'title': 'Later edit'}
        self.apply([operation(first, latest)])
        replay = self.apply([copy.deepcopy(create)])
        self.assertEqual(replay['results'], initial['results'])
        self.assertEqual(replay['state']['tasks'], [latest])
        self.assertEqual(self.count('task_sync_receipts'), 2)

    def test_conflict_replay_preserves_original_pending_and_conflict_snapshot(self):
        base = task()
        current = {**base, 'title': 'Current'}
        self.seed([current])
        pending = operation(base, {**base, 'title': 'Offline draft'})
        first = self.apply([pending])
        latest = {**current, 'title': 'Even newer'}
        self.apply([operation(current, latest)])
        replay = self.apply([pending])
        self.assertEqual(replay['results'], first['results'])
        self.assertEqual(replay['results'][0]['operation'], pending)
        self.assertEqual(replay['state']['tasks'], [latest])

    def test_receipts_survive_connection_replacement_not_process_cache(self):
        create = operation(None, task())
        initial = self.apply([create])
        keeper = self.connect()
        try:
            self.db.close()
            self.db = self.connect()
            self.assertEqual(self.apply([create])['results'], initial['results'])
            self.assertEqual(self.count('task_sync_receipts'), 1)
        finally:
            keeper.close()

    def test_same_batch_duplicate_replays_once(self):
        create = operation(None, task())
        response = self.apply([create, copy.deepcopy(create)])
        self.assertEqual(response['results'][0], response['results'][1])
        self.assertEqual(self.count('task_sync_receipts'), 1)
        self.assertEqual(len(response['state']['tasks']), 1)

    def test_receipts_are_scoped_per_user(self):
        first = task()
        create = operation(None, first)
        self.apply([create])
        different = operation(first, {**first, 'title': 'User two'}, operation_id=create['id'])
        response = self.apply([different], user={'id': 'user-two'})
        self.assertEqual(response['results'][0]['status'], 'applied')
        self.assertEqual(self.count('task_sync_receipts'), 2)

    def test_persisted_receipt_payload_reuse_rejected_atomically(self):
        create = operation(None, task())
        self.apply([create])
        reused = copy.deepcopy(create)
        reused['task']['checklist'][0]['done'] = True
        innocent = operation(None, task())
        before = self.state()
        with self.assertRaises(ValueError):
            self.apply([innocent, reused])
        self.assertEqual(self.state(), before)
        self.assertEqual(self.count('task_sync_receipts'), 1)

    def test_same_batch_differing_reuse_rejected_before_writes(self):
        create = operation(None, task())
        reused = copy.deepcopy(create)
        reused['task']['title'] = 'Changed'
        with self.assertRaises(ValueError):
            self.apply([create, reused])
        self.assertEqual(self.state()['tasks'], [])
        self.assertEqual(self.count('task_sync_receipts'), 0)

    def test_operation_uuid_case_cannot_bypass_receipt_key(self):
        create = operation(None, task())
        self.apply([create])
        reused = copy.deepcopy(create)
        reused['id'] = reused['id'].upper()
        reused['task']['title'] = 'Changed'
        with self.assertRaises(ValueError):
            self.apply([reused])
        self.assertEqual(self.count('task_sync_receipts'), 1)

    def test_forged_existing_sector_cannot_overwrite_or_disclose_hidden_task(self):
        hidden = task(sector='finance', title='Secret')
        self.seed([hidden])
        forged_base = {**hidden, 'sectorId': 'sales', 'title': 'Guess'}
        pending = operation(forged_base, {**forged_base, 'title': 'Attack'})
        initial = self.apply([pending])
        self.assert_forbidden(initial, pending)
        self.assertEqual(self.state()['tasks'], [hidden])
        self.assert_forbidden(self.apply([pending]), pending)
        # The parent is responsible for filtering the raw state, not per-op results.
        self.assertEqual(initial['state']['tasks'], [hidden])

    def test_desired_sector_must_be_authorized_create_and_move(self):
        original = task()
        self.seed([original])
        move = operation(original, {**original, 'sectorId': 'finance'})
        self.assert_forbidden(self.apply([move]), move)
        create = operation(None, task(sector='finance'))
        self.assert_forbidden(self.apply([create]), create)
        self.assertEqual(self.state()['tasks'], [original])

    def test_inaccessible_delete_is_detail_free_forbidden(self):
        hidden = task(sector='finance', title='Secret')
        self.seed([hidden])
        delete = operation({**hidden, 'sectorId': 'sales'}, None)
        self.assert_forbidden(self.apply([delete]), delete)
        self.assertEqual(self.state()['tasks'], [hidden])
        self.assertEqual(self.count('task_sync_tombstones'), 0)

    def test_unassigned_existing_task_not_claimable_by_ordinary_user(self):
        unassigned = task(sector=None)
        self.seed([unassigned])
        pending = operation({**unassigned, 'sectorId': 'sales'},
                            {**unassigned, 'sectorId': 'sales', 'title': 'Claim'})
        self.assert_forbidden(self.apply([pending]), pending)
        create = operation(None, task(sector=None))
        self.assert_forbidden(self.apply([create]), create)

    def test_manager_can_move_sectors_and_edit_unassigned_but_not_forge_sectors(self):
        original = task(sector='finance')
        self.seed([original])
        moved = {**original, 'sectorId': 'sales'}
        result = self.apply([operation(original, moved)], sectors=(), manager=True)
        self.assertEqual(result['results'][0]['status'], 'applied')
        unassigned = {**moved, 'sectorId': None}
        result = self.apply([operation(moved, unassigned)], sectors=None, manager=True)
        self.assertEqual(result['results'][0]['status'], 'applied')
        unknown = operation(unassigned, {**unassigned, 'sectorId': 'nonexistent'})
        self.assert_forbidden(self.apply([unknown], manager=True), unknown)
        self.assertEqual(self.state()['tasks'], [unassigned])

    def test_unknown_sector_rejected_for_ordinary_user_even_in_supplied_scope(self):
        forged = operation(None, task(sector='nonexistent'))
        self.assert_forbidden(self.apply([forged], sectors=('nonexistent',)), forged)

    def test_forbidden_receipt_does_not_become_applied_after_scope_grant(self):
        pending = operation(None, task(sector='finance'))
        first = self.apply([pending])
        self.assert_forbidden(first, pending)
        self.assertEqual(self.apply([pending], sectors=('finance',))['results'], first['results'])
        self.assertEqual(self.state()['tasks'], [])

    def test_replay_cannot_disclose_after_current_task_moves_out_of_scope(self):
        created = task()
        create = operation(None, created)
        self.apply([create])
        moved = {**created, 'sectorId': 'finance', 'title': 'Now private'}
        self.apply([operation(created, moved)], manager=True)
        self.assert_forbidden(self.apply([create]), create)
        self.assertEqual(self.count('task_sync_receipts'), 2)

    def test_replay_cannot_disclose_recorded_conflict_snapshot_after_revocation(self):
        base = task(sector='finance')
        current = {**base, 'title': 'Private conflict'}
        self.seed([current])
        pending = operation(base, {**base, 'sectorId': 'sales', 'title': 'Pending'})
        first = self.apply([pending], sectors=('sales', 'finance'))
        self.assertEqual(first['results'][0]['status'], 'conflict')
        moved = {**current, 'sectorId': 'sales'}
        self.apply([operation(current, moved)], manager=True)
        self.assert_forbidden(self.apply([pending]), pending)

    def test_global_tombstones_preserved_across_sectors(self):
        original = task()
        foreign = task(sector='finance')
        foreign_deleted = str(uuid4())
        historical_deleted = str(uuid4())
        self.seed([original, foreign], [foreign_deleted, historical_deleted])
        result = self.apply([operation(original, None)])
        expected = sorted([original['id'], foreign_deleted, historical_deleted])
        self.assertEqual(result['state']['deletedTaskIds'], expected)
        self.assertEqual(result['state']['tasks'], [foreign])
        self.assertEqual(self.count('task_sync_tombstones'), 3)
        self.assertEqual(self.apply([])['state']['deletedTaskIds'], expected)

    def test_durable_tombstones_restore_legacy_drops_and_remove_resurrection(self):
        original = task(sector='finance')
        self.seed([original])
        self.apply([operation(original, None)], manager=True)
        # Simulate a legacy writer losing the global tombstone and reintroducing a task.
        self.seed([original], [])
        result = self.apply([])
        self.assertEqual(result['state']['tasks'], [])
        self.assertEqual(result['state']['deletedTaskIds'], [original['id']])
        pending = operation(None, {**original, 'sectorId': 'sales'})
        result = self.apply([pending])['results'][0]
        self.assertEqual(result['status'], 'conflict')
        self.assertIsNone(result['current'])
        self.assertTrue(result['deleted'])

    def test_parent_rollback_undoes_state_receipts_and_tombstones(self):
        original = task()
        before = self.seed([original])
        delete = operation(original, None)
        self.db.execute('BEGIN IMMEDIATE')
        result = task_sync.sync(self.db, {'operations': [delete]}, self.user, ['sales'], False)
        self.assertEqual(result['results'][0]['status'], 'applied')
        self.assertEqual(self.count('task_sync_receipts'), 1)
        self.assertEqual(self.count('task_sync_tombstones'), 1)
        self.assertTrue(self.db.in_transaction)
        self.db.rollback()
        self.assertEqual(self.state(), before)
        self.assertEqual(self.count('task_sync_receipts'), 0)
        self.assertEqual(self.count('task_sync_tombstones'), 0)
        self.assertEqual(self.apply([delete])['results'][0]['status'], 'applied')

    def test_state_write_failure_rolls_back_batch_but_not_parent_work(self):
        original = task()
        before = self.seed([original])
        self.db.execute("CREATE TRIGGER fail_state BEFORE UPDATE ON portal_state "
                        "BEGIN SELECT RAISE(ABORT, 'test write failure'); END")
        self.db.execute('BEGIN IMMEDIATE')
        self.db.execute("INSERT INTO parent_markers VALUES ('keep until parent rollback')")
        with self.assertRaises(sqlite3.IntegrityError):
            task_sync.sync(self.db, {'operations': [operation(original, None)]},
                           self.user, ['sales'], False)
        self.assertTrue(self.db.in_transaction)
        self.assertEqual(self.state(), before)
        self.assertEqual(self.count('task_sync_receipts'), 0)
        self.assertEqual(self.count('task_sync_tombstones'), 0)
        self.assertEqual(self.count('parent_markers'), 1)
        self.db.rollback()
        self.assertEqual(self.count('parent_markers'), 0)

    def test_mid_batch_receipt_failure_is_atomic(self):
        first = operation(None, task())
        second = operation(None, task())
        self.db.execute(f"CREATE TRIGGER fail_receipt BEFORE INSERT ON task_sync_receipts "
                        f"WHEN NEW.operation_id = '{second['id']}' "
                        "BEGIN SELECT RAISE(ABORT, 'test receipt failure'); END")
        self.db.execute('BEGIN IMMEDIATE')
        with self.assertRaises(sqlite3.IntegrityError):
            task_sync.sync(self.db, {'operations': [first, second]}, self.user, ['sales'], False)
        self.assertEqual(self.count('task_sync_receipts'), 0)
        self.assertEqual(self.state()['tasks'], [])
        self.assertTrue(self.db.in_transaction)
        self.db.rollback()

    def test_boundary_payload_shapes_and_operation_types_rejected_without_writes(self):
        valid = operation(None, task())
        invalid = [None, [], {}, {'operations': None}, {'operations': {}},
                   {'operations': [], 'tasks': []}, {'operations': [], 'ops': []},
                   {'operations': [None]}, {'operations': [True]},
                   {'operations': [{**valid, 'id': 'not-a-uuid'}]},
                   {'operations': [{**valid, 'id': str(uuid4()).replace('-', '')}]},
                   {'operations': [{**valid, 'id': 1}]},
                   {'operations': [{**valid, 'taskId': 1}]},
                   {'operations': [{**valid, 'taskId': ''}]},
                   {'operations': [{**valid, 'taskId': 'x' * 201}]},
                   {'operations': [{**valid, 'taskId': ' leading'}]},
                   {'operations': [{**valid, 'taskId': 'bad\nvalue'}]},
                   {'operations': [{**valid, 'base': []}]},
                   {'operations': [{**valid, 'task': True}]},
                   {'operations': [{**valid, 'task': {**valid['task'], 'id': 'different'}}]},
                   {'operations': [{**valid, 'task': {**valid['task'], 'sectorId': ['sales']}}]},
                   {'operations': [{**valid, 'task': {**valid['task'], 'sectorId': 1}}]},
                   {'operations': [{**valid, 'task': {**valid['task'], 'sectorId': 'x' * 201}}]},
                   {'operations': [{**valid, 'extra': 'not ignored'}]},
                   {'operations': [{key: value for key, value in valid.items() if key != 'base'}]}]
        before = self.state()
        for payload in invalid:
            with self.subTest(payload=payload):
                self.db.execute('BEGIN IMMEDIATE')
                with self.assertRaises(ValueError):
                    task_sync.sync(self.db, payload, self.user, ['sales'], False)
                self.assertEqual(self.count('task_sync_receipts'), 0)
                self.assertEqual(self.state(), before)
                self.db.rollback()

    def test_boundary_json_values_depth_nodes_and_sizes(self):
        nested = None
        for _ in range(task_sync.MAX_DEPTH + 1):
            nested = [nested]
        fields = [float('nan'), float('inf'), -float('inf'), 2**53,
                  {'not-json'}, ('tuple',), {1: 'non-string key'}, '\ud800',
                  nested, 'x' * (task_sync.MAX_STRING_BYTES + 1),
                  {'a': 'x' * 50000, 'b': 'x' * 50000, 'c': 'x' * 50000},
                  list(range(2001)), {str(i): i for i in range(257)},
                  [[None] * 1000 for _ in range(60)]]
        for value in fields:
            with self.subTest(value_type=type(value).__name__):
                pending = operation(None, task(extra=value))
                with self.assertRaises(ValueError):
                    self.apply([pending])
                self.assertEqual(self.count('task_sync_receipts'), 0)
                self.assertEqual(self.state()['tasks'], [])

    def test_maximum_batch_and_total_payload_limits(self):
        hundred = [operation(None, task()) for _ in range(100)]
        result = self.apply(hundred)
        self.assertEqual(len(result['results']), 100)
        self.assertTrue(all(item['status'] == 'applied' for item in result['results']))
        with self.assertRaises(ValueError):
            self.apply(hundred + [operation(None, task())])
        oversized = [operation(None, task(a='x' * 50000, b='y' * 50000)) for _ in range(25)]
        with self.assertRaises(ValueError):
            self.apply(oversized)
        self.assertEqual(self.count('task_sync_receipts'), 100)

    def test_requires_authenticated_context_and_active_parent_transaction(self):
        create = operation(None, task())
        with self.assertRaises(ValueError):
            task_sync.sync(self.db, {'ops': [create]}, self.user, ['sales'], False)
        self.db.execute('BEGIN IMMEDIATE')
        for user, sectors, manager in [(None, ['sales'], False), ({}, ['sales'], False),
                                      ({'id': ''}, ['sales'], False),
                                      (self.user, 'sales', False),
                                      (self.user, [1], False), (self.user, [], 1)]:
            with self.subTest(user=user, sectors=sectors, manager=manager):
                with self.assertRaises(ValueError):
                    task_sync.sync(self.db, {'ops': [create]}, user, sectors, manager)
        self.db.rollback()
        self.assertEqual(self.count('task_sync_receipts'), 0)

    def test_unknown_null_delete_has_no_authorized_sector_and_no_tombstone(self):
        pending = operation(None, None, task_id=str(uuid4()))
        self.assert_forbidden(self.apply([pending]), pending)
        manager_pending = operation(None, None, task_id=str(uuid4()))
        result = self.apply([manager_pending], manager=True)['results'][0]
        self.assertEqual(result['status'], 'applied')
        self.assertFalse(result['deleted'])
        self.assertEqual(self.count('task_sync_tombstones'), 0)

    def test_missing_state_row_is_initialized_without_touching_other_tables(self):
        self.db.execute('DELETE FROM portal_state')
        self.db.commit()
        created = task()
        result = self.apply([operation(None, created)])
        self.assertEqual(result['state'], {'tasks': [created], 'deletedTaskIds': []})
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM sectors').fetchone()[0], 2)

    def test_invalid_stored_state_fails_closed_and_leaves_no_receipts(self):
        original = task()
        corrupt = [[], {'tasks': {}}, {'tasks': [None]}, {'tasks': [original, original]},
                   {'deletedTaskIds': {}}, {'deletedTaskIds': [1]}]
        for state in corrupt:
            with self.subTest(state=state):
                self.db.execute('UPDATE portal_state SET data=?', (json.dumps(state),))
                self.db.commit()
                with self.assertRaises(ValueError):
                    self.apply([operation(None, task())])
                self.assertEqual(self.count('task_sync_receipts'), 0)
                self.assertEqual(self.state(), state)


if __name__ == '__main__':
    unittest.main()
